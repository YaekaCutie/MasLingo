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
  // The message line lives inside the panel and the collapsed widget mirrors
  // it, so this timer puts both back when a transient message has been up long
  // enough (see status()).
  let statusTimer = null;
  // Pending fade-out of the collapsed pill's "翻译成功" (see fadeWidgetToDefault).
  let widgetFadeTimer = null;
  // Re-measures the line's marquee after the panel expands or the window
  // resizes/zooms (see scheduleMarqueeResync).
  let marqueeResyncTimer = null;
  // Growing re-check delays, in ms. Capped at a minute so a long-lived page costs
  // one request a minute, not one a second.
  const BACKEND_RETRY_DELAYS = [3000, 6000, 12000, 25000, 45000, 60000];
  let backendRetryTimer = null;
  let backendRetryStep = 0;
  // Kept so the material engine can be told when the pane moves. The flat
  // engine keeps no measured geometry, but refresh() is still its contract for
  // "layout happened" and callers should not have to know that.
  let tracker = null;
  let dragging = null;
  // Where the panel sat before it was docked, so expanding puts it back rather
  // than dumping it in the stylesheet's default corner and losing the user's
  // arrangement. Null means it has never been positioned by hand.
  let lastFreePosition = null;
  let typing = null;
  // The failure the panel is holding until something succeeds (see status()).
  let stickyError = null;

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
  // The message is one line inside the panel, and the collapsed widget mirrors
  // it. These messages used to appear in a separate popup in the lower right
  // corner; that popup is gone — every progress line made a second floating
  // surface appear over the artwork, and the panel (or its widget, via the
  // mirror below) is already on screen wherever the text matters.
  //
  // While the panel is collapsed, the widget's dot and label are the whole
  // story; while it is expanded, the same text is readable inline.

  /**
   * The collapsed pill's short vocabulary.
   *
   * The pill has room for the state, not the story: "翻译失败" — never the
   * provider's 429 explanation, which belongs to the expanded panel and stays
   * there. Call sites that know their stage pass an explicit label; everything
   * else is classified here.
   */
  function shortLabelFor(text, kind, explicit = "") {
    if (explicit) return explicit;
    if (!text) return "自动翻译";
    if (kind === "ok" || /翻译完成|翻译成功/.test(text)) return "翻译成功";
    if (/已关闭/.test(text)) return "自动翻译";
    if (kind === "error") {
      if (/后端|引擎/.test(text)) return "后端未连通";
      if (/尚未选择翻译来源|翻译连接失败|未启用/.test(text)) return "翻译未连通";
      if (/翻译/.test(text)) return "翻译失败";
      return text.split(/[：，。（]/)[0].slice(0, 10);
    }
    if (/^正在检测/.test(text)) return "正在检测";
    if (/正在翻译/.test(text)) return "正在翻译中";
    if (/^正在(识别|扫描|OCR)|OCR/.test(text)) return "正在 OCR 中";
    if (/未启用/.test(text)) return "翻译未启用";
    if (/翻译/.test(text)) return "正在翻译中";
    return text.split(/[：，。（]/)[0].slice(0, 10);
  }

  /** Write the pill's label and busy state; a new label cancels any fade. */
  function mirrorWidget(text, busy) {
    const widgetText = root?.querySelector("#maslingo-widget-text");
    if (widgetFadeTimer) {
      clearTimeout(widgetFadeTimer);
      widgetFadeTimer = null;
    }
    if (widgetText) {
      widgetText.classList.remove("maslingo-widget-text-out");
      widgetText.textContent = text || "自动翻译";
    }
    if (root) root.dataset.busy = busy;
  }

  /** "翻译成功" fades out after three seconds, per the brief. */
  function fadeWidgetToDefault() {
    const widgetText = root?.querySelector("#maslingo-widget-text");
    if (!widgetText) return;
    widgetText.classList.add("maslingo-widget-text-out");
    if (widgetFadeTimer) clearTimeout(widgetFadeTimer);
    widgetFadeTimer = setTimeout(() => {
      widgetFadeTimer = null;
      widgetText.textContent = "自动翻译";
      widgetText.classList.remove("maslingo-widget-text-out");
      if (root) root.dataset.busy = "0";
    }, 260);
  }

  /**
   * One vocabulary for everything the panel reports, on one line.
   *
   * The sample sentence and the loading states share the line: "正在 OCR……"
   * replaces the sentence while it runs, and the sentence comes back when the
   * message expires.
   *
   *   error   replaces everything and does not expire. While it is held, later
   *           progress messages overlay it briefly and then it returns: a
   *           failure the user has not acted on keeps coming back until
   *           something resolves it (an "ok", or a successful check). It used
   *           to expire after a dwell, and the panel then looked idle while
   *           translation kept failing — reported as "stuck".
   *   ok      the failure is over; the confirmation shows briefly, then the
   *           sample sentence returns.
   *   info / working   progress, expiring after a dwell.
   */
  function status(text, kind = "info", short = "") {
    // Any message supersedes whatever was about to restore something.
    if (statusTimer) {
      clearTimeout(statusTimer);
      statusTimer = null;
    }

    if (kind === "error" && text) {
      stickyError = text;
      setLine(text, "error");
      // The pill keeps the state, not the story ("翻译失败", never the 429
      // explanation — that lives on the expanded panel's line).
      mirrorWidget(shortLabelFor(text, "error", short), "2");
      return;
    }

    if (kind === "ok") stickyError = null;

    // What the pill goes back to when a transient message expires: a held
    // failure if there is one, otherwise idle.
    const restWidget = () => {
      if (stickyError) mirrorWidget(shortLabelFor(stickyError, "error"), "2");
      else mirrorWidget("自动翻译", "0");
    };

    if (!text) {
      restoreLine();
      restWidget();
      return;
    }

    setLine(text, kind);
    const label = shortLabelFor(text, kind, short);
    mirrorWidget(label, "1");
    // Success is a confirmation, not a state: three seconds, then it fades.
    if (label === "翻译成功") {
      statusTimer = setTimeout(() => {
        statusTimer = null;
        restoreLine();
        fadeWidgetToDefault();
      }, 3000);
      return;
    }
    statusTimer = setTimeout(() => {
      statusTimer = null;
      restoreLine();
      restWidget();
    }, 4200);
  }

  /**
   * What the line shows when nothing transient is being said: the held failure
   * if there is one, otherwise a fresh sample sentence.
   */
  function restoreLine() {
    if (stickyError) {
      setLine(stickyError, "error");
      return;
    }
    currentLine = pickLine();
    setLine(`「${currentLine}」`);
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

  /** Cancel typing in flight so a written result cannot be overwritten. */
  function cancelLineTyping() {
    if (typing) {
      clearInterval(typing.interval);
      typing.resolve();
      typing = null;
    }
  }

  /**
   * Write the one-liner whole, with an optional tint.
   *
   * Connectivity failures land here rather than in the status row: the check
   * used to write a short "翻译连接失败" here and the full reason there, which
   * read as the same message twice. Errors also arrive at once instead of
   * typing out character by character — the reason is long, and watching it
   * type would be theatre.
   */
  function setLine(text, kind = "") {
    const node = root?.querySelector("#maslingo-line");
    const textNode = root?.querySelector("#maslingo-line-text");
    if (!node || !textNode) return;
    // Repeating the same message must not restart the line's marquee either —
    // auto.js writes the same failure once per failing picture.
    if (node.dataset.kind === kind && textNode.textContent === text) return;
    cancelLineTyping();
    node.dataset.kind = kind;
    // The dot marks a message; the idle sample sentence has none.
    const dot = root?.querySelector("#maslingo-line-dot");
    if (dot) dot.hidden = !kind;
    textNode.textContent = text;
    syncMarquee(node, node.querySelector(".maslingo-line-clip"), textNode);
  }

  /** Whether the user asked for less motion; a marquee is exactly that. */
  function prefersReducedMotion() {
    try {
      return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch {
      return false;
    }
  }

  /**
   * Start the horizontal marquee when the text is wider than its box.
   *
   * The panel is 268px wide; a full connectivity-failure reason is not.
   * Ellipsis hides exactly the part that says what to do, so overflowing text
   * scrolls instead: out to the end, pause, back to the start, pause, repeat.
   * The distance and duration depend on the text and are written here; reduced
   * motion keeps the ellipsis rather than animating.
   *
   * The move is a `transform` on the text layer inside a stationary clipping
   * window. `text-indent` was tried and moved the glyphs too, but it is a
   * layout property: every frame re-shaped the line on the main thread and the
   * scroll visibly stuttered ("一卡一卡的"). A transform is composited, and the
   * window — the element that sits next to the status dot — never moves, so
   * the old overlap cannot come back either.
   */
  function syncMarquee(container, windowNode, moveNode) {
    if (!container || !windowNode || !moveNode) return;
    // Measured from the clipped state: with the scrolling class still on, the
    // box is already content-sized and the overflow would read as zero.
    container.classList.remove("maslingo-scrolling");
    moveNode.style.removeProperty("--maslingo-marquee-distance");
    moveNode.style.removeProperty("--maslingo-marquee-duration");
    if (container.hidden || !container.clientWidth) return;
    if (prefersReducedMotion()) return;
    const overflow = moveNode.scrollWidth - windowNode.clientWidth;
    if (overflow <= 2) return;
    const distance = overflow + 10;
    moveNode.style.setProperty("--maslingo-marquee-distance", `${distance}px`);
    // About 38px/s of travel; the keyframes spend a fifth of the cycle paused.
    // The generous ceiling matters: a long reason deserves a calm crawl rather
    // than a speed-up, so only absurdly long text is capped at all.
    const duration = Math.min(28, Math.max(5, (distance * 2) / 38 / 0.8));
    moveNode.style.setProperty("--maslingo-marquee-duration", `${duration.toFixed(2)}s`);
    container.classList.add("maslingo-scrolling");
  }

  /**
   * Re-measure the line's marquee after the layout it was measured in changes.
   *
   * Two cases need this: the panel expanding (its bands are 0fr while folded,
   * so a message written then was measured against a zero-width line), and a
   * window resize — including browser zoom, which shifts glyph advance widths
   * slightly, so a distance measured at one zoom level can clip the tail or
   * overshoot at another. Debounced because resizes arrive in bursts.
   */
  function scheduleMarqueeResync(delay = 250) {
    if (marqueeResyncTimer) clearTimeout(marqueeResyncTimer);
    marqueeResyncTimer = setTimeout(() => {
      marqueeResyncTimer = null;
      const node = root?.querySelector("#maslingo-line");
      const textNode = root?.querySelector("#maslingo-line-text");
      if (node && textNode && textNode.textContent) {
        syncMarquee(node, node.querySelector(".maslingo-line-clip"), textNode);
      }
    }, delay);
  }

  // --- checks ---------------------------------------------------------------

  /**
   * Is the OCR backend reachable?
   *
   * Called on load, after a re-check, and on a backoff when it fails. A failure
   * is reported as a short sentence, never as a stack or a raw body — the people
   * reading this are reading manga.
   */
  async function checkBackend({ quiet = false, retry = true } = {}) {
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
      backendRetryStep = 0;
      if (backendRetryTimer) {
        clearTimeout(backendRetryTimer);
        backendRetryTimer = null;
      }
      // The pill may be reporting the engine was down; it recovers with it.
      const widgetText = root.querySelector("#maslingo-widget-text");
      if (widgetText && widgetText.textContent === "后端未连通") {
        mirrorWidget("自动翻译", "0");
      }
      return true;
    }

    setDot(dot, STATE.BAD, "后端未连通");
    // Engine down is a state the collapsed pill should carry, even though the
    // mount-time check is quiet: "后端未连通" is in the pill's vocabulary.
    const widgetText = root.querySelector("#maslingo-widget-text");
    if (widgetText && widgetText.textContent === "自动翻译") {
      mirrorWidget("后端未连通", "2");
    }
    if (!quiet) {
      // Says what to do, not just what is wrong. The common case is a browser
      // that was open before the engine was installed, so "未启用" on its own
      // reads as a dead end.
      status("本地引擎未连接 —— 确认 MasLingo 引擎正在运行，稍候会自动重连", "error");
    }
    if (retry) scheduleBackendRetry();
    return false;
  }

  /**
   * Re-check on a growing delay until the backend answers.
   *
   * The engine and the browser are started independently — the engine at login,
   * Chrome whenever the user opens it — so "not connected yet" is a normal state
   * that resolves itself, and a page reload should not be how the user finds out.
   * The delay grows so this is never a tight poll: §五 requires a timeout and a
   * backoff rather than high-frequency polling, and a page left open all day must
   * not sit there issuing a request every second.
   */
  function scheduleBackendRetry() {
    if (backendRetryTimer) return;
    const delay = BACKEND_RETRY_DELAYS[
      Math.min(backendRetryStep, BACKEND_RETRY_DELAYS.length - 1)
    ];
    backendRetryStep += 1;
    backendRetryTimer = setTimeout(() => {
      backendRetryTimer = null;
      checkBackend({ quiet: true }).catch(() => {});
    }, delay);
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
      "translationModelProvider", "translationApiKey", "translationAppId", "targetLanguage",
      "translationStrength",
    ]);
    // On the AI page the check runs against the draft — testing what 保存 would
    // write, not what is still stored.
    const overrides = aiPageOpen() ? {
      translationProvider: selectedProvider()?.id || cfg.translationProvider,
      translationStrength: draft.strength,
      translationModel: draft.model,
      translationModelProvider: draft.modelOwner,
      ...(draft.key ? { translationApiKey: draft.key } : {}),
    } : {};
    const effective = { ...cfg, ...overrides };

    let result;
    try {
      result = await chrome.runtime.sendMessage({
        type: "TEST_PROVIDER",
        text,
        cfg: {
          ...effective,
          translationProvider: effective.translationProvider || currentProviderId(),
        },
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
    // The check runs from the provider row (main page) or the key row (AI
    // page); whichever button started it is held down while it runs. The
    // provider row's button reads 配置 on the AI page's providers and never
    // gets here in that state.
    const button = aiPageOpen()
      ? root.querySelector("#maslingo-connect-ai")
      : root.querySelector("#maslingo-connect");
    const line = root.querySelector("#maslingo-line");
    if (!button || button.disabled) return;
    button.disabled = true;
    button.textContent = "检测中…";

    try {
      status("正在检测翻译连通……", "info", "正在检测");
      const backendOk = await checkBackend({ quiet: true });
      if (!backendOk) {
        // One line, and it stays: errors live on the one-liner until something
        // succeeds (see status()).
        status("后端未连接：确认 MasLingo 引擎正在运行", "error");
        return;
      }

      const source = currentLine;
      const result = await checkTranslation(source);
      if (result.ok) {
        // The check worked, so whatever failure the panel was holding is over.
        stickyError = null;
        const textNode = root.querySelector("#maslingo-line-text");
        line.dataset.kind = "";
        const dot = root.querySelector("#maslingo-line-dot");
        if (dot) dot.hidden = true;
        await typeInto(textNode, result.translated);
        syncMarquee(line, line.querySelector(".maslingo-line-clip"), textNode);
        // The translation is the evidence; it gives way to the sample sentence
        // like every other transient message (and a later check supersedes it,
        // because status() clears this timer).
        mirrorWidget("翻译成功", "1");
        if (statusTimer) clearTimeout(statusTimer);
        statusTimer = setTimeout(() => {
          statusTimer = null;
          restoreLine();
          fadeWidgetToDefault();
        }, 3000);
      } else {
        // The whole reason, on the line that was already there, and it stays
        // until resolved.
        status(`翻译连接失败：${result.reason}`, "error");
      }
    } finally {
      button.disabled = false;
      button.textContent = "连通检测";
    }
  }

  // --- dragging -------------------------------------------------------------

  function applyPosition(position) {
    if (!position) return;
    // Docking and free positioning are mutually exclusive states.
    //
    // The docked pill is anchored by right/bottom; writing left/top here tore
    // it out of the corner while it kept the docked class, which showed up two
    // ways: after any window resize (the resize handler re-applies a position
    // for the pill), and on a reload where a stored free position met the
    // restored-collapsed state — the pill and the status surface then sat on
    // top of each other in the same corner. `undock()` removes the class before
    // calling this, so expanding still returns to the user's own position.
    if (root.classList.contains("maslingo-panel-docked")) return;
    root.style.left = `${position.left}px`;
    root.style.top = `${position.top}px`;
    root.style.right = "auto";
    root.style.bottom = "auto";
    // Any in-flight drag offset is meaningless once an absolute position is
    // committed; left/top now carries it.
    root.style.transform = "";
    tracker?.refresh?.();
  }

  /** How much of the pane must stay on screen for it to be grabbable again. */
  const REACHABLE_MARGIN = 24;

  /**
   * Pull the pane back only when it is entirely off screen.
   *
   * The position limit is gone: the panel may be dragged anywhere, including
   * partly past an edge, and it stays exactly where it was dropped across
   * reloads and resizes. What must not happen is the pane becoming completely
   * unreachable — a stored position from a larger monitor, or a window shrunk
   * around it, used to leave it mounted but invisible, which reads as "the
   * panel disappeared". This is the one correction that remains, and it only
   * acts when none of the pane is on screen; it then brings the whole pane
   * back into view, since the position it was given cannot be honoured anyway
   * and a rescued sliver would leave the buttons out of reach.
   */
  function keepReachable() {
    if (!root) return;
    const rect = root.getBoundingClientRect();
    const margin = REACHABLE_MARGIN;
    const offscreen =
      rect.right < margin || rect.bottom < margin ||
      rect.left > window.innerWidth - margin || rect.top > window.innerHeight - margin;
    if (!offscreen) return;
    applyPosition({
      left: Math.round(Math.min(Math.max(rect.left, margin), window.innerWidth - rect.width - margin)),
      top: Math.round(Math.min(Math.max(rect.top, margin), window.innerHeight - rect.height - margin)),
    });
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
    // No clamp: the pane follows the pointer even past the window edges. Only a
    // complete disappearance is corrected (see keepReachable), and a pointer
    // drag cannot produce one because the pointer itself stays on screen.
    dragging.x = event.clientX - dragging.dx - dragging.originLeft;
    dragging.y = event.clientY - dragging.dy - dragging.originTop;
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
    // Store the committed numbers, not a fresh rect. The settle animation is
    // about to start at `transform: scale(.986)` with `transform-origin: 100%
    // 100%`, and reading getBoundingClientRect here forces the style flush that
    // applies that keyframe — so the saved position would be the *scaled* box,
    // roughly 4px right and 5px down, and the panel would reappear offset after
    // the next reload.
    const committed = {
      left: Math.round(originLeft + x),
      top: Math.round(originTop + y),
    };
    writeStore({ [POSITION_KEY]: committed });
    // Kept so that expanding a docked pill returns the panel to where the user
    // actually put it, instead of to the stylesheet's default corner.
    lastFreePosition = committed;
    // Lifts back with a short overshoot instead of snapping straight.
    globalThis.MAS_glass?.settle?.(root);
  }

  window.addEventListener("resize", () => {
    if (!root) return;
    // A drag in flight is measured against an origin captured before the resize,
    // so continuing it would move the pane by however far it had already
    // travelled. Settle it where it stands.
    if (dragging) endDrag();
    // Free placement: a resize leaves the pane exactly where it is. The only
    // correction is the failsafe for a pane the resize left entirely off screen.
    keepReachable();
    // Zoom and window resizes change how wide the text lays out; the marquee's
    // measured distance has to follow (a distance from the previous zoom can
    // clip the tail or overshoot).
    scheduleMarqueeResync();
  }, { passive: true });

  // --- collapse -------------------------------------------------------------

  /** Distance the docked pill keeps from the window corner. */
  const DOCK_INSET = 14;

  /**
   * Park the collapsed pill in the bottom-right corner.
   *
   * Collapsed, the panel is a 150×37 capsule with no drag handle's worth of
   * surface and no reason to be anywhere in particular — leaving it wherever it
   * was last dragged means it ends up mid-page, half over the artwork, and the
   * user has to hunt for it. Docking it to the corner is what "regular" should
   * mean for a collapsed control.
   *
   */
  function dockCollapsed() {
    root.classList.add("maslingo-panel-docked");
    root.style.left = "auto";
    root.style.top = "auto";
    root.style.right = `${DOCK_INSET}px`;
    root.style.bottom = `${DOCK_INSET}px`;
    root.style.transform = "";
    tracker?.refresh?.();
  }

  /** Hand the panel back to the user's own position, or to the default corner. */
  function undock() {
    root.classList.remove("maslingo-panel-docked");
    if (lastFreePosition) {
      applyPosition(lastFreePosition);
    } else {
      // Never dragged: back to the stylesheet's own anchoring.
      root.style.left = "";
      root.style.top = "";
      root.style.right = "";
      root.style.bottom = "";
      tracker?.refresh?.();
    }
  }

  function setCollapsed(collapsed) {
    // One call flips the class every material layer reads through
    // --maslingo-morph, and picks the longer expand curve (§20). Keeping it in
    // MAS_glass means the collapse timing and the shape live together.
    globalThis.MAS_glass?.setMorph?.(root, collapsed);
    if (collapsed) {
      dockCollapsed();
    } else {
      undock();
    }
    writeStore({ [COLLAPSED_KEY]: collapsed });
    // Marquee measurements need a laid-out line; while the panel is folded the
    // bands are 0fr, so a message written then never starts scrolling. Re-measure
    // once the morph has settled, so a persistent error scrolls after expanding.
    if (!collapsed) scheduleMarqueeResync(600);
    // The meteors are an on-screen effect; a folded panel has nothing to show
    // them on, and an emitter in a hidden panel is pure waste.
    if (collapsed) stopMeteors();
    else scheduleMeteors();
  }

  // --- markup ---------------------------------------------------------------

  let currentLine = "";

  function build() {
    const node = document.createElement("div");
    node.id = "maslingo-panel";
    // `maslingo-surface` supplies the host-reset defences and the typography;
    // the acrylic base and its border sit underneath, the content above them.
    node.className = "maslingo-panel maslingo-surface";
    node.dataset.state = "idle";
    // Each band is wrapped in a grid row so collapsing can animate the height.
    // There is no `display:none` anywhere in the collapsed state: the panel
    // changes shape continuously instead of swapping between two layouts.
    node.innerHTML = `
      <div class="maslingo-glass__base" aria-hidden="true"></div>
      <div class="maslingo-glass__edge" aria-hidden="true"></div>

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

            <div class="maslingo-basic maslingo-fold"><div class="maslingo-fold-in">
              <div class="maslingo-row">
                <span class="maslingo-label" id="maslingo-auto-label">自动识别</span>
                <label class="maslingo-switch" aria-labelledby="maslingo-auto-label">
                  <input id="maslingo-auto" type="checkbox" aria-labelledby="maslingo-auto-label">
                  <span class="maslingo-switch-track"><span class="maslingo-switch-thumb"></span></span>
                </label>
              </div>
              <button class="maslingo-btn" id="maslingo-select">框选翻译</button>
            </div></div>

            <div class="maslingo-rule" id="maslingo-rule-top"></div>

            <div class="maslingo-provider maslingo-fold"><div class="maslingo-fold-in">
              <div class="maslingo-label" id="maslingo-provider-label">翻译类型</div>
              <div class="maslingo-row maslingo-row-tight">
                <select id="maslingo-provider" class="maslingo-select" aria-labelledby="maslingo-provider-label"></select>
                <button class="maslingo-btn maslingo-btn-small" id="maslingo-connect">连通检测</button>
              </div>
            </div></div>

            <div class="maslingo-strength-fold maslingo-fold"><div class="maslingo-fold-in">
                <div class="maslingo-strength" id="maslingo-strength" data-level="0">
                  <div class="maslingo-strength-level">
                    <span id="maslingo-strength-name">Low</span>
                    <span class="maslingo-strength-hint" id="maslingo-strength-hint">不联网轻度润色</span>
                  </div>
                  <div class="maslingo-strength-modelrow" id="maslingo-strength-modelrow">
                    <button class="maslingo-strength-model" id="maslingo-strength-model" type="button"
                            aria-haspopup="listbox" aria-expanded="false" title="选择具体模型">
                      <span id="maslingo-strength-model-name">—</span>
                      <span class="maslingo-strength-chevron" aria-hidden="true">›</span>
                    </button>
                  </div>
                  <div class="maslingo-strength-slider" id="maslingo-strength-slider" role="slider" tabindex="0"
                       aria-label="反应强度" aria-valuemin="0" aria-valuemax="2" aria-valuenow="0" aria-valuetext="Low">
                    <div class="maslingo-strength-track">
                      <div class="maslingo-strength-fill" aria-hidden="true"></div>
                      <span class="maslingo-strength-dot" data-stop="0" aria-hidden="true"></span>
                      <span class="maslingo-strength-dot" data-stop="1" aria-hidden="true"></span>
                      <span class="maslingo-strength-dot" data-stop="2" aria-hidden="true"></span>
                      <span class="maslingo-strength-thumb" aria-hidden="true"></span>
                    </div>
                  </div>
                </div>
            </div></div>

            <div class="maslingo-rule" id="maslingo-rule-ai"></div>

            <div class="maslingo-key maslingo-fold"><div class="maslingo-fold-in">
              <label class="maslingo-label" id="maslingo-ai-key-label" for="maslingo-ai-key">API Key</label>
              <div class="maslingo-row maslingo-row-tight">
                <input id="maslingo-ai-key" class="maslingo-input" type="password" autocomplete="off" spellcheck="false" aria-labelledby="maslingo-ai-key-label">
                <button class="maslingo-btn maslingo-btn-small" id="maslingo-connect-ai">连通检测</button>
              </div>
            </div></div>

            <div class="maslingo-line" id="maslingo-line" role="status" aria-live="polite"><span class="maslingo-line-dot" id="maslingo-line-dot" aria-hidden="true" hidden></span><span class="maslingo-line-clip"><span class="maslingo-line-text" id="maslingo-line-text"></span></span><span class="maslingo-source" id="maslingo-source"></span></div>

            <div class="maslingo-modelbox" id="maslingo-modelbox" role="listbox" aria-label="具体模型" hidden></div>

            <div class="maslingo-rule" id="maslingo-rule-foot"></div>
            <div class="maslingo-foot">
              <button class="maslingo-link maslingo-main-only" id="maslingo-settings">⚙ 设置</button>
              <span class="maslingo-version maslingo-main-only" id="maslingo-version"></span>
              <button class="maslingo-link maslingo-ai-only" id="maslingo-ai-cancel">取消</button>
              <button class="maslingo-save maslingo-ai-only" id="maslingo-ai-save">保存</button>
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
    // Grouped the way the settings page groups them: "AI 大模型" has to be
    // findable, because picking anything in that group is what switches the
    // panel into AI mode (see openAiPage).
    const groups = new Map();
    for (const provider of registry.list) {
      if (!groups.has(provider.group)) groups.set(provider.group, []);
      groups.get(provider.group).push(provider);
    }
    for (const [group, items] of groups) {
      const optgroup = document.createElement("optgroup");
      optgroup.label = group;
      for (const provider of items) {
        const option = document.createElement("option");
        option.value = provider.id;
        option.textContent = provider.id === "none"
          ? "不翻译（只识别）"
          : provider.label.replace(/（.*?）/g, "");
        optgroup.append(option);
      }
      select.append(optgroup);
    }
  }

  // --- AI mode --------------------------------------------------------------
  //
  // The brief: while an "AI 大模型" source is selected, the panel folds away
  // 自动识别 / 框选翻译 (they fade out upward), 翻译类型 and the 一言 line ride
  // up into the space that just closed, and API Key + 反应强度 fade in from
  // below. All of the movement is CSS (grid rows + transform/opacity, the same
  // mechanism as collapse); this side only flips one class and keeps the two
  // modules' text in sync.
  //
  // The panel is two pages sharing one fixed-size window (窗口大小永远不变).
  // The main page holds 自动识别 / 框选翻译 / 翻译类型; choosing an "AI 大模型"
  // source navigates to the AI page — 反应强度 on top, a divider, API Key
  // below — whose footer is 取消 / 保存 instead of 设置 / version. The AI page
  // is a draft: the slider, the model picker and the key are only written when
  // 保存 is pressed, and either button returns to the main page (返回上一页)。

  const AI_GROUP = "AI 大模型";
  // Half the thumb, matching --maslingo-strength-* in window.css: the travel
  // of the slider is the track minus one thumb, inset by half a thumb each end.
  const STRENGTH_THUMB_HALF = 11;
  // Three stops: Low / High / Max. There is no Off — an AI source always
  // translates, and Low is light polish without web lookup.
  const STRENGTH_MAX = 2;
  // The picker's "type it yourself" entry; choosing it opens the settings page.
  const CUSTOM_MODEL = "__custom__";

  // What storage says (the main page's truth) —
  let storedStrength = 0;
  let modelOverride = "";
  let modelOverrideOwner = "";
  let keySaved = false;
  // — and what the page currently shows: the draft while the AI page is open.
  let strengthValue = 0;
  const draft = {
    strength: 0, model: "", modelOwner: "", key: "",
  };

  function selectedProvider() {
    const id = root?.querySelector("#maslingo-provider")?.value || "";
    return globalThis.MAS_providers?.byId?.(id) || null;
  }

  const isAiProvider = (provider) => Boolean(provider && provider.group === AI_GROUP);
  const aiPageOpen = () => Boolean(root?.classList.contains("maslingo-panel-ai"));

  /** The small grey 来源 note at the right end of the message line. */
  function renderSourceHint() {
    const node = root?.querySelector("#maslingo-source");
    if (!node) return;
    const provider = selectedProvider();
    const label = !provider ? ""
      : provider.id === "none" ? "不翻译"
      : provider.label.replace(/（.*?）/g, "");
    node.textContent = label ? `来源 · ${label}` : "";
  }

  /** The provider row's button: 配置 on the main page for AI sources, else the
   *  connectivity check. (The AI page carries its own 连通检测 beside the key,
   *  and it tests the draft rather than what is stored.) */
  function syncConnectButton() {
    const button = root?.querySelector("#maslingo-connect");
    if (!button) return;
    const ai = isAiProvider(selectedProvider());
    button.textContent = ai ? "配置" : "连通检测";
    button.title = ai ? "打开 AI 翻译配置（API Key 与反应强度）" : "";
    button.dataset.action = ai ? "configure" : "check";
  }

  /** Snapshot storage into the draft and show the AI page. */
  function openAiPage() {
    const provider = selectedProvider();
    if (!isAiProvider(provider)) return;
    draft.strength = storedStrength;
    draft.model = globalThis.MAS_providers?.resolveModel?.(provider, {
      translationModel: modelOverride,
      translationModelProvider: modelOverrideOwner,
    }) || "";
    draft.modelOwner = provider.id;
    draft.key = "";
    const input = root.querySelector("#maslingo-ai-key");
    if (input) input.value = "";
    renderStrength(draft.strength);
    renderModelBox();
    renderKeyPlaceholder();
    root.classList.add("maslingo-panel-ai");
    scheduleMeteors();
    tracker?.refresh?.();
  }

  /** Leave the AI page: 保存 writes the draft, 取消 leaves storage alone, and
   *  both return to the main page. */
  function closeAiPage({ save = false, quiet = false } = {}) {
    const provider = selectedProvider();
    if (aiPageOpen() && save && provider) {
      const values = {
        translationStrength: draft.strength,
        translationModel: draft.model,
        translationModelProvider: provider.id,
      };
      if (draft.key) values.translationApiKey = draft.key;
      writeStore(values);
      storedStrength = draft.strength;
      modelOverride = draft.model;
      modelOverrideOwner = provider.id;
      if (draft.key) keySaved = true;
      setDot(root.querySelector("#maslingo-dot-translation"), STATE.UNKNOWN, "翻译未检测");
    }
    draft.key = "";
    const input = root.querySelector("#maslingo-ai-key");
    if (input) input.value = "";
    renderStrength(storedStrength);
    root.classList.remove("maslingo-panel-ai");
    stopMeteors();
    renderKeyPlaceholder();
    if (!quiet) status(save ? "已保存" : "已取消", save ? "ok" : "info");
    tracker?.refresh?.();
  }

  /**
   * The concrete model under the level name — the brief's "max 下面是选择具体
   * 模型". The row shows the model's own name (DeepSeek V4.1 Flash), and
   * clicking it opens the 选择框: the provider's curated models plus whatever
   * override is in storage (so a hand-typed id stays selectable), plus 自定义…
   * for providers whose id is typed in the settings page. The box is an
   * absolutely positioned listbox inside the fixed-size window, so opening it
   * cannot resize the panel the way an inline list would.
   */
  let modelBoxOpen = false;

  function setModelBox(open) {
    const box = root?.querySelector("#maslingo-modelbox");
    const trigger = root?.querySelector("#maslingo-strength-model");
    if (!box || !trigger) return;
    modelBoxOpen = Boolean(open);
    box.hidden = !modelBoxOpen;
    trigger.setAttribute("aria-expanded", modelBoxOpen ? "true" : "false");
    trigger.classList.toggle("maslingo-strength-model-open", modelBoxOpen);
    if (!modelBoxOpen) return;
    // Anchor the box under the model row, in body coordinates (the body is the
    // positioned ancestor), so nothing above it moves.
    const body = root.querySelector(".maslingo-panel-body");
    const row = root.querySelector("#maslingo-strength-modelrow");
    if (!body || !row) return;
    box.style.top = `${Math.round(row.getBoundingClientRect().bottom
      - body.getBoundingClientRect().top + 6)}px`;
  }

  /** Rebuild the trigger label and the 选择框's options from the draft. */
  function renderModelBox() {
    const box = root?.querySelector("#maslingo-modelbox");
    const trigger = root?.querySelector("#maslingo-strength-model");
    if (!box || !trigger) return;
    const provider = selectedProvider();
    const effective = globalThis.MAS_providers?.resolveModel?.(provider, {
      translationModel: aiPageOpen() ? draft.model : modelOverride,
      translationModelProvider: aiPageOpen() ? draft.modelOwner : modelOverrideOwner,
    }) || "";
    const models = globalThis.MAS_providers?.modelsOf?.(provider) || [];
    if (effective && !models.some((model) => model.id === effective)) {
      models.unshift({ id: effective, label: effective });
    }
    if (!models.length) models.push({ id: "", label: "默认模型" });
    box.textContent = "";
    for (const model of models) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "maslingo-modelbox-item";
      item.dataset.model = model.id;
      item.setAttribute("role", "option");
      const selected = model.id === effective;
      item.setAttribute("aria-selected", selected ? "true" : "false");
      if (selected) item.classList.add("maslingo-modelbox-item-on");
      const name = document.createElement("span");
      name.className = "maslingo-modelbox-name";
      name.textContent = model.label || "默认模型";
      item.append(name);
      if ((model.label || "") !== model.id) {
        const id = document.createElement("span");
        id.className = "maslingo-modelbox-id";
        id.textContent = model.id;
        item.append(id);
      }
      box.append(item);
    }
    // Providers whose model id is typeable in the settings page get the escape
    // hatch; providers with a closed model set (Gemini's adapter takes no free
    // model field there either) do not offer one they cannot honour.
    if (provider?.modelEditable) {
      const custom = document.createElement("button");
      custom.type = "button";
      custom.className = "maslingo-modelbox-item maslingo-modelbox-custom";
      custom.dataset.model = CUSTOM_MODEL;
      custom.setAttribute("role", "option");
      custom.setAttribute("aria-selected", "false");
      custom.textContent = "自定义…";
      box.append(custom);
    }
    const shown = models.find((model) => model.id === effective) || models[0];
    trigger.dataset.model = shown.id;
    const name = root.querySelector("#maslingo-strength-model-name");
    if (name) name.textContent = shown.label || "默认模型";
  }

  /** Clicking the row opens the 选择框; picking inside updates the draft. */
  function mountModelBox() {
    const trigger = root.querySelector("#maslingo-strength-model");
    const box = root.querySelector("#maslingo-modelbox");
    if (!trigger || !box) return;
    trigger.addEventListener("click", () => setModelBox(!modelBoxOpen));
    box.addEventListener("click", (event) => {
      const item = event.target.closest(".maslingo-modelbox-item");
      if (!item) return;
      const value = item.dataset.model;
      if (value === CUSTOM_MODEL) {
        // There is no room for a free-text field in a 268px panel; the
        // settings page has one, and this opens it. The page closes first so
        // the model typed there is not overwritten by this draft on 保存.
        setModelBox(false);
        closeAiPage({ quiet: true });
        chrome.runtime.sendMessage({ type: "OPEN_OPTIONS" }).catch(() => {});
        return;
      }
      draft.model = value;
      draft.modelOwner = selectedProvider()?.id || "";
      renderModelBox();
      setModelBox(false);
    });
    // Click-away and Escape close it; the listeners sit on the document so the
    // box also closes when the page underneath is clicked.
    document.addEventListener("pointerdown", (event) => {
      if (!modelBoxOpen) return;
      if (event.target.closest?.(".maslingo-strength-modelrow")) return;
      if (event.target.closest?.("#maslingo-modelbox")) return;
      setModelBox(false);
    }, true);
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && modelBoxOpen) setModelBox(false);
    });
  }

  /** Never renders a saved key — only whether one exists. */
  function renderKeyPlaceholder() {
    const input = root?.querySelector("#maslingo-ai-key");
    if (!input) return;
    const provider = selectedProvider();
    input.placeholder = keySaved
      ? "已保存，输入新值可替换"
      : (provider?.keyRequired ? "粘贴 API Key" : "无需密钥，可留空");
  }

  function renderStrength(value = strengthValue) {
    strengthValue = globalThis.MAS_providers?.normalizeStrength?.(value) ?? 0;
    const wrap = root?.querySelector("#maslingo-strength");
    if (!wrap) return;
    wrap.dataset.level = String(strengthValue);
    wrap.style.setProperty("--maslingo-strength-p", String(strengthValue / STRENGTH_MAX));
    const label = globalThis.MAS_providers?.strengthLabel?.(strengthValue) || "";
    const name = root.querySelector("#maslingo-strength-name");
    if (name) name.textContent = label;
    const hint = root.querySelector("#maslingo-strength-hint");
    if (hint) hint.textContent = globalThis.MAS_providers?.strengthHint?.(strengthValue) || "";
    const slider = root.querySelector("#maslingo-strength-slider");
    if (slider) {
      slider.setAttribute("aria-valuenow", String(strengthValue));
      slider.setAttribute("aria-valuetext", label);
    }
    scheduleMeteors();
  }

  function setStrength(value) {
    const next = globalThis.MAS_providers?.normalizeStrength?.(value) ?? 0;
    if (next === strengthValue) return;
    draft.strength = next;
    renderStrength(next);
  }

  /** Pointer + keyboard on the strength slider (role="slider", arrow keys). */
  function mountStrengthSlider() {
    const slider = root.querySelector("#maslingo-strength-slider");
    if (!slider) return;
    const track = slider.querySelector(".maslingo-strength-track");
    const levelFromPointer = (event) => {
      const rect = track.getBoundingClientRect();
      const travel = Math.max(1, rect.width - STRENGTH_THUMB_HALF * 2);
      const x = event.clientX - rect.left - STRENGTH_THUMB_HALF;
      const p = Math.min(1, Math.max(0, x / travel));
      return Math.round(p * STRENGTH_MAX);
    };
    let dragging = false;
    slider.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      dragging = true;
      slider.dataset.dragging = "1";
      try {
        slider.setPointerCapture?.(event.pointerId);
      } catch {
        /* pointer already gone; the window listeners still carry the drag */
      }
      setStrength(levelFromPointer(event));
      event.preventDefault();
    });
    slider.addEventListener("pointermove", (event) => {
      if (!dragging) return;
      setStrength(levelFromPointer(event));
    });
    const endDrag = (event) => {
      if (!dragging) return;
      dragging = false;
      delete slider.dataset.dragging;
      try {
        slider.releasePointerCapture?.(event.pointerId);
      } catch {
        /* never captured */
      }
    };
    slider.addEventListener("pointerup", endDrag);
    slider.addEventListener("pointercancel", endDrag);
    slider.addEventListener("keydown", (event) => {
      const step = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 }[event.key];
      if (step !== undefined) {
        setStrength(strengthValue + step);
        event.preventDefault();
        return;
      }
      if (event.key === "Home") {
        setStrength(0);
        event.preventDefault();
      } else if (event.key === "End") {
        setStrength(STRENGTH_MAX);
        event.preventDefault();
      }
    });
  }

  /** API Key: held as a masked draft until 保存; Enter just leaves the field. */
  function mountKeyInput() {
    const input = root.querySelector("#maslingo-ai-key");
    if (!input) return;
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        input.blur();
      }
    });
    input.addEventListener("change", () => {
      draft.key = input.value.trim();
    });
  }

  // --- the meteors ----------------------------------------------------------
  //
  // The brief's dynamic effect: sparks leave the thumb and run left to the
  // stop behind it, fading out on arrival — and the stronger the level, the
  // faster and more frequent they are, scattered across the bar's full height
  // so the stream does not read as a single repeated line. The emitter only
  // runs while the AI page (and its slider) is actually on screen; reduced
  // motion turns it off entirely.
  const METEOR_SPECS = {
    // Level 0 (Low) sits at the left end, with no stop behind it to fly to and
    // nothing to show; High and Max get denser, faster streams.
    1: { interval: 700, duration: 620 },
    2: { interval: 320, duration: 380 },
  };
  let meteorTimer = null;

  function stopMeteors() {
    if (meteorTimer) {
      clearTimeout(meteorTimer);
      meteorTimer = null;
    }
  }

  function scheduleMeteors() {
    stopMeteors();
    if (prefersReducedMotion()) return;
    if (!aiPageOpen()) return;
    if (root.classList.contains("maslingo-panel-collapsed")) return;
    const spec = METEOR_SPECS[strengthValue];
    if (!spec) return;
    const tick = () => {
      spawnMeteor(spec);
      // Max fires a second spark often enough to read as a stream.
      if (strengthValue >= 2 && Math.random() < 0.65) {
        setTimeout(() => { if (aiPageOpen()) spawnMeteor(spec); }, 70 + Math.random() * 110);
      }
      // A little jitter keeps the cadence from reading as a metronome.
      meteorTimer = setTimeout(tick, spec.interval * (0.65 + Math.random() * 0.7));
    };
    meteorTimer = setTimeout(tick, 200 + Math.random() * spec.interval * 0.5);
  }

  /** One spark: from the thumb's centre to the centre of the stop behind it. */
  function spawnMeteor(spec) {
    if (!aiPageOpen()) return;
    const fill = root.querySelector(".maslingo-strength-fill");
    const track = root.querySelector(".maslingo-strength-track");
    if (!fill || !track || !fill.isConnected) return;
    const travel = Math.max(1, track.clientWidth - STRENGTH_THUMB_HALF * 2);
    const from = STRENGTH_THUMB_HALF + travel * (strengthValue / STRENGTH_MAX);
    const to = STRENGTH_THUMB_HALF + travel * ((strengthValue - 1) / STRENGTH_MAX);
    if (from - to < 24) return;
    const meteor = document.createElement("span");
    meteor.className = "maslingo-meteor";
    meteor.setAttribute("aria-hidden", "true");
    meteor.style.left = "0";
    // Spread across the bar's height, not a single lane (上下更密一点)。
    meteor.style.top = `${20 + Math.random() * 60}%`;
    meteor.style.width = `${7 + Math.random() * 9}px`;
    fill.appendChild(meteor);
    const run = meteor.animate(
      [
        { transform: `translate3d(${from}px, -50%, 0)`, opacity: 0 },
        { transform: `translate3d(${from - 16}px, -50%, 0)`, opacity: 0.9, offset: 0.15 },
        { transform: `translate3d(${to}px, -50%, 0)`, opacity: 0 },
      ],
      { duration: spec.duration * (0.85 + Math.random() * 0.3), easing: "ease-in" },
    );
    run.onfinish = () => meteor.remove();
    run.oncancel = () => meteor.remove();
  }

  // --- wiring ---------------------------------------------------------------

  async function mount() {
    if (root && root.isConnected) return root;
    root = build();
    document.documentElement.appendChild(root);
    // Storage resolves a few milliseconds after the node is live. Every state
    // derived from it — AI mode included — is applied with transitions off, so
    // the panel does not visibly fold/unfold on its first painted frame; the
    // class comes back off on the next frame.
    root.classList.add("maslingo-panel-instant");

    // The material engine: hover/drag states and the settle animation, bound
    // once. The flat material has no light to move, so nothing here schedules
    // frames.
    tracker = globalThis.MAS_glass?.track?.(root);

    currentLine = pickLine();
    root.querySelector("#maslingo-line-text").textContent = `「${currentLine}」`;
    root.querySelector("#maslingo-version").textContent =
      `v${chrome.runtime?.getManifest?.().version || ""}`;

    fillProviders();

    const cfg = await readStore([
      "autoTranslate", "translationProvider", "panelPosition", "panelCollapsed",
      "translationModel", "translationModelProvider", "translationApiKey",
      "translationStrength",
    ]);
    root.querySelector("#maslingo-auto").checked = Boolean(cfg.autoTranslate);
    if (cfg.translationProvider) root.querySelector("#maslingo-provider").value = cfg.translationProvider;
    modelOverride = cfg.translationModel || "";
    modelOverrideOwner = cfg.translationModelProvider || "";
    keySaved = Boolean(cfg.translationApiKey);
    storedStrength = globalThis.MAS_providers?.normalizeStrength?.(cfg.translationStrength) ?? 0;
    renderStrength(storedStrength);
    renderSourceHint();
    syncConnectButton();
    // An AI source lands on its page (no animation: the instant class is on).
    if (isAiProvider(selectedProvider())) openAiPage();
    // Through MAS_glass so the restored state arrives with the same class the
    // transition expects; setting it directly would skip the longer expand curve
    // and, on a restored collapse, run the collapse animation on first paint.
    if (cfg.panelCollapsed) {
      // The node was appended before storage resolved, so at least one frame
      // has already been painted expanded. Replaying the collapse transition
      // here is a visible flash, so the state is applied with transitions off
      // (see above) and handed back on the next frame (see below).
      globalThis.MAS_glass?.setMorph?.(root, true);
      dockCollapsed();
    }
    // Applied as saved, with one failsafe: a position from a much larger window
    // (or one the current window shrank out from under) may leave the pane
    // entirely off screen, mounted but unreachable. keepReachable() only moves
    // it back when none of it is visible.
    lastFreePosition = cfg.panelPosition
      ? { left: cfg.panelPosition.left, top: cfg.panelPosition.top }
      : null;
    applyPosition(cfg.panelPosition || null);
    keepReachable();
    requestAnimationFrame(() => root.classList.remove("maslingo-panel-instant"));

    root.querySelector("#maslingo-auto").addEventListener("change", (event) => {
      writeStore({ autoTranslate: event.target.checked });
      status(event.target.checked ? "正在扫描漫画……" : "自动识别已关闭");
    });
    root.querySelector("#maslingo-provider").addEventListener("change", (event) => {
      const providerId = event.target.value;
      writeStore({
        translationProvider: providerId,
        // Kept in step for the code paths that still read it — the same mapping
        // the options page writes. Switching provider here used to leave the
        // legacy mode behind, so a profile whose stored mode said "none" would
        // still be treated as translation-off after a provider was picked.
        translationMode: (providerId === "google-free" || providerId === "backend")
          ? "free-translate"
          : "openai-compatible",
      });
      root.querySelector("#maslingo-dot-translation").dataset.state = STATE.UNKNOWN;
      setDot(root.querySelector("#maslingo-dot-translation"), STATE.UNKNOWN, "翻译未检测");
      renderSourceHint();
      syncConnectButton();
      if (isAiProvider(selectedProvider())) openAiPage();
      else closeAiPage({ quiet: true });
    });
    root.querySelector("#maslingo-connect").addEventListener("click", (event) => {
      if (event.currentTarget.dataset.action === "configure") openAiPage();
      else runConnectivityCheck();
    });
    root.querySelector("#maslingo-connect-ai").addEventListener("click", runConnectivityCheck);
    root.querySelector("#maslingo-ai-save").addEventListener("click", () => closeAiPage({ save: true }));
    root.querySelector("#maslingo-ai-cancel").addEventListener("click", () => closeAiPage());
    mountKeyInput();
    mountStrengthSlider();
    mountModelBox();
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
    // A drag can end without a pointerup: a touch or pen can be cancelled by the
    // browser, a gesture can take over, or focus can be lost mid-drag (Alt+Tab
    // with the button held). Without these the pane kept `dragging` set, so every
    // later mouse move — button down or not — went on writing translate3d, the
    // grabbing cursor stayed applied, and the position was never stored.
    window.addEventListener("pointercancel", endDrag, { passive: true });
    window.addEventListener("blur", () => { if (dragging) endDrag(); });

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
          renderSourceHint();
          syncConnectButton();
          // The page follows the source, and a draft only makes sense for the
          // source it was taken for.
          if (aiPageOpen()) {
            if (isAiProvider(selectedProvider())) openAiPage();
            else closeAiPage({ quiet: true });
          }
        }
        if (changes.translationStrength) {
          storedStrength = globalThis.MAS_providers?.normalizeStrength?.(
            changes.translationStrength.newValue,
          ) ?? 0;
          // While the AI page is open its draft owns the slider; storage's
          // value is what 取消 restores to.
          if (!aiPageOpen()) renderStrength(storedStrength);
        }
        if (changes.translationModel) {
          modelOverride = changes.translationModel.newValue || "";
          if (!aiPageOpen()) renderModelBox();
        }
        if (changes.translationModelProvider) {
          modelOverrideOwner = changes.translationModelProvider.newValue || "";
          if (!aiPageOpen()) renderModelBox();
        }
        if (changes.translationApiKey) {
          keySaved = Boolean(changes.translationApiKey.newValue);
          renderKeyPlaceholder();
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
