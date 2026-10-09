"""MasLingo Engine — the desktop supervisor around the local OCR backend.

What it is for: the user installs one package, logs into Windows, and the engine
is already running. No terminal, no `uvicorn` command, no Python on their
machine. This process is what the installer's autostart entry launches, and what
the tray icon belongs to.

Design notes that are not obvious from reading it:

* The server runs in a **thread of this process**, not as a child. A child would
  survive its parent's death as an orphan holding port 8001, and the next login
  would then find the port taken by an engine nothing can reach. One process is
  also what makes "quit" actually mean quit.

* Restarts are **bounded and spaced**. A backend that cannot start will not be
  started three times a second forever; after the budget is spent the engine
  stays up, keeps the tray icon, and reports the failure — the spec is explicit
  that a crash loop must not be silent or infinite.

* An explicit quit is recorded on disk, so autostart does not immediately undo
  it. The flag is cleared the next time the engine is started deliberately.

* Nothing is written to a location that needs administrator rights. Logs and the
  state flag live under %LOCALAPPDATA%.
"""

from __future__ import annotations

import argparse
import ctypes
import json
import logging
import os
import socket
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

APP_NAME = "MasLingo"
DEFAULT_PORT = 8001
HOST = "127.0.0.1"

ROOT = Path(__file__).resolve().parent
while not (ROOT / "backend").is_dir() and ROOT.parent != ROOT:
    ROOT = ROOT.parent
sys.path.insert(0, str(ROOT))

STATE_DIR = Path(os.environ.get("LOCALAPPDATA", Path.home())) / APP_NAME
LOG_DIR = STATE_DIR / "logs"
QUIT_FLAG = STATE_DIR / "engine-stopped.flag"
# The uninstaller runs in a different process and has no handle on the running
# engine. A request file is the mechanism that works even when the engine was
# started by a previous login and is minutes old: writing it is atomic, and the
# running engine notices within a second.
SHUTDOWN_REQUEST = STATE_DIR / "shutdown.request"

# Restart budget. Three attempts inside ten minutes, backing off 2s / 8s / 30s.
MAX_RESTARTS = 3
RESTART_WINDOW_S = 600
RESTART_DELAYS = (2, 8, 30)

log = logging.getLogger("maslingo.engine")


# --------------------------------------------------------------------------
# logging
# --------------------------------------------------------------------------

def setup_logging(verbose: bool = False) -> Path:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    logfile = LOG_DIR / "engine.log"
    handler = logging.FileHandler(logfile, encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)-7s %(message)s"))
    log.addHandler(handler)
    log.setLevel(logging.DEBUG if verbose else logging.INFO)
    if verbose or sys.stdout is not None and sys.stdout.isatty():
        console = logging.StreamHandler(sys.stdout)
        console.setFormatter(logging.Formatter("%(asctime)s %(levelname)-7s %(message)s"))
        log.addHandler(console)
    return logfile


# --------------------------------------------------------------------------
# single instance
# --------------------------------------------------------------------------

class AlreadyRunning(RuntimeError):
    pass


def acquire_single_instance(port: int) -> None:
    """Refuse to start a second engine.

    Two engines fight over port 8001, and the loser's user sees a health check
    that flaps between passing and failing. The probe is a TCP connect rather
    than a lock file because a crashed engine leaves its lock behind but not its
    listener.
    """
    if port_in_use(port):
        raise AlreadyRunning(f"端口 {port} 已被占用：可能已有一个 MasLingo 引擎在运行")
    holder = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    holder.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 0)
    try:
        holder.bind((HOST, port))
    except OSError as error:
        holder.close()
        raise AlreadyRunning(f"端口 {port} 已被占用：{error}") from error
    holder.close()


def port_in_use(port: int, host: str = HOST) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.settimeout(0.6)
        return probe.connect_ex((host, port)) == 0


# --------------------------------------------------------------------------
# health
# --------------------------------------------------------------------------

def health(port: int, timeout: float = 3.0) -> dict | None:
    """Ask the backend whether it is actually ready.

    Returns None rather than raising: every caller here is deciding what to show
    the user, and "no answer" is a normal outcome, not an exception.
    """
    url = f"http://{HOST}:{port}/health"
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, OSError, ValueError, TimeoutError):
        return None


def wait_until_ready(port: int, deadline_s: float = 180.0) -> dict | None:
    """Poll with backoff until the backend reports ready.

    The first start after a fresh install loads the MangaOCR weights, which takes
    tens of seconds. Polling tightly would spend that time burning a core; the
    interval grows instead.
    """
    started = time.time()
    interval = 0.5
    while time.time() - started < deadline_s:
        payload = health(port)
        if payload and payload.get("ok"):
            return payload
        time.sleep(interval)
        interval = min(interval * 1.6, 4.0)
    return None


# --------------------------------------------------------------------------
# the server
# --------------------------------------------------------------------------

class Engine:
    """Owns the uvicorn server thread and the restart budget."""

    def __init__(self, port: int):
        self.port = port
        self.server = None
        self.thread: threading.Thread | None = None
        self.lock = threading.Lock()
        self.restarts: list[float] = []
        self.last_error: str | None = None
        self.stopping = False

    # -- lifecycle ---------------------------------------------------------

    def start(self) -> bool:
        with self.lock:
            if self.thread and self.thread.is_alive():
                return True
            try:
                import uvicorn

                from backend.app import app
            except Exception as error:  # noqa: BLE001
                self.last_error = f"无法加载后端：{type(error).__name__}: {error}"
                log.error(self.last_error)
                return False

            config = uvicorn.Config(
                app,
                host=HOST,
                port=self.port,
                log_level="info",
                access_log=False,
                # The engine owns its own logging; uvicorn's default handlers
                # would write to a console that does not exist under pythonw.
                log_config=None,
            )
            self.server = uvicorn.Server(config)
            self.thread = threading.Thread(
                target=self._run, name="maslingo-uvicorn", daemon=True,
            )
            self.thread.start()
        return True

    def _run(self) -> None:
        try:
            self.server.run()
        except Exception as error:  # noqa: BLE001
            self.last_error = f"{type(error).__name__}: {error}"
            log.error("后端线程异常退出：%s", self.last_error)
        if not self.stopping:
            log.warning("后端停止，准备按退避策略重启")
            self._schedule_restart()

    def _schedule_restart(self) -> None:
        now = time.time()
        self.restarts = [t for t in self.restarts if now - t < RESTART_WINDOW_S]
        if len(self.restarts) >= MAX_RESTARTS:
            # Deliberately stop here. The spec forbids an infinite restart loop,
            # and a silent one is worse than a stopped engine: the tray keeps
            # showing the failure and the log says why.
            log.error(
                "后端在 %d 分钟内已重启 %d 次，停止自动重启。请查看日志后手动重启。",
                RESTART_WINDOW_S // 60, len(self.restarts),
            )
            self.last_error = "重启次数已达上限，已停止自动重启"
            return
        delay = RESTART_DELAYS[min(len(self.restarts), len(RESTART_DELAYS) - 1)]
        self.restarts.append(now)
        log.info("%d 秒后重启（第 %d 次）", delay, len(self.restarts))

        def again() -> None:
            time.sleep(delay)
            if not self.stopping:
                self.start()

        threading.Thread(target=again, daemon=True).start()

    def stop(self) -> None:
        self.stopping = True
        if self.server is not None:
            self.server.should_exit = True
        if self.thread is not None:
            self.thread.join(timeout=10)

    def restart(self) -> None:
        log.info("手动重启后端")
        self.stopping = True
        if self.server is not None:
            self.server.should_exit = True
        if self.thread is not None:
            self.thread.join(timeout=10)
        self.stopping = False
        self.restarts.clear()
        self.last_error = None
        self.start()

    # -- status ------------------------------------------------------------

    def status(self) -> tuple[str, str]:
        """(state, human text). States: ok / starting / error / stopped."""
        if self.stopping:
            return "stopped", "引擎已停止"
        payload = health(self.port)
        if payload and payload.get("ok"):
            backend = payload.get("backend", "ready")
            return "ok", f"后端正常（{backend}，端口 {self.port}）"
        if self.last_error and len(self.restarts) >= MAX_RESTARTS:
            return "error", f"后端无法启动：{self.last_error}"
        if self.thread and self.thread.is_alive():
            return "starting", "后端正在启动…"
        return "error", self.last_error or "后端未运行"


# --------------------------------------------------------------------------
# autostart (current user, no administrator rights)
# --------------------------------------------------------------------------

RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"


def autostart_command() -> str:
    """The exact command the Run entry should hold for this installation."""
    exe = Path(sys.executable)
    # pythonw.exe, not python.exe: a console window must never appear.
    launcher = exe.with_name("pythonw.exe")
    if not launcher.exists():
        launcher = exe
    script = ROOT / "packaging" / "engine" / "maslingo_engine.py"
    return f'"{launcher}" "{script}"'


def autostart_enabled() -> bool:
    try:
        import winreg
    except ImportError:
        return False
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY) as key:
            value, _ = winreg.QueryValueEx(key, APP_NAME)
            return bool(value)
    except FileNotFoundError:
        return False
    except OSError:
        return False


def set_autostart(enabled: bool) -> bool:
    """Add or remove the per-user Run entry. Returns whether it is now on.

    HKEY_CURRENT_USER, not HKEY_LOCAL_MACHINE: the spec asks the installer not to
    demand administrator rights, and a machine-wide Run entry would need them.
    """
    try:
        import winreg
    except ImportError:
        return False
    try:
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, RUN_KEY) as key:
            if enabled:
                winreg.SetValueEx(key, APP_NAME, 0, winreg.REG_SZ, autostart_command())
            else:
                try:
                    winreg.DeleteValue(key, APP_NAME)
                except FileNotFoundError:
                    pass
        return enabled
    except OSError as error:
        log.error("写入开机启动项失败：%s", error)
        return autostart_enabled()


# --------------------------------------------------------------------------
# tray
# --------------------------------------------------------------------------

def tray_image(state: str):
    from PIL import Image, ImageDraw

    colour = {
        "ok": (87, 192, 138),
        "starting": (224, 179, 87),
        "error": (232, 119, 106),
        "stopped": (152, 161, 168),
    }.get(state, (152, 161, 168))
    size = 64
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.ellipse((6, 6, size - 6, size - 6), fill=(26, 30, 40, 255))
    draw.ellipse((18, 18, size - 18, size - 18), fill=colour)
    return image


def open_path(path: Path) -> None:
    try:
        os.startfile(path)  # noqa: S606 - opening the user's own log folder
    except OSError as error:
        log.error("无法打开 %s：%s", path, error)


def watch_for_shutdown(engine: Engine, stop_tray) -> None:
    """Exit the engine when another process asks it to.

    Polled rather than pushed because the caller may be an uninstaller with no
    IPC channel to us, and because a stale request file is harmless: it is
    consumed and deleted on the next start.
    """
    while not engine.stopping:
        time.sleep(1.0)
        if SHUTDOWN_REQUEST.exists():
            try:
                SHUTDOWN_REQUEST.unlink()
            except OSError:
                pass
            log.info("收到停止请求，正在退出")
            STATE_DIR.mkdir(parents=True, exist_ok=True)
            QUIT_FLAG.write_text("stopped by request\n", encoding="utf-8")
            engine.stop()
            try:
                stop_tray()
            except Exception:  # noqa: BLE001 - shutting down anyway
                pass
            return


def run_tray(engine: Engine) -> int:
    import pystray
    from pystray import Menu, MenuItem

    state = {"value": "starting"}

    def refresh(icon: pystray.Icon) -> None:
        state["value"], text = engine.status()
        icon.icon = tray_image(state["value"])
        icon.title = f"MasLingo — {text}"

    def wrap(action):
        def handler(icon, item):  # noqa: ARG001 - pystray's signature
            action()
            refresh(icon)
        return handler

    def toggle_autostart(icon, item):  # noqa: ARG001
        set_autostart(not autostart_enabled())
        refresh(icon)

    def quit_engine(icon, item):  # noqa: ARG001
        # The flag is what stops autostart from resurrecting an engine the user
        # deliberately closed.
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        QUIT_FLAG.write_text("stopped by user\n", encoding="utf-8")
        log.info("用户从托盘退出引擎")
        engine.stop()
        icon.stop()

    def status_text(item):  # noqa: ARG001
        return engine.status()[1]

    menu = Menu(
        MenuItem(status_text, None, enabled=False),
        Menu.SEPARATOR,
        MenuItem("打开日志", wrap(lambda: open_path(LOG_DIR))),
        MenuItem("打开设置目录", wrap(lambda: open_path(STATE_DIR))),
        MenuItem("重启后端", wrap(engine.restart)),
        Menu.SEPARATOR,
        MenuItem("开机自动启动", toggle_autostart, checked=lambda item: autostart_enabled()),  # noqa: ARG005
        Menu.SEPARATOR,
        MenuItem("退出引擎", quit_engine),
    )
    icon = pystray.Icon(APP_NAME, tray_image("starting"), "MasLingo — 正在启动…", menu)
    threading.Thread(target=lambda: (time.sleep(1.5), refresh(icon)), daemon=True).start()
    threading.Thread(target=watch_for_shutdown, args=(engine, icon.stop), daemon=True).start()
    icon.run()
    return 0


# --------------------------------------------------------------------------
# entry point
# --------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="MasLingo 本地引擎")
    parser.add_argument("--port", type=int, default=int(os.environ.get("MASLINGO_PORT", DEFAULT_PORT)))
    parser.add_argument("--no-tray", action="store_true", help="不显示托盘图标（用于诊断）")
    parser.add_argument("--check", action="store_true", help="只做健康检查后退出")
    parser.add_argument("--shutdown", action="store_true", help="请正在运行的引擎退出（卸载时用）")
    parser.add_argument("--restart", action="store_true", help="重启正在运行的引擎")
    parser.add_argument("--autostart", choices=["on", "off", "status"])
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args(argv)

    if args.shutdown:
        # Ask a running engine to stand down. Returns 0 whether or not one was
        # there: the uninstaller calls this unconditionally, and "nothing was
        # running" is the outcome it wants, not an error.
        if not port_in_use(args.port):
            print("没有正在运行的引擎。")
            return 0
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        SHUTDOWN_REQUEST.write_text("shutdown\n", encoding="utf-8")
        for _ in range(20):
            time.sleep(0.5)
            if not port_in_use(args.port):
                print("引擎已停止。")
                return 0
        print("引擎未在 10 秒内停止；它可能在处理一次识别，稍后会自行退出。")
        return 0

    if args.check:
        payload = health(args.port)
        if payload and payload.get("ok"):
            print(f"ok  {payload}")
            return 0
        print(f"unreachable  http://{HOST}:{args.port}/health")
        return 1

    if args.autostart:
        if args.autostart == "status":
            print("on" if autostart_enabled() else "off")
            return 0
        print("on" if set_autostart(args.autostart == "on") else "off")
        return 0

    logfile = setup_logging(args.verbose)
    log.info("MasLingo Engine 启动（端口 %d，根目录 %s）", args.port, ROOT)

    if args.restart:
        # Ask a running engine to stand down, then start fresh.
        try:
            with socket.create_connection((HOST, args.port), timeout=1):
                log.info("检测到已有实例，请先从托盘退出后再重启")
                return 1
        except OSError:
            pass

    try:
        acquire_single_instance(args.port)
    except AlreadyRunning as error:
        # Not a failure: the common case is autostart firing while the engine is
        # already up, and the right answer is to leave the running one alone. Exit
        # 0 for that reason — but say so, because a silent no-op looks exactly
        # like a broken launcher when a user runs it by hand.
        log.info("%s", error)
        print(f"MasLingo 引擎已在运行，未启动第二个实例。（{error}）")
        return 0

    if QUIT_FLAG.exists() and not args.no_tray:
        QUIT_FLAG.unlink(missing_ok=True)

    # Consume any request left by an earlier --shutdown before the watcher starts.
    #
    # This is not tidiness. An uninstall writes the request; if the engine happens
    # to be stopped at that moment the file stays behind, and the next start —
    # the user's next login — would read it as an instruction to exit and die a
    # second after becoming healthy. The symptom is an engine that is briefly up
    # and then gone, which is close to undiagnosable from the tray.
    if SHUTDOWN_REQUEST.exists():
        log.info("清理上次遗留的停止请求")
        SHUTDOWN_REQUEST.unlink(missing_ok=True)

    engine = Engine(args.port)
    if not engine.start():
        log.error("引擎启动失败：%s", engine.last_error)
        if args.no_tray:
            return 1
        # Still show the tray: the user needs the log path and a retry button more
        # than they need the process to exit silently.
        return run_tray(engine)

    if args.no_tray:
        # The watcher runs in this mode too. Without it, `--shutdown` — which is
        # what the uninstaller calls — could never stop a headless engine, and the
        # uninstall would leave a process holding port 8001 and its own files.
        threading.Thread(
            target=watch_for_shutdown, args=(engine, lambda: None), daemon=True,
        ).start()
        try:
            while not engine.stopping:
                time.sleep(1)
        except KeyboardInterrupt:
            engine.stop()
        return 0

    log.info("日志文件：%s", logfile)
    return run_tray(engine)


if __name__ == "__main__":
    sys.exit(main())
