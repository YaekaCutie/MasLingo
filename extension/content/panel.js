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
  let statusNode = null;
  let statusTimer = null;
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
    node.querySelector(".mas-dot-text").textContent = text;
  }

  // --- status bar -----------------------------------------------------------
  //
  // One line, inside the panel, showing only what is happening right now. A new
  // message replaces the old one rather than stacking, because a scrolling log is
  // exactly what this is meant not to be.
  //
  // It used to be a separate floating strip pinned to the bottom-right corner.
  // Two surfaces meant the eye had to choose between them, and the corner one
  // covered the page for no reason — everything it said belongs to the panel.

  let idleText = "";

  /**
   * Replay the arrival animation on the status line.
   *
   * A class is re-added rather than a new node being created, so the line keeps
   * its measured width and nothing reflows around it. Removing and re-adding in
   * the same frame would not restart a CSS animation — reading offsetWidth
   * between the two forces a style flush, which is what makes it restart.
   */
  function pulseStatus() {
    const bar = statusNode;
    if (!bar) return;
    bar.classList.remove("mas-statusbar-updating");
    void bar.offsetWidth;
    bar.classList.add("mas-statusbar-updating");
  }

  function status(text, kind = "info") {
    const bar = statusNode;
    if (!bar) return;
    const line = bar.querySelector(".mas-status-text") || bar;

    line.textContent = text;
    bar.dataset.kind = kind;
    bar.classList.toggle("mas-statusbar-active", kind !== "info" || Boolean(text));
    bar.classList.toggle("mas-statusbar-idle", !text);
    if (text) pulseStatus();

    // The collapsed widget carries the same message, because a status the user
    // cannot see while collapsed is not a status. Its dot mirrors the kind.
    const widgetText = root?.querySelector("#mas-widget-text");
    if (widgetText) widgetText.textContent = text || "自动翻译";
    if (root) root.dataset.busy = kind === "error" ? "2" : (text ? "1" : "0");

    if (statusTimer) clearTimeout(statusTimer);
    if (!text) return;
    // Errors stay put long enough to be read and acted on; progress does not
    // need to linger.
    const dwell = kind === "error" ? 9000 : 4000;
    statusTimer = setTimeout(() => {
      line.textContent = idleText;
      bar.dataset.kind = "info";
      bar.classList.remove("mas-statusbar-active", "mas-statusbar-updating");
      bar.classList.add("mas-statusbar-idle");
      void bar.offsetWidth;
      const back = root?.querySelector("#mas-widget-text");
      if (back) back.textContent = "自动翻译";
      if (root) root.dataset.busy = "0";
    }, dwell);
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
    const dot = root.querySelector("#mas-dot-backend");
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
    const dot = root.querySelector("#mas-dot-translation");
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
    return root?.querySelector("#mas-provider")?.value || "";
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
    const button = root.querySelector("#mas-connect");
    const line = root.querySelector("#mas-line");
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
          typeInto(root.querySelector("#mas-line"), `「${currentLine}」`, { speed: 24 });
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
  }

  /**
   * Keep the panel fully on screen, whatever the page or window does.
   *
   * No corner is reserved any more: the status line moved inside the panel, so
   * there is no second surface for it to collide with.
   */
  function clamp(left, top) {
    const margin = 8;
    const width = root.offsetWidth || 264;
    const height = root.offsetHeight || 220;
    return {
      left: Math.min(Math.max(margin, left), Math.max(margin, window.innerWidth - width - margin)),
      top: Math.min(Math.max(margin, top), Math.max(margin, window.innerHeight - height - margin)),
    };
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
    dragging = { dx: event.clientX - rect.left, dy: event.clientY - rect.top };
    // The settle animation would otherwise fight the drag; it is re-added on
    // release, which is the whole point of it.
    root.classList.remove("mas-panel-settling");
    root.classList.add("mas-panel-dragging");
    try {
      root.setPointerCapture?.(event.pointerId);
    } catch {
      // A pointer id the browser does not consider active. Dragging still works
      // through the window listeners; capturing is only an optimisation.
    }
    event.preventDefault();
  }

  function moveDrag(event) {
    if (!dragging) return;
    const next = clamp(event.clientX - dragging.dx, event.clientY - dragging.dy);
    root.style.left = `${next.left}px`;
    root.style.top = `${next.top}px`;
    root.style.right = "auto";
    root.style.bottom = "auto";
  }

  function endDrag() {
    if (!dragging) return;
    dragging = null;
    root.classList.remove("mas-panel-dragging");
    // Lifts back with a short overshoot instead of snapping straight.
    globalThis.MAS_glass?.settle?.(root);
    const rect = root.getBoundingClientRect();
    writeStore({ [POSITION_KEY]: { left: Math.round(rect.left), top: Math.round(rect.top) } });
  }

  window.addEventListener("resize", () => {
    if (!root || root.classList.contains("mas-panel-collapsed")) return;
    const rect = root.getBoundingClientRect();
    applyPosition(clamp(rect.left, rect.top));
  }, { passive: true });

  // --- collapse -------------------------------------------------------------

  function setCollapsed(collapsed) {
    root.classList.toggle("mas-panel-collapsed", collapsed);
    writeStore({ [COLLAPSED_KEY]: collapsed });
  }

  // --- markup ---------------------------------------------------------------

  let currentLine = "";

  function build() {
    const node = document.createElement("div");
    node.id = "mas-panel";
    node.className = "mas-panel mas-glass";
    // Each band is wrapped in a grid row so collapsing can animate the height.
    // There is no `display:none` anywhere in the collapsed state: the panel
    // changes shape continuously instead of swapping between two layouts.
    node.innerHTML = `
      <div class="mas-glow" aria-hidden="true"></div>

      <div class="mas-sec mas-sec-bar"><div class="mas-sec-in">
        <div class="mas-panel-bar" id="mas-panel-bar">
          <span class="mas-brand">MasLingo</span>
          <button class="mas-panel-btn" id="mas-collapse" title="收起为挂件" aria-label="收起">–</button>
        </div>
      </div></div>

      <div class="mas-sec mas-sec-body"><div class="mas-sec-in">
        <div class="mas-panel-body">
          <div class="mas-dots">
            <span class="mas-dot" id="mas-dot-backend" data-state="unknown">
              <i></i><span class="mas-dot-text">后端未检测</span>
            </span>
            <span class="mas-dot" id="mas-dot-translation" data-state="unknown">
              <i></i><span class="mas-dot-text">翻译未检测</span>
            </span>
          </div>

          <div class="mas-row">
            <span class="mas-label" id="mas-auto-label">自动识别</span>
            <label class="mas-switch" aria-labelledby="mas-auto-label">
              <input id="mas-auto" type="checkbox" aria-labelledby="mas-auto-label">
              <span class="mas-switch-track"><span class="mas-switch-thumb"></span></span>
            </label>
          </div>
          <button class="mas-btn" id="mas-select">框选翻译</button>

          <div class="mas-rule"></div>

          <div class="mas-label" id="mas-provider-label">翻译类型</div>
          <div class="mas-row mas-row-tight">
            <select id="mas-provider" class="mas-select" aria-labelledby="mas-provider-label"></select>
            <button class="mas-btn mas-btn-small" id="mas-connect">连通检测</button>
          </div>
          <div class="mas-line" id="mas-line"></div>

          <div class="mas-rule"></div>
          <div class="mas-foot">
            <button class="mas-link" id="mas-settings">⚙ 设置</button>
            <span class="mas-version" id="mas-version"></span>
          </div>
        </div>
      </div></div>

      <div class="mas-sec mas-sec-status"><div class="mas-sec-in">
        <div class="mas-statusbar" id="mas-status" role="status" aria-live="polite">
          <span class="mas-status-text" id="mas-status-text"></span>
        </div>
      </div></div>

      <div class="mas-sec mas-sec-widget"><div class="mas-sec-in">
        <button class="mas-widget" id="mas-widget" title="展开">
          <i></i><span id="mas-widget-text">自动翻译</span>
        </button>
      </div></div>
    `;
    return node;
  }

  function fillProviders() {
    const select = root.querySelector("#mas-provider");
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

    // The status bar lives inside the panel, so there is no second surface to
    // mount and nothing pinned to the corner of the page.
    statusNode = root.querySelector("#mas-status");
    idleText = "就绪";
    statusNode.querySelector(".mas-status-text").textContent = idleText;

    // Pointer-follow highlight. Bound once, on mount, and coalesced to one
    // custom-property write per frame by MAS_glass.
    globalThis.MAS_glass?.follow?.(root);

    currentLine = pickLine();
    root.querySelector("#mas-line").textContent = `「${currentLine}」`;
    root.querySelector("#mas-version").textContent =
      `v${chrome.runtime?.getManifest?.().version || ""}`;

    fillProviders();

    const cfg = await readStore([
      "autoTranslate", "translationProvider", "panelPosition", "panelCollapsed",
    ]);
    root.querySelector("#mas-auto").checked = Boolean(cfg.autoTranslate);
    if (cfg.translationProvider) root.querySelector("#mas-provider").value = cfg.translationProvider;
    if (cfg.panelCollapsed) root.classList.add("mas-panel-collapsed");
    applyPosition(cfg.panelPosition);

    root.querySelector("#mas-auto").addEventListener("change", (event) => {
      writeStore({ autoTranslate: event.target.checked });
      status(event.target.checked ? "正在扫描漫画……" : "自动识别已关闭");
    });
    root.querySelector("#mas-provider").addEventListener("change", (event) => {
      writeStore({ translationProvider: event.target.value });
      root.querySelector("#mas-dot-translation").dataset.state = STATE.UNKNOWN;
      setDot(root.querySelector("#mas-dot-translation"), STATE.UNKNOWN, "翻译未检测");
    });
    root.querySelector("#mas-connect").addEventListener("click", runConnectivityCheck);
    root.querySelector("#mas-select").addEventListener("click", async () => {
      // Via the service worker: runtime.sendMessage cannot reach content scripts,
      // so sending START_SELECT directly from here went nowhere at all.
      const result = await chrome.runtime
        .sendMessage({ type: "START_SELECT" })
        .catch((error) => ({ ok: false, error: error.message }));
      if (!result?.ok) status(`无法开始框选：${result?.error || "未知原因"}`, "error");
    });
    root.querySelector("#mas-settings").addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "OPEN_OPTIONS" }).catch(() => {});
    });
    root.querySelector("#mas-collapse").addEventListener("click", () => setCollapsed(true));
    root.querySelector("#mas-widget").addEventListener("click", () => setCollapsed(false));

    const bar = root.querySelector("#mas-panel-bar");
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
          const box = root.querySelector("#mas-auto");
          if (box && box.checked !== Boolean(changes.autoTranslate.newValue)) {
            box.checked = Boolean(changes.autoTranslate.newValue);
          }
        }
        if (changes.translationProvider) {
          const select = root.querySelector("#mas-provider");
          if (select && select.value !== changes.translationProvider.newValue) {
            select.value = changes.translationProvider.newValue;
            setDot(root.querySelector("#mas-dot-translation"), STATE.UNKNOWN, "翻译未检测");
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
