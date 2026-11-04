"""Legacy Office and RTF conversion through an isolated LibreOffice profile."""

import os
import shutil
import subprocess
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Lock

from fastapi import HTTPException

from .document_common import MAX_EXPANDED_BYTES, MAX_FILE_BYTES

LEGACY = {
    ".doc": (".docx", "doc:MS Word 97", "application/msword"),
    ".rtf": (".docx", "rtf:Rich Text Format", "application/rtf"),
    ".xls": (".xlsx", "xls:MS Excel 97", "application/vnd.ms-excel"),
    ".ppt": (".pptx", "ppt:MS PowerPoint 97", "application/vnd.ms-powerpoint"),
}
CONVERTER_LOCK = Lock()


def libreoffice():
    configured = os.getenv("MAS_LIBREOFFICE")
    if configured and Path(configured).is_file():
        return str(Path(configured).resolve())
    command = shutil.which("soffice")
    if command:
        return command
    for env in ("ProgramFiles", "ProgramFiles(x86)"):
        directory = os.getenv(env)
        if directory:
            candidate = Path(directory) / "LibreOffice" / "program" / "soffice.exe"
            if candidate.is_file():
                return str(candidate)
    raise HTTPException(503, "旧版 Office 和 RTF 需要在后端安装 LibreOffice")


def convert(command, source, target_dir, profile, format_name, limit):
    target_dir.mkdir(exist_ok=True)
    try:
        result = subprocess.run(
            [command, f"-env:UserInstallation={profile.as_uri()}", "--headless", "--norestore",
             "--convert-to", format_name, "--outdir", str(target_dir), str(source)],
            cwd=source.parent, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            timeout=40, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0), check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise HTTPException(503, "LibreOffice 转换失败或超时") from error
    target = target_dir / source.with_suffix("." + format_name.split(":", 1)[0]).name
    if result.returncode or not target.is_file():
        raise HTTPException(422, "LibreOffice 无法转换此文件，请确认文件未加密")
    if target.stat().st_size > limit:
        raise HTTPException(413, "转换后的文件过大")
    return target.read_bytes()


def convert_legacy(data, suffix, translations, mode):
    from .document import dispatch

    command = libreoffice()
    modern, original, mime = LEGACY[suffix]
    if not CONVERTER_LOCK.acquire(blocking=False):
        raise HTTPException(429, "旧版文档转换繁忙，请稍后重试")
    try:
        with TemporaryDirectory(prefix="maslingo-doc-") as directory:
            work = Path(directory).resolve()
            profile = work / "profile"
            user = profile / "user"
            user.mkdir(parents=True)
            (user / "registrymodifications.xcu").write_text(
                '<?xml version="1.0"?><oor:items xmlns:oor="http://openoffice.org/2001/registry">'
                '<item oor:path="/org.openoffice.Office.Common/Security/Scripting">'
                '<prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop>'
                '</item></oor:items>', encoding="utf-8",
            )
            source = work / ("source" + suffix)
            source.write_bytes(data)
            converted = convert(command, source, work / "modern", profile, modern[1:], MAX_EXPANDED_BYTES)
            output, _ = dispatch(converted, modern, translations, mode)
            if translations is None:
                return output, mime
            translated = work / ("translated" + modern)
            translated.write_bytes(output)
            return convert(command, translated, work / "legacy", profile, original, MAX_FILE_BYTES), mime
    finally:
        CONVERTER_LOCK.release()
