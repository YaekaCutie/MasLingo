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
// scripts reach it as `globalThis.OMT_panel`, and a top-level const lives in the
// global lexical scope without ever becoming a property of globalThis — so the
// status calls silently did nothing.
globalThis.OMT_panel = (() => {
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
    node.querySelector(".omt-dot-text").textContent = text;
  }

  // --- status strip ---------------------------------------------------------
  //
  // One line, always. A new message replaces the old one rather than stacking,
  // because a scrolling log is exactly what this is meant not to be.

  function status(text, kind = "info") {
    if (!statusNode) return;
    statusNode.textContent = text;
    statusNode.className = `omt-status omt-status-${kind}`;
    void statusNode.offsetWidth;                 // restart the fade
    statusNode.classList.add("omt-status-in");
    if (statusTimer) clearTimeout(statusTimer);
    // Errors stay put long enough to be read and acted on; progress does not
    // need to linger.
    const dwell = kind === "error" ? 6000 : 2600;
    statusTimer = setTimeout(() => statusNode.classList.remove("omt-status-in"), dwell);
  }

  // --- typing ---------------------------------------------------------------
  //
  // Used to reveal a translation one character at a time. It is not decoration:
  // it makes the connectivity check legible as it happens, so a slow provider
  // looks slow rather than broken.

  function typeInto(node, text, { speed = 42 } = {}) {
    if (typing) clearInterval(typing);
    node.textContent = "";
    let index = 0;
    return new Promise((resolve) => {
      typing = setInterval(() => {
        index += 1;
        node.textContent = text.slice(0, index);
        if (index >= text.length) {
          clearInterval(typing);
          typing = null;
          resolve();
        }
      }, speed);
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
    const dot = root.querySelector("#omt-dot-backend");
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
    const dot = root.querySelector("#omt-dot-translation");
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
    return root?.querySelector("#omt-provider")?.value || "";
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
    const button = root.querySelector("#omt-connect");
    const line = root.querySelector("#omt-line");
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
        setTimeout(() => {
          currentLine = pickLine();
          typeInto(root.querySelector("#omt-line"), `「${currentLine}」`, { speed: 24 });
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
   * The bottom edge reserves room for the status strip. Without that, dragging
   * to the lower right corner parks the panel straight on top of the one line of
   * progress the user is meant to be reading.
   */
  function clamp(left, top) {
    const margin = 8;
    const width = root.offsetWidth || 260;
    const height = root.offsetHeight || 180;
    const strip = statusNode?.getBoundingClientRect();
    const reserved = strip ? strip.height + 16 : 0;
    return {
      left: Math.min(Math.max(margin, left), Math.max(margin, window.innerWidth - width - margin)),
      top: Math.min(
        Math.max(margin, top),
        Math.max(margin, window.innerHeight - height - margin - reserved),
      ),
    };
  }

  function startDrag(event) {
    if (event.button !== 0) return;
    const rect = root.getBoundingClientRect();
    dragging = { dx: event.clientX - rect.left, dy: event.clientY - rect.top };
    root.classList.add("omt-panel-dragging");
    root.setPointerCapture?.(event.pointerId);
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
    root.classList.remove("omt-panel-dragging");
    const rect = root.getBoundingClientRect();
    writeStore({ [POSITION_KEY]: { left: Math.round(rect.left), top: Math.round(rect.top) } });
  }

  window.addEventListener("resize", () => {
    if (!root || root.classList.contains("omt-panel-collapsed")) return;
    const rect = root.getBoundingClientRect();
    applyPosition(clamp(rect.left, rect.top));
  }, { passive: true });

  // --- collapse -------------------------------------------------------------

  function setCollapsed(collapsed) {
    root.classList.toggle("omt-panel-collapsed", collapsed);
    writeStore({ [COLLAPSED_KEY]: collapsed });
  }

  // --- markup ---------------------------------------------------------------

  let currentLine = "";

  function build() {
    const node = document.createElement("div");
    node.id = "omt-panel";
    node.className = "omt-panel";
    node.innerHTML = `
      <div class="omt-panel-bar" id="omt-panel-bar">
        <span class="omt-brand">OpenMangaTranslator</span>
        <button class="omt-panel-btn" id="omt-collapse" title="收起为挂件" aria-label="收起">–</button>
      </div>
      <div class="omt-panel-body">
        <div class="omt-dots">
          <span class="omt-dot" id="omt-dot-backend" data-state="unknown">
            <i></i><span class="omt-dot-text">后端未检测</span>
          </span>
          <span class="omt-dot" id="omt-dot-translation" data-state="unknown">
            <i></i><span class="omt-dot-text">翻译未检测</span>
          </span>
        </div>

        <div class="omt-row">
          <span class="omt-label">自动识别</span>
          <label class="omt-switch">
            <input id="omt-auto" type="checkbox">
            <span class="omt-switch-track"><span class="omt-switch-thumb"></span></span>
          </label>
        </div>
        <button class="omt-btn" id="omt-select">框选翻译</button>

        <div class="omt-sep"></div>

        <div class="omt-label">翻译类型</div>
        <div class="omt-row omt-row-tight">
          <select id="omt-provider" class="omt-select"></select>
          <button class="omt-btn omt-btn-small" id="omt-connect">连通检测</button>
        </div>
        <div class="omt-line" id="omt-line"></div>

        <div class="omt-sep"></div>
        <div class="omt-foot">
          <button class="omt-link" id="omt-settings">⚙ 设置</button>
          <span class="omt-version" id="omt-version"></span>
        </div>
      </div>
      <button class="omt-widget" id="omt-widget" title="展开">
        <i></i><span>自动翻译</span>
      </button>
    `;
    return node;
  }

  function fillProviders() {
    const select = root.querySelector("#omt-provider");
    const registry = globalThis.OMT_providers;
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

    statusNode = document.createElement("div");
    statusNode.id = "omt-status";
    statusNode.className = "omt-status";
    statusNode.setAttribute("role", "status");
    statusNode.setAttribute("aria-live", "polite");
    document.documentElement.appendChild(statusNode);

    currentLine = pickLine();
    root.querySelector("#omt-line").textContent = `「${currentLine}」`;
    root.querySelector("#omt-version").textContent =
      `v${chrome.runtime?.getManifest?.().version || ""}`;

    fillProviders();

    const cfg = await readStore([
      "autoTranslate", "translationProvider", "panelPosition", "panelCollapsed",
    ]);
    root.querySelector("#omt-auto").checked = Boolean(cfg.autoTranslate);
    if (cfg.translationProvider) root.querySelector("#omt-provider").value = cfg.translationProvider;
    if (cfg.panelCollapsed) root.classList.add("omt-panel-collapsed");
    applyPosition(cfg.panelPosition);

    root.querySelector("#omt-auto").addEventListener("change", (event) => {
      writeStore({ autoTranslate: event.target.checked });
      status(event.target.checked ? "正在扫描漫画……" : "自动识别已关闭");
    });
    root.querySelector("#omt-provider").addEventListener("change", (event) => {
      writeStore({ translationProvider: event.target.value });
      root.querySelector("#omt-dot-translation").dataset.state = STATE.UNKNOWN;
      setDot(root.querySelector("#omt-dot-translation"), STATE.UNKNOWN, "翻译未检测");
    });
    root.querySelector("#omt-connect").addEventListener("click", runConnectivityCheck);
    root.querySelector("#omt-select").addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "START_SELECT" }).catch(() => {});
    });
    root.querySelector("#omt-settings").addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "OPEN_OPTIONS" }).catch(() => {});
    });
    root.querySelector("#omt-collapse").addEventListener("click", () => setCollapsed(true));
    root.querySelector("#omt-widget").addEventListener("click", () => setCollapsed(false));

    const bar = root.querySelector("#omt-panel-bar");
    bar.addEventListener("pointerdown", startDrag);
    window.addEventListener("pointermove", moveDrag, { passive: true });
    window.addEventListener("pointerup", endDrag, { passive: true });

    // Nothing here runs on scroll or on DOM changes: the checks are one-shot at
    // load and on demand, which is all they need to be.
    checkBackend({ quiet: true }).then((ok) => {
      if (ok) checkTranslation(currentLine).catch(() => {});
    });

    return root;
  }

  return { mount, status, setDot, STATE, checkBackend, checkTranslation };
})();
