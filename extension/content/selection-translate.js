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
  let currentJob = null;
  let timer = null;
  let seq = 0;
  let targetLanguage = "简体中文";
  let inputAutoReplace = true;
  let applyingEdit = false;
  const composing = new WeakSet();
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
    globalThis.MAS_reader?.remove(host?.dataset.readerId);
    host?.remove();
    host = null;
    shadow = null;
    body = null;
    meta = null;
    foot = null;
    currentJob = null;
  }

  function setBody(node) {
    if (!body) return;
    body.replaceChildren(node);
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
    host.style.setProperty('display', 'none', 'important');
    shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<div class="card"><div class="head"><span class="title">划词翻译</span><span class="meta"></span></div><div class="body"></div><div class="foot"></div></div>`;
    meta = shadow.querySelector(".meta");
    body = shadow.querySelector(".body");
    foot = shadow.querySelector(".foot");
    document.documentElement.appendChild(host);
    globalThis.MAS_reader?.mount(host, {
      kind: currentJob?.input ? '输入框译文' : currentJob?.isWord ? '划词词典' : '划词翻译',
      source: currentJob?.text, element: currentJob?.input?.control || currentJob?.element,
      dismiss: closePopup,
    });
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
    if (job.input) replaceInput(job, result, wrap);
  }

  function writable(control) {
    return control?.isConnected && !control.disabled && !control.readOnly &&
      (control instanceof HTMLTextAreaElement ||
        (control instanceof HTMLInputElement && ["text", "search"].includes(control.type)));
  }

  function inputStillCurrent(input) {
    const { control, value, start, end } = input;
    return writable(control) && !composing.has(control) && document.activeElement === control &&
      control.value === value && control.selectionStart === start && control.selectionEnd === end;
  }

  function editInput(control, text, start, end, inputType = "insertReplacementText", valid = () => true) {
    const value = control.value;
    const next = value.slice(0, start) + text + value.slice(end);
    if (control.maxLength >= 0 && next.length > control.maxLength) return false;
    const allowed = control.dispatchEvent(new InputEvent("beforeinput", {
      bubbles: true, composed: true, cancelable: true, inputType, data: text,
    }));
    if (!allowed || !writable(control) || control.value !== value || !valid()) return false;
    applyingEdit = true;
    try {
      const prototype = control instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      prototype.setRangeText.call(control, text, start, end, "end");
      control.dispatchEvent(new InputEvent("input", {
        bubbles: true, composed: true, inputType, data: text,
      }));
      control.dispatchEvent(new Event("change", { bubbles: true }));
    } finally {
      applyingEdit = false;
    }
    return control.value === next;
  }

  function replaceInput(job, result, wrap) {
    const input = job.input;
    let translation = result.translation;
    const note = make("p", "notice");
    wrap.append(note);
    if (!inputStillCurrent(input)) {
      note.textContent = "输入内容或选区已变化，未替换原文。";
      return;
    }
    if (typeof translation !== "string" || !translation.trim() || translation === job.text) {
      note.textContent = "译文与原文相同或为空，未替换。";
      return;
    }
    const { control, start, end, value } = input;
    const selected = value.slice(start, end);
    translation = selected.match(/^\s*/u)[0] + translation.trim() + selected.match(/\s*$/u)[0];
    if (!editInput(control, translation, start, end, "insertReplacementText", () =>
      currentJob === job && inputStillCurrent(input))) {
      note.textContent = control.value === value
        ? "输入框未接受替换，已保留原文；可复制上方译文。"
        : "网页调整了输入内容，请检查输入框。";
      return;
    }
    if (!host || currentJob !== job) return;
    const replacedValue = value.slice(0, start) + translation + value.slice(end);
    meta.textContent = ["已替换", result.target || targetLanguage].join(" · ");
    note.textContent = "已自动替换选中文字，其他内容保持不变。";
    const undo = make("button", "retry undo-replace", "撤销替换");
    undo.type = "button";
    undo.addEventListener("click", () => {
      if (!writable(control) || control.value !== replacedValue || composing.has(control)) {
        note.textContent = "输入内容已变化，未撤销，以免覆盖新内容。";
        undo.disabled = true;
        return;
      }
      control.focus({ preventScroll: true });
      if (editInput(control, value.slice(start, end), start, start + translation.length, "historyUndo")) {
        note.textContent = "已恢复原文。";
        meta.textContent = "已撤销替换";
      } else {
        note.textContent = "输入框未接受原样恢复，请检查输入框。";
      }
      undo.disabled = true;
    });
    wrap.append(undo);
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
    return `${job.input ? "input" : job.isWord ? "word" : "text"}|${job.text}|${job.context}`;
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
      if (job.input) {
        const response = await chrome.runtime.sendMessage({
          type: "TRANSLATE_TEXT_BLOCKS", texts: [job.text], source: "自动识别", target: targetLanguage,
        });
        result = response?.ok ? {
          ok: true, kind: response.skipped?.[0] ? "notice" : "text",
          translation: response.translations?.[0], target: targetLanguage,
        } : response;
      } else {
        result = await chrome.runtime.sendMessage({
          type: "LOOKUP_WORD", text: job.text, context: job.context, word: job.isWord,
        });
      }
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
    const input = inputAutoReplace && writable(control) ? { control, value, start, end } : null;
    const text = input ? value.slice(start, end).trim() : value.slice(start, end).replace(/\s+/g, " ").trim();
    if (!text.trim() || composing.has(control)) return;
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
    if (currentJob?.input?.control === control && currentJob.input.value === value &&
      currentJob.input.start === start && currentJob.input.end === end) return;
    const isWord = !input && WORD_PATTERN.test(text) && !/\s/u.test(text);
    const job = { text, context, isWord, input };
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
      element: range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement,
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
    createPopup();
    if (lookup) renderLoading(job);
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
  document.addEventListener("input", (event) => {
    if (!applyingEdit && currentJob?.input?.control === event.target) closePopup();
  }, true);
  document.addEventListener("compositionstart", (event) => {
    if (!isTextControl(event.target)) return;
    composing.add(event.target);
    if (currentJob?.input?.control === event.target) closePopup();
  }, true);
  document.addEventListener("compositionend", (event) => composing.delete(event.target), true);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closePopup();
  }, true);

  async function sync() {
    const cfg = await readStore([
      "selectionTranslate", "inputAutoReplace", "translationProvider", "translationMode", "targetLanguage",
    ]);
    // On by default: the feature is a headline behaviour of the extension, and
    // the panel switch is the way to stop it (including on sites where every
    // drag would otherwise cost a request).
    //
    // Keep the saved preference, but only run while the source supports AI
    // dictionary entries. Switching away also closes an existing card.
    const registry = globalThis.MAS_providers;
    const provider = registry.byId(registry.resolveProviderId(cfg));
    targetLanguage = cfg.targetLanguage || "简体中文";
    inputAutoReplace = cfg.inputAutoReplace !== false;
    enabled = cfg.selectionTranslate !== false && registry.isChatProvider(provider);
    if (!enabled) closePopup();
  }

  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.inputAutoReplace || changes.selectionTranslate) {
      closePopup();
      cache.clear();
      sync().catch(() => {});
      return;
    }
    if (changes.translationProvider || changes.translationMode) {
      cache.clear();
      closePopup();
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
      closePopup();
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
