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
  const WORD_PATTERN = /^\p{L}[\p{L}\p{N}\p{M}'’\-・ー]*$/u;
  const UNSEGMENTED_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
  const isDictionaryWord = (text) =>
    WORD_PATTERN.test(text) && text.length <= (UNSEGMENTED_SCRIPT.test(text) ? 8 : 48);
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
  let popupFrame = null;
  let seq = 0;
  let targetLanguage = "简体中文";
  let defaultProvider = "deepseek";
  let inputAutoReplace = true;
  let applyingEdit = false;
  const composing = new WeakSet();
  const cache = new Map();

  const readStore = (keys) => chrome.storage?.local?.get?.(keys).catch(() => ({}));

  function elementInOwnUi(node) {
    const element = node?.nodeType === 1 ? node : node?.parentElement;
    if (!element?.closest) return false;
    if(globalThis.MAS_quick?.isOwn(element))return true;
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
    globalThis.MAS_quick?.hide(currentJob);
    restoreSelection(currentJob);
    seq += 1;
    clearTimeout(timer);
    timer = null;
    if (popupFrame !== null) cancelAnimationFrame(popupFrame);
    popupFrame = null;
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
    schedulePopup();
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
    host.style.cssText = "position:fixed!important;display:block!important;z-index:2147483647!important;visibility:hidden";
    shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>
      :host{all:initial;width:min(390px,calc(100vw - 16px));font:13px/1.55 'Segoe UI','Microsoft YaHei',system-ui;color:#18212f;color-scheme:light}
      *{box-sizing:border-box}p{margin:0}button{font:inherit;cursor:pointer}
      .card{max-height:inherit;display:flex;flex-direction:column;border:1px solid #dce4f0;border-radius:12px;background:#fff;box-shadow:0 8px 24px #18212f26;overflow:hidden}
      .head,.foot{display:flex;align-items:center;gap:8px;padding:8px 12px;background:#f7f9fd;color:#667085;font-size:11px;flex:none}
      .head{border-bottom:1px solid #e5e9ef}.head select,.head .cover{display:none}.title{font-size:13px;font-weight:650;color:#18212f}
      .meta{flex:1}.close,.retry{border:1px solid #dce4f0;border-radius:7px;padding:2px 8px;background:#fff;color:#285de5}
      .close:hover,.retry:hover{background:#edf3ff}.retry{margin-top:8px}.body{padding:10px 12px;overflow:auto;overscroll-behavior:contain;overflow-wrap:anywhere}
      .foot{justify-content:space-between;border-top:1px solid #e5e9ef}.foot-right{white-space:nowrap}
      .wordline,.sense-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}.word{font-size:21px;font-weight:650}
      .reading,.source,.context-note,.quote,.notice,.example{color:#667085;font-size:12px}
      .source,.context-note,.notice{margin-top:6px}.translation{margin-top:6px;white-space:pre-wrap}
      .sense{padding:8px 0;margin-top:6px;border-top:1px solid #e5e9ef}.sense.is-context{padding:8px 10px;border-left:2px solid #285de5;border-radius:4px;background:#edf3ff}
      .sense-head{color:#285de5;font-size:11px}.pos,.tag{background:#edf3ff;border-radius:5px;padding:1px 5px}
      .sense.is-context .pos{background:#285de5;color:#fff}.tag{background:#dce8ff;font-weight:650}
      .meaning{font-weight:550}.example{margin-top:4px}.error{color:#b42318}
    </style><div class="card" role="region" aria-label="划词翻译结果"><div class="head"><span class="title">划词翻译</span><span class="meta"></span><button class="close" type="button" aria-label="关闭划词翻译">×</button></div><div class="body" aria-live="polite"></div><div class="foot"></div></div>`;
    shadow.querySelector(".close").onclick = closePopup;
    meta = shadow.querySelector(".meta");
    body = shadow.querySelector(".body");
    foot = shadow.querySelector(".foot");
    document.documentElement.appendChild(host);
    addQuickControls(currentJob);
    globalThis.MAS_reader?.mount(host, {
      kind: currentJob?.input ? '输入框译文' : currentJob?.isWord ? '划词词典' : '划词翻译',
      source: currentJob?.text, element: currentJob?.input?.control || currentJob?.element,
      dismiss: closePopup, hideHost: false,
    });
  }

  function positionPopup() {
    popupFrame = null;
    const job = currentJob;
    if (!host || !job) return;
    if (job.popupDismissed || job.mode === "source" || !job.element?.isConnected) {
      host.style.visibility = "hidden";
      return;
    }
    const rect = job.covered?.span.getBoundingClientRect() || job.range?.getBoundingClientRect() || job.element.getBoundingClientRect();
    if (rect.bottom <= 0 || rect.top >= innerHeight) {
      host.style.visibility = "hidden";
      return;
    }
    const gap = 8;
    const toolbar = document.querySelector('[data-maslingo-quick][data-expanded="true"]')?.getBoundingClientRect();
    let below = rect.bottom + gap;
    if (toolbar && toolbar.top >= rect.bottom && toolbar.top - below < host.offsetHeight &&
        toolbar.left < rect.left + host.offsetWidth && toolbar.right > rect.left) {
      below = toolbar.bottom + gap;
    }
    const above = rect.top - gap;
    const roomBelow = innerHeight - below - gap;
    const roomAbove = above - gap;
    const useBelow = roomBelow >= Math.min(host.scrollHeight, 210) || roomBelow >= roomAbove;
    host.style.maxHeight = `${Math.max(0, Math.min(420, useBelow ? roomBelow : roomAbove))}px`;
    host.style.top = `${Math.max(gap, useBelow ? below : above - host.offsetHeight)}px`;
    host.style.left = `${Math.max(gap, Math.min(rect.left, innerWidth - host.offsetWidth - gap))}px`;
    host.style.visibility = "visible";
  }

  function schedulePopup() {
    if (host && popupFrame === null) popupFrame = requestAnimationFrame(positionPopup);
  }

  function restorable(job) {
    const r=job?.textRange;
    return r && r.node.isConnected && r.node.data===r.value && !r.node.parentElement?.closest('a,button,code,pre,[contenteditable],math,[role="math"]');
  }
  function restoreSelection(job) {
    const saved=job?.covered;
    if(!saved)return;
    const {parent,node,prefix,span,suffix}=saved;
    // A site's own update wins over a parked selection.
    if(prefix.parentNode===parent && prefix.nextSibling===span && span.nextSibling===suffix && prefix.data===saved.before && suffix.data===saved.after && span.textContent===saved.translation){
      parent.replaceChild(node,prefix);span.remove();suffix.remove();
    }
    job.covered=null;
  }
  function coverSelection(job) {
    if(job.covered || !job.translation || !restorable(job))return;
    const {node,start,end,value}=job.textRange,parent=node.parentNode;
    const prefix=document.createTextNode(value.slice(0,start)),suffix=document.createTextNode(value.slice(end)),span=document.createElement('span');
    span.dataset.maslingoCover='1';span.textContent=job.translation;
    parent.replaceChild(prefix,node);prefix.after(span,suffix);
    job.covered={parent,node,prefix,span,suffix,before:prefix.data,after:suffix.data,translation:job.translation};
  }
  function updateQuick(job) {
    const q=job.controls;if(!q)return;
    if(job.mode==='translated' && job.translation)coverSelection(job);
    q.cover.disabled=!job.covered && (!restorable(job) || !job.translation);
    q.cover.textContent=job.covered?'还原原文':'覆盖原文';q.cover.setAttribute('aria-pressed',String(!!job.covered));
    q.mode.querySelector('[value=translated]').disabled=!job.covered && !restorable(job);
    q.mode.value=job.mode;
    globalThis.MAS_quick?.refresh(job);
    schedulePopup();
  }
  function addQuickControls(job) {
    const registry=globalThis.MAS_providers;
    function select(className,label,values,value){
      const node=make('select',className);node.setAttribute('aria-label',label);node.dataset.quickLabel=label;
      for(const [id,text] of values)node.append(new Option(text,id));
      if(![...node.options].some(o=>o.value===value))node.append(new Option(value,value));
      node.value=value;shadow.querySelector('.head').append(node);return node;
    }
    const names=registry.languages.map(l=>[l.name,l.name]);
    const source=select('src','原文',[['自动识别','自动识别'],...names],job.source);
    const target=select('lang','译文',names,job.target);
    const provider=select('provider','来源',registry.list.filter(p=>p.id!=='none').map(p=>[p.id,p.label]),job.provider);
    const mode=select('display-mode','显示',[['bilingual','双语对照'],['translated','覆盖译文'],['source','只看原文']],job.mode);
    const cover=make('button','cover','覆盖原文');cover.type='button';shadow.querySelector('.head').append(cover);
    job.controls={source,target,provider,mode,cover};
    function retranslate(){
      restoreSelection(job);
      job.popupDismissed = false;
      if(job.input && job.undoInput){job.undoInput();job.undoInput=null;if(job.input.control.value===job.input.value){job.input.control.focus({preventScroll:true});job.input.control.setSelectionRange(job.input.start,job.input.end);}}
      job.source=source.value;job.target=target.value;job.provider=provider.value;job.translation='';
      const id=++seq;renderLoading(job);updateQuick(job);requestLookup(job,id);
    }
    for(const node of [source,target,provider])node.onchange=retranslate;
    mode.onchange=()=>{job.mode=mode.value;if(job.mode!=='translated')restoreSelection(job);updateQuick(job);};
    cover.onclick=()=>{job.mode=job.covered?'bilingual':'translated';if(job.mode==='bilingual')restoreSelection(job);updateQuick(job);};
    updateQuick(job);
    const anchor=job.element?.closest('p,h1,h2,h3,h4,h5,h6,blockquote,figcaption,td,th,li,dd,dt') || job.element;
    const inline=anchor && !anchor.matches('input,textarea,a,button,summary,[contenteditable]') && ['P','H1','H2','H3','H4','H5','H6','BLOCKQUOTE','FIGCAPTION','TD','TH','LI','DD','DT'].includes(anchor.tagName);
    job.quickOptions={owner:job,selection:true,element:anchor,inline,observe:shadow,
      rect:()=>{if(job.covered)return job.covered.span.getBoundingClientRect();if(job.textRange?.node.isConnected && job.textRange.node.data===job.textRange.value){const range=document.createRange();range.setStart(job.textRange.node,job.textRange.start);range.setEnd(job.textRange.node,job.textRange.end);return [...range.getClientRects()].at(-1) || range.getBoundingClientRect();}return job.range?.getBoundingClientRect() || job.element.getBoundingClientRect();},
      controls:[source,target,provider,mode,cover],
    };
    globalThis.MAS_quick?.show(job.quickOptions);
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
    job.translation=entry.senses?.[Math.max(0,(entry.contextSense || 1)-1)]?.meaning || "";
    updateQuick(job);
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
      head.append(make("span", "pos", sense.pos || "词性未标注"));
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
      wrap.append(make("p", "context-note", "未能判断本文义项，可参阅上方释义。"));
    }
    setBody(wrap);
    setFooter(
      ["AI 参照权威辞典整理", result.provider || ""].filter(Boolean).join(" · "),
      "Esc 关闭",
    );
  }

  function renderText(job, result) {
    job.translation=result.translation || "";
    updateQuick(job);
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
    job.undoInput=()=>undo.click();
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
    return `${job.input ? "input" : job.isWord ? "word" : "text"}|${job.text}|${job.context}|${job.source}|${job.target}|${job.provider}`;
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
      const chat=globalThis.MAS_providers.isChatProvider(globalThis.MAS_providers.byId(job.provider));
      if (job.input || !chat) {
        const response = await chrome.runtime.sendMessage({
          type: "TRANSLATE_TEXT_BLOCKS", texts: [job.text], source: job.source, target: job.target, provider: job.provider,
        });
        result = response?.ok ? {
          ok: true, kind: response.skipped?.[0] ? "notice" : "text",
          translation: response.translations?.[0], target: job.target,
        } : response;
      } else {
        result = await chrome.runtime.sendMessage({
          type: "LOOKUP_WORD", text: job.text, context: job.context, word: job.isWord,
          source:job.source,target:job.target,provider:job.provider,
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
    const isWord = !input && isDictionaryWord(text);
    const job = { text, context, isWord, input, element:control };
    if (!isWord && globalThis.MAS_providers?.likelySameLanguage?.(text, targetLanguage, context)) {
      openNotice(job, `原文已是${targetLanguage}，无需翻译。`);
      return;
    }
    open(job);
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
    const isWord = isDictionaryWord(text);
    const context = contextForRange(range, text);
    const job = {
      text,
      context,
      range: range.cloneRange(),
      textRange: range.startContainer===range.endContainer && range.startContainer.nodeType===Node.TEXT_NODE ? {node:range.startContainer,start:range.startOffset,end:range.endOffset,value:range.startContainer.data} : null,
      element: range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement,
      isWord,
    };
    if (!isWord && globalThis.MAS_providers?.likelySameLanguage?.(text, targetLanguage, context)) {
      openNotice(job, `原文已是${targetLanguage}，无需翻译。`);
      return;
    }
    open(job);
  }

  function open(job, { lookup = true } = {}) {
    closePopup();
    const id = ++seq;
    job.source=job.source || "自动识别";job.target=job.target || targetLanguage;job.provider=job.provider || defaultProvider;job.mode="bilingual";
    currentJob = job;
    createPopup();
    if (lookup) renderLoading(job);
    if (lookup) requestLookup(job, id);
  }

  function openNotice(job, message) {
    open(job, { lookup: false });
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

  document.addEventListener('pointerover', event => {
    if(currentJob?.covered?.span.contains(event.composedPath()[0]))globalThis.MAS_quick?.show(currentJob.quickOptions);
  },true);
  document.addEventListener("pointerdown", (event) => {
    if (!currentJob || elementInOwnUi(event.composedPath()[0])) return;
    currentJob.popupDismissed = true;
    schedulePopup();
  }, true);
  window.addEventListener("scroll", schedulePopup, { passive: true, capture: true });
  window.addEventListener("resize", schedulePopup, { passive: true });
  new ResizeObserver(schedulePopup).observe(document.documentElement);
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
    defaultProvider = provider.id;
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
