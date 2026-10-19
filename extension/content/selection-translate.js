// Selection translation.
//
// Select a phrase and a small white card appears next to it with the
// translation. A single word asks the background worker for a dictionary
// entry instead: every common sense, its part of speech, an example, and the
// sense that fits the sentence on the page (highlighted in the card).
//
// The card is a plain <div> with a shadow root. The isolated world does not
// expose customElements, and a shadow root is what keeps a host page's global
// `div`, `button` and `*` rules from reshaping the popup.

(() => {
  "use strict";
  if (globalThis.MAS_selection?.installed) return;

  const MAX_TEXT = 200;
  const CACHE_TTL = 10 * 60 * 1000;
  const CACHE_MAX = 40;
  // A "word" for dictionary purposes: one unspaced token of up to eight
  // letters/characters. That covers 猫, 食べる, 朝ごはん and hello while a
  // selected phrase falls through to ordinary translation.
  const WORD_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}\p{M}'’\-・ー]{0,7}$/u;
  const OWN_UI = [
    "#maslingo-panel", "#maslingo-selection-popup", "[data-maslingo-textbox='1']",
    "#maslingo-layer", ".maslingo-overlay-text-canvas", "#maslingo-widget",
  ].join(", ");

  // Set by sync() after storage resolves; starting false means a fast selection
  // during startup cannot pop a "no provider" error before the check runs.
  let enabled = false;
  let host = null;
  let shadow = null;
  let body = null;
  let meta = null;
  let foot = null;
  let anchorRect = null;
  let currentJob = null;
  let timer = null;
  let seq = 0;
  let minimized = false;
  let targetLanguage = "简体中文";
  const cache = new Map();

  const readStore = (keys) => chrome.storage?.local?.get?.(keys).catch(() => ({}));

  function elementInOwnUi(node) {
    const element = node?.nodeType === 1 ? node : node?.parentElement;
    if (!element?.closest) return false;
    if (element.closest(OWN_UI)) return true;
    // A node inside our shadow root has a parent chain that ends at the shadow
    // boundary; `closest` cannot cross it on its own.
    const root = element.getRootNode?.();
    return Boolean(root?.host?.closest?.(OWN_UI));
  }

  function make(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function closePopup() {
    seq += 1;
    clearTimeout(timer);
    timer = null;
    host?.remove();
    host = null;
    shadow = null;
    body = null;
    meta = null;
    foot = null;
    anchorRect = null;
    currentJob = null;
    minimized = false;
  }

  function cardWidth() {
    return Math.max(220, Math.min(380, window.innerWidth - 24));
  }

  /**
   * Keep the card beside the selection and inside the viewport.
   *
   * It prefers the space below the selected line, flips above when that is too
   * tight, and finally clamps to the viewport with the card's own max-height and
   * scrolling handling anything taller than the window.
   */
  function placeCard() {
    if (!host || !anchorRect) return;
    const margin = 12;
    const gap = 9;
    const width = host.getBoundingClientRect().width || cardWidth();
    const left = Math.min(
      Math.max(anchorRect.left + anchorRect.width / 2 - width / 2, margin),
      Math.max(margin, window.innerWidth - width - margin),
    );
    host.style.left = `${Math.round(left)}px`;

    const height = host.getBoundingClientRect().height;
    let top = anchorRect.bottom + gap;
    if (top + height > window.innerHeight - margin) {
      const above = anchorRect.top - gap - height;
      top = above >= margin
        ? above
        : Math.max(margin, Math.min(anchorRect.top - gap, window.innerHeight - height - margin));
    }
    host.style.top = `${Math.round(top)}px`;
  }

  function setBody(node) {
    if (!body) return;
    body.replaceChildren(node);
    requestAnimationFrame(placeCard);
  }

  function setFooter(leftText, rightText = "Esc 关闭") {
    if (!foot) return;
    foot.replaceChildren();
    foot.append(
      make("span", "foot-left", leftText || ""),
      make("span", "foot-right", rightText),
    );
  }

  function createPopup() {
    host = document.createElement("div");
    host.id = "maslingo-selection-popup";
    host.style.position = "fixed";
    host.style.left = "12px";
    host.style.top = "12px";
    host.style.width = `${cardWidth()}px`;
    host.style.zIndex = "2147483647";
    host.style.display = "block";
    host.style.visibility = "hidden";

    shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        *, *::before, *::after { box-sizing: border-box; }
        .card {
          width: 100%;
          max-height: min(72vh, 560px);
          display: flex;
          flex-direction: column;
          overflow: hidden;
          border: 1px solid rgba(15, 23, 42, .14);
          border-radius: 12px;
          background: #ffffff;
          box-shadow: 0 14px 34px rgba(15, 23, 42, .18), 0 2px 7px rgba(15, 23, 42, .07);
          color: #1c1e21;
          font-family: "Noto Sans SC", "Microsoft YaHei", system-ui, -apple-system, sans-serif;
          font-size: 13px;
          line-height: 1.5;
          text-align: left;
          direction: ltr;
        }
        .head {
          flex: 0 0 auto;
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 9px 12px;
          border-bottom: 1px solid rgba(15, 23, 42, .07);
          background: #fafaf9;
        }
        .kicker {
          flex: 0 0 auto;
          font-size: 12px;
          font-weight: 600;
          letter-spacing: .02em;
          color: #1c1e21;
        }
        .meta {
          flex: 1 1 auto;
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          text-align: right;
          font-size: 10.5px;
          color: #8a8f98;
        }
        .close {
          flex: 0 0 auto;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 24px;
          height: 24px;
          margin: 0;
          padding: 0;
          border: 0;
          border-radius: 7px;
          background: transparent;
          color: #6b7280;
          font: 18px/1 system-ui, sans-serif;
          cursor: pointer;
        }
        .close:hover { background: rgba(15, 23, 42, .07); color: #1c1e21; }
        .min {
          flex: 0 0 auto;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 24px;
          height: 24px;
          margin: 0;
          padding: 0;
          border: 0;
          border-radius: 7px;
          background: transparent;
          color: #6b7280;
          font: 17px/1 system-ui, sans-serif;
          cursor: pointer;
        }
        .min:hover { background: rgba(15, 23, 42, .07); color: #1c1e21; }
        .mini {
          display: none;
          width: 38px;
          height: 38px;
          align-items: center;
          justify-content: center;
          border: 1px solid rgba(15, 23, 42, .16);
          border-radius: 50%;
          background: #ffffff;
          box-shadow: 0 6px 18px rgba(15, 23, 42, .18), 0 1px 4px rgba(15, 23, 42, .08);
          color: #1c1e21;
          font-family: "Noto Sans SC", "Microsoft YaHei", system-ui, sans-serif;
          font-size: 14px;
          font-weight: 650;
          line-height: 1;
          cursor: pointer;
        }
        :host(.minimized) .card { display: none; }
        :host(.minimized) .mini { display: inline-flex; }
        .body {
          flex: 1 1 auto;
          min-height: 0;
          overflow-y: auto;
          overscroll-behavior: contain;
          padding: 12px 14px 14px;
        }
        .loading {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 4px 0 6px;
          color: #6b7280;
          font-size: 12px;
        }
        .loading i {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: #9ca3af;
          animation: pulse 1s ease-in-out infinite;
        }
        .loading i:nth-child(2) { animation-delay: .15s; }
        .loading i:nth-child(3) { animation-delay: .3s; }
        @keyframes pulse {
          0%, 100% { opacity: .28; transform: translateY(0); }
          50% { opacity: 1; transform: translateY(-2px); }
        }
        .wordline {
          display: flex;
          align-items: baseline;
          gap: 8px;
          flex-wrap: wrap;
          margin-bottom: 1px;
        }
        .word {
          font-size: 24px;
          font-weight: 650;
          line-height: 1.2;
          letter-spacing: .01em;
          overflow-wrap: anywhere;
        }
        .reading {
          font-size: 13px;
          color: #6b7280;
          overflow-wrap: anywhere;
        }
        .source {
          margin: 2px 0 10px;
          font-size: 10.5px;
          color: #9ca3af;
          line-height: 1.45;
        }
        .senses { display: flex; flex-direction: column; gap: 8px; }
        .sense {
          padding: 9px 10px;
          border: 1px solid rgba(15, 23, 42, .08);
          border-radius: 9px;
          background: #ffffff;
        }
        .sense.is-context {
          border-color: rgba(28, 30, 33, .24);
          background: #f5f3ef;
          box-shadow: inset 3px 0 0 #1c1e21;
        }
        .sense-head {
          display: flex;
          align-items: center;
          gap: 6px;
          flex-wrap: wrap;
          margin-bottom: 4px;
        }
        .num {
          display: inline-grid;
          place-items: center;
          width: 17px;
          height: 17px;
          border-radius: 50%;
          background: #f1f2f4;
          color: #6b7280;
          font-size: 10px;
          font-weight: 600;
        }
        .pos {
          padding: 1px 6px;
          border-radius: 999px;
          background: #eef0f3;
          color: #4b5563;
          font-size: 10.5px;
          font-weight: 500;
          white-space: nowrap;
        }
        .is-context .pos { background: #1c1e21; color: #ffffff; }
        .tag {
          margin-left: auto;
          padding: 2px 6px;
          border-radius: 999px;
          background: rgba(28, 30, 33, .08);
          color: #1c1e21;
          font-size: 10px;
          font-weight: 600;
          white-space: nowrap;
        }
        .meaning {
          margin: 0;
          color: #1f2937;
          font-size: 13.5px;
          line-height: 1.55;
          overflow-wrap: anywhere;
        }
        .example {
          margin-top: 6px;
          padding-left: 8px;
          border-left: 2px solid rgba(15, 23, 42, .10);
        }
        .ex {
          margin: 0;
          color: #4b5563;
          font-size: 12px;
          line-height: 1.45;
          overflow-wrap: anywhere;
        }
        .ex-t {
          margin: 2px 0 0;
          color: #8a8f98;
          font-size: 12px;
          line-height: 1.45;
          overflow-wrap: anywhere;
        }
        .context-note {
          margin: 8px 0 0;
          color: #9ca3af;
          font-size: 10.5px;
          line-height: 1.45;
        }
        .quote {
          margin: 0 0 8px;
          padding: 7px 9px;
          border-radius: 8px;
          background: #f7f7f6;
          color: #6b7280;
          font-size: 12px;
          line-height: 1.5;
          max-height: 64px;
          overflow: auto;
          white-space: pre-wrap;
          overflow-wrap: anywhere;
          unicode-bidi: plaintext;
        }
        .translation {
          margin: 0;
          color: #1c1e21;
          font-size: 15px;
          line-height: 1.65;
          white-space: pre-wrap;
          overflow-wrap: anywhere;
          unicode-bidi: plaintext;
        }
        .notice {
          margin: 9px 0 0;
          color: #8a8f98;
          font-size: 10.5px;
          line-height: 1.5;
        }
        .foot {
          flex: 0 0 auto;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          padding: 7px 12px;
          border-top: 1px solid rgba(15, 23, 42, .07);
          background: #fafaf9;
          color: #9ca3af;
          font-size: 10.5px;
        }
        .foot-left, .foot-right {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .foot-right { flex: 0 0 auto; }
        .error-title {
          margin: 0 0 4px;
          color: #b42318;
          font-size: 13px;
          font-weight: 600;
        }
        .error-text {
          margin: 0;
          color: #6b7280;
          font-size: 12px;
          line-height: 1.5;
          white-space: pre-wrap;
          overflow-wrap: anywhere;
        }
        .retry {
          margin-top: 10px;
          padding: 5px 10px;
          border: 1px solid rgba(15, 23, 42, .14);
          border-radius: 7px;
          background: #ffffff;
          color: #1c1e21;
          font-family: inherit;
          font-size: 12px;
          line-height: 1.3;
          cursor: pointer;
        }
        .retry:hover { background: #f6f6f5; }
        @media (prefers-reduced-motion: reduce) {
          .loading i { animation: none; opacity: .7; }
        }
      </style>
      <div class="card" role="dialog" aria-label="划词翻译" aria-live="polite">
        <div class="head">
          <span class="kicker">划词翻译</span>
          <span class="meta"></span>
          <button class="min" type="button" aria-label="最小化为图标" title="最小化为图标">—</button>
          <button class="close" type="button" aria-label="关闭">×</button>
        </div>
        <div class="body"></div>
        <div class="foot"></div>
      </div>
      <button class="mini" type="button" aria-label="展开划词翻译" title="展开划词翻译">译</button>
    `;
    meta = shadow.querySelector(".meta");
    body = shadow.querySelector(".body");
    foot = shadow.querySelector(".foot");
    shadow.querySelector(".min").addEventListener("click", () => setMinimized(true));
    shadow.querySelector(".mini").addEventListener("click", () => setMinimized(false));
    shadow.querySelector(".close").addEventListener("click", closePopup);

    // Clicking the card must not reach a page-level click handler (manga
    // readers, in particular, often treat any click as a page turn).
    for (const type of ["pointerdown", "mousedown", "mouseup", "click", "dblclick"]) {
      host.addEventListener(type, (event) => event.stopPropagation());
    }
    document.documentElement.appendChild(host);
  }

  /** Collapse the card to a small floating icon, or bring it back. */
  function setMinimized(value) {
    if (!host) return;
    minimized = Boolean(value);
    host.classList.toggle("minimized", minimized);
    host.style.width = minimized ? "38px" : `${cardWidth()}px`;
    requestAnimationFrame(placeCard);
  }

  function renderLoading(job) {
    meta.textContent = "查询中";
    const loading = make("div", "loading");
    loading.append(make("i"), make("i"), make("i"));
    loading.append(make("span", "", job.isWord ? "正在查词典…" : "正在翻译…"));
    setBody(loading);
    setFooter("", "Esc 关闭");
  }

  function renderError(job, message) {
    meta.textContent = "失败";
    const wrap = make("div", "error");
    wrap.append(
      make("p", "error-title", "翻译失败"),
      make("p", "error-text", message || "未知错误"),
    );
    const retry = make("button", "retry", "重试");
    retry.type = "button";
    retry.addEventListener("click", () => {
      const id = ++seq;
      renderLoading(job);
      requestLookup(job, id, { force: true });
    });
    wrap.append(retry);
    setBody(wrap);
    setFooter("", "Esc 关闭");
  }

  function renderDictionary(job, result) {
    const entry = result.entry || {};
    meta.textContent = ["词典", result.target || ""].filter(Boolean).join(" · ");
    const wrap = make("div", "entry");
    const wordline = make("div", "wordline");
    wordline.append(make("span", "word", entry.word || job.text));
    if (entry.reading) wordline.append(make("span", "reading", entry.reading));
    wrap.append(wordline);
    wrap.append(make(
      "p",
      "source",
      entry.dictionary
        ? `释义参照：${entry.dictionary} · 共 ${entry.senses.length} 个义项`
        : `释义参照权威辞典整理（AI 辅助，仅供参考） · 共 ${entry.senses.length} 个义项`,
    ));

    const senses = make("div", "senses");
    entry.senses.forEach((sense, index) => {
      const isContext = entry.contextSense === index + 1;
      const item = make("div", `sense${isContext ? " is-context" : ""}`);
      const head = make("div", "sense-head");
      head.append(make("span", "num", String(index + 1)));
      if (sense.pos) head.append(make("span", "pos", sense.pos));
      if (isContext) head.append(make("span", "tag", "本文义项"));
      item.append(head);
      item.append(make("p", "meaning", sense.meaning));
      if (sense.example || sense.exampleTranslation) {
        const example = make("div", "example");
        if (sense.example) example.append(make("p", "ex", sense.example));
        if (sense.exampleTranslation) {
          example.append(make("p", "ex-t", sense.exampleTranslation));
        }
        item.append(example);
      }
      senses.append(item);
    });
    wrap.append(senses);
    if (!entry.contextSense) {
      wrap.append(make("p", "context-note", "未能判断本文义项，已列出全部常见义项。"));
    }
    setBody(wrap);
    setFooter(
      ["AI 参照权威辞典整理", result.provider || ""].filter(Boolean).join(" · "),
      "Esc 关闭",
    );
  }

  function renderText(job, result) {
    meta.textContent = ["翻译", result.target || ""].filter(Boolean).join(" · ");
    const wrap = make("div", "plain");
    wrap.append(make("p", "quote", job.text));
    wrap.append(make("p", "translation", result.translation || "（空结果）"));
    if (result.notice) wrap.append(make("p", "notice", result.notice));
    setBody(wrap);
    setFooter(result.provider || result.target || "", "Esc 关闭");
  }

  function renderNotice(job, result = {}) {
    meta.textContent = "无需翻译";
    const wrap = make("div", "plain");
    wrap.append(make("p", "quote", job.text));
    wrap.append(make("p", "notice", result.notice || "原文已是目标语言，无需翻译。"));
    setBody(wrap);
    setFooter(result.provider || result.target || targetLanguage, "Esc 关闭");
  }

  function cacheKey(job) {
    return `${job.isWord ? "word" : "text"}|${job.text}|${job.context}`;
  }

  function remember(key, result) {
    if (cache.size >= CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, { at: Date.now(), result });
  }

  async function requestLookup(job, id, { force = false } = {}) {
    const key = cacheKey(job);
    if (!force) {
      const hit = cache.get(key);
      if (hit && Date.now() - hit.at < CACHE_TTL) {
        if (hit.result.kind === "dictionary") renderDictionary(job, hit.result);
        else if (hit.result.kind === "notice") renderNotice(job, hit.result);
        else renderText(job, hit.result);
        return;
      }
      if (hit) cache.delete(key);
    }
    let result;
    try {
      result = await chrome.runtime.sendMessage({
        type: "LOOKUP_WORD",
        text: job.text,
        context: job.context,
        word: job.isWord,
      });
    } catch (error) {
      result = { ok: false, reason: String(error?.message || error) };
    }
    if (id !== seq || !host) return;
    if (!result?.ok) {
      renderError(job, result?.reason || "未知错误");
      return;
    }
    remember(key, result);
    if (result.kind === "dictionary") renderDictionary(job, result);
    else if (result.kind === "notice") renderNotice(job, result);
    else renderText(job, result);
  }

  function contextForRange(range, text) {
    let node = range.startContainer;
    if (node.nodeType !== 1) node = node.parentElement;
    const block = node?.closest?.(
      "p, li, blockquote, dd, figcaption, td, th, h1, h2, h3, h4, h5, h6, article, section",
    ) || node;
    const raw = String(block?.innerText || block?.textContent || "");
    let full = raw.replace(/\s+/g, " ").trim();
    if (!full) {
      full = String(document.body?.innerText || "").replace(/\s+/g, " ").trim();
    }
    if (!full) return "";
    const needle = text.replace(/\s+/g, " ");
    // Find the selected occurrence rather than the first occurrence of the
    // same word: 猫 in the first sentence and 猫 in the fourth are different
    // contexts, and the highlight must follow the one the user selected.
    let at = -1;
    try {
      const before = document.createRange();
      before.setStart(block, 0);
      before.setEnd(range.startContainer, range.startOffset);
      at = before.toString().replace(/\s+/g, " ").length;
      if (at > full.length || full.slice(at, at + needle.length) !== needle) at = -1;
    } catch {
      at = -1;
    }
    if (at < 0) at = full.indexOf(needle);
    if (at < 0) at = 0;
    const start = Math.max(0, at - 100);
    const end = Math.min(full.length, at + needle.length + 100);
    return full.slice(start, end).slice(0, 600);
  }

  function isTextControl(element) {
    if (element instanceof HTMLTextAreaElement) return true;
    if (!(element instanceof HTMLInputElement)) return false;
    return ["text", "search", "url", "email", "tel"].includes(
      String(element.type || "text").toLowerCase(),
    );
  }

  function inspectControl(control) {
    timer = null;
    if (!enabled || !isTextControl(control)) return;
    const start = control.selectionStart;
    const end = control.selectionEnd;
    if (start === null || end === null || end <= start) return;
    const value = String(control.value || "");
    const text = value.slice(start, end).replace(/\s+/g, " ").trim();
    if (!text) return;
    if (text.length > MAX_TEXT) {
      closePopup();
      return;
    }
    const rect = control.getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) return;
    const context = value
      .slice(Math.max(0, start - 100), Math.min(value.length, end + 100))
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 600);
    const isWord = WORD_PATTERN.test(text) && !/\s/u.test(text);
    const job = { text, context, isWord };
    if (!isWord && globalThis.MAS_providers?.likelySameLanguage?.(text, targetLanguage, context)) {
      openNotice(job, rect, `原文已是${targetLanguage}，无需翻译。`);
      return;
    }
    open(job, rect);
  }

  function inspectSelection() {
    timer = null;
    if (!enabled) return;
    const selection = document.getSelection?.();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return;
    const range = selection.getRangeAt(0);
    if (elementInOwnUi(range.commonAncestorContainer)) return;
    let text = selection.toString().replace(/\s+/g, " ").trim();
    if (!text) return;

    const rect = range.getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) return;
    if (text.length > MAX_TEXT) {
      // The popup would be useful here, but translating an entire article by
      // accident is worse than asking for a smaller selection.
      closePopup();
      return;
    }
    const isWord = WORD_PATTERN.test(text) && !/\s/u.test(text);
    const context = contextForRange(range, text);
    const job = {
      text,
      context,
      isWord,
    };
    if (!isWord && globalThis.MAS_providers?.likelySameLanguage?.(text, targetLanguage, context)) {
      openNotice(job, rect, `原文已是${targetLanguage}，无需翻译。`);
      return;
    }
    open(job, rect);
  }

  function open(job, rect, { lookup = true } = {}) {
    closePopup();
    const id = ++seq;
    currentJob = job;
    anchorRect = {
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height,
    };
    createPopup();
    if (lookup) renderLoading(job);
    requestAnimationFrame(() => {
      if (!host) return;
      host.style.visibility = "visible";
      placeCard();
    });
    if (lookup) requestLookup(job, id);
  }

  function openNotice(job, rect, message) {
    open(job, rect, { lookup: false });
    renderNotice(job, { target: targetLanguage, notice: message });
  }

  function scheduleInspect() {
    if (!enabled) return;
    clearTimeout(timer);
    timer = setTimeout(inspectSelection, 170);
  }

  function scheduleControl(control) {
    if (!enabled) return;
    clearTimeout(timer);
    timer = setTimeout(() => inspectControl(control), 90);
  }

  document.addEventListener("mouseup", (event) => {
    if (elementInOwnUi(event.target)) return;
    if (isTextControl(event.target)) {
      scheduleControl(event.target);
      return;
    }
    scheduleInspect();
  }, true);
  document.addEventListener("keyup", (event) => {
    if (elementInOwnUi(event.target)) return;
    if (event.key !== "Shift" && !event.key.startsWith("Arrow")) return;
    if (isTextControl(event.target)) {
      scheduleControl(event.target);
      return;
    }
    scheduleInspect();
  }, true);
  document.addEventListener("select", (event) => {
    if (elementInOwnUi(event.target)) return;
    if (isTextControl(event.target)) scheduleControl(event.target);
  }, true);
  document.addEventListener("pointerdown", (event) => {
    if (!host || elementInOwnUi(event.target)) return;
    closePopup();
  }, true);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && host) closePopup();
  }, true);

  window.addEventListener("resize", () => {
    if (!host) return;
    const selection = document.getSelection?.();
    if (selection && selection.rangeCount && !selection.isCollapsed) {
      const rect = selection.getRangeAt(0).getBoundingClientRect();
      if (rect.width || rect.height) {
        anchorRect = { ...rect.toJSON?.() ?? {
          left: rect.left, right: rect.right, top: rect.top,
          bottom: rect.bottom, width: rect.width, height: rect.height,
        } };
        placeCard();
        return;
      }
    }
    closePopup();
  }, { passive: true });

  window.addEventListener("scroll", (event) => {
    if (!host || elementInOwnUi(event.target)) return;
    const selection = document.getSelection?.();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      closePopup();
      return;
    }
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    if (!rect.width && !rect.height) {
      closePopup();
      return;
    }
    anchorRect = {
      left: rect.left, right: rect.right, top: rect.top,
      bottom: rect.bottom, width: rect.width, height: rect.height,
    };
    placeCard();
  }, true);

  async function sync() {
    const cfg = await readStore([
      "selectionTranslate", "translationProvider", "translationMode", "targetLanguage",
    ]);
    // On by default: the feature is a headline behaviour of the extension, and
    // the panel switch is the way to stop it (including on sites where every
    // drag would otherwise cost a request).
    //
    // It also stays quiet until a translation source exists. Otherwise every
    // selection on a fresh install would pop "尚未选择翻译来源" over the page.
    const provider = String(cfg.translationProvider || "");
    const configured = provider ? provider !== "none" : String(cfg.translationMode || "none") !== "none";
    targetLanguage = cfg.targetLanguage || "简体中文";
    enabled = cfg.selectionTranslate !== false && configured;
    if (!enabled) closePopup();
  }

  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.selectionTranslate) {
      sync().catch(() => {});
      return;
    }
    if (changes.translationProvider || changes.translationMode) {
      cache.clear();
      sync().catch(() => {});
      return;
    }
    if (changes.targetLanguage) {
      targetLanguage = changes.targetLanguage.newValue || "简体中文";
    }
    if (
      changes.translationStrength || changes.translationModel ||
      changes.translationModelProvider || changes.targetLanguage ||
      changes.translationApiKey || changes.translationEndpoint ||
      changes.translationGlossary
    ) {
      cache.clear();
    }
  });

  globalThis.MAS_selection = {
    installed: true,
    sync,
    close: closePopup,
    current: () => currentJob,
  };
  sync().catch(() => {});
})();
