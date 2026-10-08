// The in-page control panel.
//
// The extension popup closes the moment you click the page, which makes it a bad
// place for anything you need while reading. This is the same controls, living in
// the page: a small glass panel in the lower right, draggable, collapsible to a
// status dot, and carrying the two things worth knowing at a glance — is the
// backend up, and is the translator actually reachable.
//
// Everything verbose goes to the single-line status strip below it. There is no
// terminal in here on purpose: during auto translate the panel would otherwise be
// a wall of scrolling text next to the artwork the user is trying to read.

// Assigned onto globalThis rather than declared with const: other content
// scripts reach it as `globalThis.MAS_panel`, and a top-level const lives in the
// global lexical scope without ever becoming a property of globalThis — so the
// status calls silently did nothing.
globalThis.MAS_panel = (() => {
  const STATE = { UNKNOWN: "unknown", WORKING: "working", OK: "ok", BAD: "bad" };
  const POSITION_KEY = "panelPosition";
  const COLLAPSED_KEY = "panelCollapsed";

  // Short enough to sit on one line, which is the point — it doubles as the test
  // input for the connectivity check, so it has to be a real sentence.
  const LINES = [
    "君の名は。",
    "行こう、一緒に。",
    "あきらめたらそこで試合終了だよ。",
    "僕はお前のことが好きだ。",
    "世界は残酷だ。",
    "まだ間に合う。",
    "信じてる。",
    "帰りたくないな。",
    "夢を見ていたんだ。",
    "また明日ね。",
    "何度でも立ち上がれ。",
    "君となら大丈夫。",
  ];

  let root = null;
  // The status line moved to its own glass surface (content/status.js), so the
  // panel no longer owns a node or a dismiss timer for it.
  let dragging = null;
  let typing = null;
  let resetTimer = null;

  // --- storage --------------------------------------------------------------

  async function readStore(keys) {
    try {
      return (await chrome.storage.local.get(keys)) || {};
    } catch {
      return {};
    }
  }

  async function writeStore(values) {
    try {
      await chrome.storage.local.set(values);
    } catch {
      /* extension APIs unreachable in this frame */
    }
  }

  // --- status dots ----------------------------------------------------------

  function setDot(node, state, text) {
    node.dataset.state = state;
    node.querySelector(".maslingo-dot-text").textContent = text;
  }

  // --- status ---------------------------------------------------------------
  //
  // The line lives on its own glass surface in the lower right corner, not inside
  // the panel. The material work made that the better arrangement: a status that
  // only exists while the panel is open is invisible exactly when it matters —
  // while the panel is collapsed out of the way, or while the user is reading
  // somewhere else on the page.
  //
  // The panel keeps one job here: mirroring the busy state onto the collapsed
  // widget's dot, which is the only status the widget can show at 8px.

  function status(text, kind = "info") {
    try {
      globalThis.MAS_status?.show?.(text, kind);
    } catch {
      /* the popup could not mount in this frame */
    }

    const widgetText = root?.querySelector("#maslingo-widget-text");
    if (widgetText) widgetText.textContent = text || "自动翻译";
    if (root) root.dataset.busy = kind === "error" ? "2" : (text ? "1" : "0");
  }

  // --- typing ---------------------------------------------------------------
  //
  // Used to reveal a translation one character at a time. It is not decoration:
  // it makes the connectivity check legible as it happens, so a slow provider
  // looks slow rather than broken.

  function typeInto(node, text, { speed = 42 } = {}) {
    // An interrupted run must settle its promise. The first version cleared the
    // interval and left the caller awaiting forever, so a re-sample timer from a
    // previous check could interrupt a second check's typing and leave the
    // 连通检测 button disabled on "检测中…" until the page was reloaded.
    if (typing) {
      clearInterval(typing.interval);
      typing.resolve();
      typing = null;
    }
    node.textContent = "";
    let index = 0;
    return new Promise((resolve) => {
      const interval = setInterval(() => {
        index += 1;
        node.textContent = text.slice(0, index);
        if (index >= text.length) {
          clearInterval(interval);
          typing = null;
          resolve();
        }
      }, speed);
      typing = { interval, resolve };
    });
  }

  // --- the one-liner --------------------------------------------------------

  function pickLine() {
    return LINES[Math.floor(Math.random() * LINES.length)];
  }

  // --- checks ---------------------------------------------------------------

  /**
   * Is the OCR backend reachable?
   *
   * Called on load and whenever the user asks. A failure is reported as a short
   * sentence, never as a stack or a raw body — the people reading this are
   * reading manga.
   */
  async function checkBackend({ quiet = false } = {}) {
    const dot = root.querySelector("#maslingo-dot-backend");
    setDot(dot, STATE.WORKING, "后端检测中");
    if (!quiet) status("正在检测后端……");

    // Asked of the service worker, not fetched here: a content script is bound by
    // the page's origin, so it cannot reach a backend on another host — which is
    // where the backend always is.
    let result = { ok: false };
    try {
      result = await chrome.runtime.sendMessage({ type: "CHECK_BACKEND" });
    } catch {
      result = { ok: false };
    }
    if (result?.ok) {
      setDot(dot, STATE.OK, "后端正常");
      return true;
    }
    setDot(dot, STATE.BAD, "后端未连接");
    if (!quiet) status("本地后端未启动", "error");
    return false;
  }

  /**
   * Is the chosen translator actually reachable?
   *
   * Deliberately not a configuration check. Whether a key is present says
   * nothing about whether it works, and every failure worth catching — revoked
   * key, wrong model, exhausted quota, throttling — only shows up when a real
   * request is made. So this sends the one-liner above and waits for a real
   * translation of it.
   *
   * @returns {Promise<{ok: boolean, translated?: string, reason?: string}>}
   */
  async function checkTranslation(text) {
    const dot = root.querySelector("#maslingo-dot-translation");
    setDot(dot, STATE.WORKING, "翻译检测中");

    const cfg = await readStore([
      "translationProvider", "translationEndpoint", "translationModel",
      "translationApiKey", "translationAppId", "targetLanguage",
    ]);

    let result;
    try {
      result = await chrome.runtime.sendMessage({
        type: "TEST_PROVIDER",
        text,
        cfg: { ...cfg, translationProvider: cfg.translationProvider || currentProviderId() },
      });
    } catch (error) {
      result = { ok: false, reason: String(error?.message || error) };
    }

    if (result?.ok && result.translated) {
      setDot(dot, STATE.OK, "翻译已连通");
      return { ok: true, translated: result.translated };
    }
    setDot(dot, STATE.BAD, "翻译连接失败");
    const reason = result?.httpStatus
      ? describeFailure(result.httpStatus, result.detail)
      : (result?.reason === "尚未选择翻译来源" ? "尚未选择翻译来源" : (result?.reason || "请求失败"));
    return { ok: false, reason };
  }

  /** The provider currently chosen in the panel's own select. */
  function currentProviderId() {
    return root?.querySelector("#maslingo-provider")?.value || "";
  }

  /** A short, human reason — never the raw body. */
  function describeFailure(httpStatus, detail = "") {
    const combined = `${detail} ${httpStatus}`;
    if (/api key|unauthor|invalid.*key|401|403/i.test(combined)) return "API Key 无效";
    if (/quota|insufficient|balance|402|429/i.test(combined)) return "额度不足或被限流";
    if (/model|404/i.test(combined)) return "模型不可用";
    if (httpStatus === 408 || httpStatus === 504) return "请求超时";
    if (httpStatus >= 500) return "翻译服务暂时不可用";
    return detail ? String(detail).slice(0, 60) : `请求失败（${httpStatus}）`;
  }

  // --- the connectivity button ---------------------------------------------

  async function runConnectivityCheck() {
    const button = root.querySelector("#maslingo-connect");
    const line = root.querySelector("#maslingo-line");
    if (button.disabled) return;
    button.disabled = true;
    const original = button.textContent;
    button.textContent = "检测中…";

    try {
      status("正在检测翻译连通……");
      const backendOk = await checkBackend({ quiet: true });
      if (!backendOk) {
        await typeInto(line, "后端未连接");
        status("后端连接失败", "error");
        return;
      }

      const source = currentLine;
      const result = await checkTranslation(source);
      if (result.ok) {
        await typeInto(line, result.translated);
        status("翻译连通正常");
        // Tracked so it cannot fire into the middle of a later check and steal
        // its typing — the reason the button could stick on "检测中…".
        if (resetTimer) clearTimeout(resetTimer);
        resetTimer = setTimeout(() => {
          resetTimer = null;
          currentLine = pickLine();
          typeInto(root.querySelector("#maslingo-line"), `「${currentLine}」`, { speed: 24 });
        }, 4000);
      } else {
        await typeInto(line, "翻译连接失败");
        status(`翻译 API 连接失败：${result.reason}`, "error");
      }
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
  }

  // --- dragging -------------------------------------------------------------

  function applyPosition(position) {
    if (!position) return;
    root.style.left = `${position.left}px`;
    root.style.top = `${position.top}px`;
    root.style.right = "auto";
    root.style.bottom = "auto";
    // Any in-flight drag offset is meaningless once an absolute position is
    // committed; left/top now carries it.
    root.style.transform = "";
  }

  /**
   * Keep the panel fully on screen, whatever the page or window does.
   */
  function clamp(left, top) {
    const margin = 8;
    const width = root.offsetWidth || 268;
    const height = root.offsetHeight || 220;
    const gap = bottomGap();
    return {
      left: Math.min(Math.max(margin, left), Math.max(margin, window.innerWidth - width - margin)),
      top: Math.min(Math.max(margin, top), Math.max(margin, window.innerHeight - height - gap)),
    };
  }

  /**
   * How much clear space the panel leaves under itself.
   *
   * Read from the stylesheet rather than hard-coded, because the same strip has
   * to be respected in two places: the CSS `bottom` offset (which applies while
   * the panel is corner-anchored) and `clamp` (which applies once a drag has
   * given it an absolute position). Two constants would drift, and the status
   * surface would end up sitting on the panel's footer again.
   */
  function bottomGap() {
    const margin = 8;
    const edge = 16;
    const property = getComputedStyle(document.documentElement)
      .getPropertyValue("--maslingo-status-reserve").trim();
    const reserve = Number.parseFloat(property);
    return margin + edge + (Number.isFinite(reserve) ? reserve : 48);
  }

  function startDrag(event) {
    if (event.button !== 0) return;
    // The title bar doubles as the drag handle and holds the collapse button.
    // Without this the pointerdown lands on the button too, and the
    // preventDefault() below suppresses the click that would have followed — the
    // button looked wired up but never fired, while the tests passed because they
    // called .click() directly and skipped the pointer events entirely.
    if (event.target.closest("button, input, select, a, textarea")) return;

    const rect = root.getBoundingClientRect();
    // originLeft/Top are where the pane actually sits right now — the basis the
    // translate3d offset is measured from, and what the final left/top is
    // committed against on release.
    dragging = {
      dx: event.clientX - rect.left,
      dy: event.clientY - rect.top,
      x: 0,
      y: 0,
      originLeft: rect.left,
      originTop: rect.top,
    };
    // The settle animation would otherwise fight the drag; it is re-added on
    // release, which is the whole point of it.
    root.classList.remove("maslingo-panel-settling");
    root.classList.add("maslingo-panel-dragging");
    globalThis.MAS_glass?.setState?.(root, "dragging");
    try {
      root.setPointerCapture?.(event.pointerId);
    } catch {
      // A pointer id the browser does not consider active. Dragging still works
      // through the window listeners; capturing is only an optimisation.
    }
    event.preventDefault();
  }

  /**
   * Move the pane with translate3d, never with left/top.
   *
   * §6 requires this, and it is not a style preference: writing `left`/`top` on
   * every pointer event invalidates layout for the panel and everything that
   * depends on it, so the drag competes with the page's own rendering. A
   * transform is handled by the compositor and costs nothing on the main thread.
   * The final position is committed to `left`/`top` exactly once, on release.
   */
  function moveDrag(event) {
    if (!dragging) return;
    const next = clamp(event.clientX - dragging.dx, event.clientY - dragging.dy);
    dragging.x = next.left - dragging.originLeft;
    dragging.y = next.top - dragging.originTop;
    root.style.transform = `translate3d(${dragging.x}px, ${dragging.y}px, 0)`;
  }

  function endDrag() {
    if (!dragging) return;
    const { x, y, originLeft, originTop } = dragging;
    dragging = null;
    root.classList.remove("maslingo-panel-dragging");
    // Commit the position and drop the transform in the same frame, so the pane
    // does not visibly move as the two swap over.
    root.style.transform = "";
    applyPosition({ left: Math.round(originLeft + x), top: Math.round(originTop + y) });
    // Lifts back with a short overshoot instead of snapping straight.
    globalThis.MAS_glass?.settle?.(root);
    const rect = root.getBoundingClientRect();
    writeStore({ [POSITION_KEY]: { left: Math.round(rect.left), top: Math.round(rect.top) } });
  }

  window.addEventListener("resize", () => {
    if (!root || root.classList.contains("maslingo-panel-collapsed")) return;
    const rect = root.getBoundingClientRect();
    applyPosition(clamp(rect.left, rect.top));
  }, { passive: true });

  // --- collapse -------------------------------------------------------------

  function setCollapsed(collapsed) {
    // One call flips the class every material layer reads through
    // --maslingo-morph, and picks the longer expand curve (§20). Keeping it in
    // MAS_glass means the collapse timing and the lighting live together.
    globalThis.MAS_glass?.setMorph?.(root, collapsed);
    writeStore({ [COLLAPSED_KEY]: collapsed });
  }

  // --- markup ---------------------------------------------------------------

  let currentLine = "";

  function build() {
    const node = document.createElement("div");
    node.id = "maslingo-panel";
    // `maslingo-surface` supplies the host-reset defences and the typography;
    // the four layers carry the material and the content sits above them.
    node.className = "maslingo-panel maslingo-surface";
    node.dataset.state = "idle";
    // Each band is wrapped in a grid row so collapsing can animate the height.
    // There is no `display:none` anywhere in the collapsed state: the panel
    // changes shape continuously instead of swapping between two layouts.
    node.innerHTML = `
      <div class="maslingo-glass__base" aria-hidden="true"></div>
      <div class="maslingo-glass__depth" aria-hidden="true"></div>
      <div class="maslingo-glass__edge" aria-hidden="true"></div>
      <div class="maslingo-glass__specular" aria-hidden="true"><i></i></div>

      <div class="maslingo-glass__content">
        <div class="maslingo-sec maslingo-sec-bar"><div class="maslingo-sec-in">
          <div class="maslingo-panel-bar" id="maslingo-panel-bar">
            <span class="maslingo-brand">MasLingo</span>
            <button class="maslingo-panel-btn" id="maslingo-collapse" title="收起为挂件" aria-label="收起">–</button>
          </div>
        </div></div>

        <div class="maslingo-sec maslingo-sec-body"><div class="maslingo-sec-in">
          <div class="maslingo-panel-body">
            <div class="maslingo-dots">
              <span class="maslingo-dot" id="maslingo-dot-backend" data-state="unknown">
                <i></i><span class="maslingo-dot-text">后端未检测</span>
              </span>
              <span class="maslingo-dot" id="maslingo-dot-translation" data-state="unknown">
                <i></i><span class="maslingo-dot-text">翻译未检测</span>
              </span>
            </div>

            <div class="maslingo-row">
              <span class="maslingo-label" id="maslingo-auto-label">自动识别</span>
              <label class="maslingo-switch" aria-labelledby="maslingo-auto-label">
                <input id="maslingo-auto" type="checkbox" aria-labelledby="maslingo-auto-label">
                <span class="maslingo-switch-track"><span class="maslingo-switch-thumb"></span></span>
              </label>
            </div>
            <button class="maslingo-btn" id="maslingo-select">框选翻译</button>

            <div class="maslingo-rule"></div>

            <div class="maslingo-label" id="maslingo-provider-label">翻译类型</div>
            <div class="maslingo-row maslingo-row-tight">
              <select id="maslingo-provider" class="maslingo-select" aria-labelledby="maslingo-provider-label"></select>
              <button class="maslingo-btn maslingo-btn-small" id="maslingo-connect">连通检测</button>
            </div>
            <div class="maslingo-line" id="maslingo-line"></div>

            <div class="maslingo-rule"></div>
            <div class="maslingo-foot">
              <button class="maslingo-link" id="maslingo-settings">⚙ 设置</button>
              <span class="maslingo-version" id="maslingo-version"></span>
            </div>
          </div>
        </div></div>

        <div class="maslingo-sec maslingo-sec-widget"><div class="maslingo-sec-in">
          <button class="maslingo-widget" id="maslingo-widget" title="展开">
            <i></i><span id="maslingo-widget-text">自动翻译</span>
          </button>
        </div></div>
      </div>
    `;
    return node;
  }

  function fillProviders() {
    const select = root.querySelector("#maslingo-provider");
    const registry = globalThis.MAS_providers;
    if (!registry) return;
    select.textContent = "";
    for (const provider of registry.list) {
      const option = document.createElement("option");
      option.value = provider.id;
      option.textContent = provider.id === "none"
        ? "不翻译（只识别）"
        : provider.label.replace(/（.*?）/g, "");
      select.append(option);
    }
  }

  // --- wiring ---------------------------------------------------------------

  async function mount() {
    if (root && root.isConnected) return root;
    root = build();
    document.documentElement.appendChild(root);

    // The material engine: specular position, hover/drag states, settle. Bound
    // once here; it schedules frames only while the pointer is actually moving.
    globalThis.MAS_glass?.track?.(root);

    currentLine = pickLine();
    root.querySelector("#maslingo-line").textContent = `「${currentLine}」`;
    root.querySelector("#maslingo-version").textContent =
      `v${chrome.runtime?.getManifest?.().version || ""}`;

    fillProviders();

    const cfg = await readStore([
      "autoTranslate", "translationProvider", "panelPosition", "panelCollapsed",
    ]);
    root.querySelector("#maslingo-auto").checked = Boolean(cfg.autoTranslate);
    if (cfg.translationProvider) root.querySelector("#maslingo-provider").value = cfg.translationProvider;
    // Through MAS_glass so the restored state arrives with the same class the
    // transition expects; setting it directly would skip the longer expand curve
    // and, on a restored collapse, run the collapse animation on first paint.
    if (cfg.panelCollapsed) globalThis.MAS_glass?.setMorph?.(root, true);
    // Clamped on restore, not applied raw.
    //
    // A saved position is only meaningful for the window it was saved in. Drag
    // the panel to the far right on a wide monitor, reopen on a laptop, and the
    // stored `left` puts it past the right edge — the panel is mounted, running,
    // and completely invisible, which reads as "it disappeared".
    applyPosition(cfg.panelPosition ? clamp(cfg.panelPosition.left, cfg.panelPosition.top) : null);

    root.querySelector("#maslingo-auto").addEventListener("change", (event) => {
      writeStore({ autoTranslate: event.target.checked });
      status(event.target.checked ? "正在扫描漫画……" : "自动识别已关闭");
    });
    root.querySelector("#maslingo-provider").addEventListener("change", (event) => {
      writeStore({ translationProvider: event.target.value });
      root.querySelector("#maslingo-dot-translation").dataset.state = STATE.UNKNOWN;
      setDot(root.querySelector("#maslingo-dot-translation"), STATE.UNKNOWN, "翻译未检测");
    });
    root.querySelector("#maslingo-connect").addEventListener("click", runConnectivityCheck);
    root.querySelector("#maslingo-select").addEventListener("click", async () => {
      // Via the service worker: runtime.sendMessage cannot reach content scripts,
      // so sending START_SELECT directly from here went nowhere at all.
      const result = await chrome.runtime
        .sendMessage({ type: "START_SELECT" })
        .catch((error) => ({ ok: false, error: error.message }));
      if (!result?.ok) status(`无法开始框选：${result?.error || "未知原因"}`, "error");
    });
    root.querySelector("#maslingo-settings").addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "OPEN_OPTIONS" }).catch(() => {});
    });
    root.querySelector("#maslingo-collapse").addEventListener("click", () => setCollapsed(true));
    root.querySelector("#maslingo-widget").addEventListener("click", () => setCollapsed(false));

    const bar = root.querySelector("#maslingo-panel-bar");
    bar.addEventListener("pointerdown", startDrag);
    window.addEventListener("pointermove", moveDrag, { passive: true });
    window.addEventListener("pointerup", endDrag, { passive: true });

    // Follow changes made elsewhere. Without this, toggling auto translate in the
    // popup left this panel's switch showing the old state, so the user would
    // "turn it on" while it was already on and nothing appeared to happen.
    try {
      chrome.storage?.onChanged?.addListener((changes, area) => {
        if (area !== "local") return;
        if (changes.autoTranslate) {
          const box = root.querySelector("#maslingo-auto");
          if (box && box.checked !== Boolean(changes.autoTranslate.newValue)) {
            box.checked = Boolean(changes.autoTranslate.newValue);
          }
        }
        if (changes.translationProvider) {
          const select = root.querySelector("#maslingo-provider");
          if (select && select.value !== changes.translationProvider.newValue) {
            select.value = changes.translationProvider.newValue;
            setDot(root.querySelector("#maslingo-dot-translation"), STATE.UNKNOWN, "翻译未检测");
          }
        }
      });
    } catch {
      /* extension APIs unreachable in this frame */
    }

    // Nothing here runs on scroll or on DOM changes: the checks are one-shot at
    // load and on demand, which is all they need to be.
    checkBackend({ quiet: true }).then((ok) => {
      if (ok) checkTranslation(currentLine).catch(() => {});
    });

    return root;
  }

  return { mount, status, setDot, STATE, checkBackend, checkTranslation };
})();
