// Automatic and hover translation share inline results and reversible originals.

(() => {
  "use strict";
  if (globalThis.MAS_text?.installed) return;

  const AUTO_SOURCE = "自动识别";
  const MIN_TEXT_LENGTH = 2;
  const MAX_HOVER_CACHE = 80;
  const HOVER_DELAY = 220;
  const bingSearchPage = /(^|\.)bing\.com$/i.test(location.hostname) && /^\/search\/?$/.test(location.pathname);
  const BING_RESULT_SUBTITLE = "#b_results .b_algo :is(h3, h4) a[href]";
  const SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "TEXTAREA", "INPUT", "SELECT",
    "OPTION", "CODE", "PRE", "KBD", "SAMP", "SVG", "CANVAS", "VIDEO", "AUDIO",
    "IFRAME", "OBJECT", "EMBED", "HEAD", "META", "LINK", "MATH",
  ]);
  const BLOCK_TAGS = new Set([
    "P", "LI", "DT", "DD", "BLOCKQUOTE", "FIGCAPTION", "TD", "TH", "CAPTION",
    "H1", "H2", "H3", "H4", "H5", "H6", "LEGEND", "SUMMARY", "BUTTON",
  ]);

  let enabled = false;
  let autoEnabled = false;
  let hoverEnabled = false;
  let syncVersion = 0;
  let revision = 0;
  let scanTimer = null;
  let visibilityObserver = null;
  let mutationObserver = null;
  let activeRequests = 0;
  let language = "简体中文";
  let displayMode = "bilingual";
  let defaultProvider = "deepseek";
  let hoverBlock = null;
  let showTimer = null;
  const boxes = new Map(); // paragraph element -> box record
  const units = new Map();
  const nearby = new Set();
  const queue = new Set();
  const observedRoots = new Set();
  const languages = () =>
    (globalThis.MAS_providers?.languages || [{ name: "简体中文" }]).map((item) => item.name);
  const sourceLanguages = () =>
    [globalThis.MAS_providers?.autoSource || AUTO_SOURCE, ...languages()];
  const readStore = async (keys) => {
    try { return await chrome.storage.local.get(keys); } catch { return {}; }
  };

  function isOwnUi(node) {
    const element = node?.nodeType === 1 ? node : node?.parentElement;
    return Boolean(globalThis.MAS_quick?.isOwn(element)) || Boolean(element?.closest?.(
      "[data-maslingo-textbox], [data-maslingo-video], #maslingo-panel, #maslingo-selection-popup, " +
      "#maslingo-layer, .maslingo-overlay-text-canvas, [data-maslingo-cover], " +
      ".maslingo-adjacent-translation, .maslingo-caption-source",
    )) || Boolean(element?.getRootNode?.()?.host && isOwnUi(element.getRootNode().host));
  }

  /**
   * One white card in a shadow root.
   *
   * The title is built from separate flex children (`翻译：`, source select,
   * arrow, target select) so the two gaps are exactly the same. Inline text
   * nodes around the selects used to add a source-side space that the target
   * side did not have.
   */
  function createTextBox() {
    const host = document.createElement("div");
    host.dataset.maslingoTextbox = "1";
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        :host { display: block; text-align: left; color-scheme: light; }
        .card {
          background: #ffffff;
          border: 0;
          border-left: 2px solid #285de5;
          border-radius: 0;
          overflow: hidden;
          animation: enter .18s ease-out;
          font-family: "Noto Sans SC", "Microsoft YaHei", system-ui, sans-serif;
          font-size: 14px;
          line-height: 1.6;
          color: #1a1a1a;
        }
        .head {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 7px 10px;
          background: #ffffff;
          border-bottom: 1px solid rgba(15, 23, 42, 0.06);
        }
        .title {
          flex: 1 1 auto;
          min-width: 0;
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 4px;
          font-size: 13px;
          color: #64748b;
        }
        .title-label { flex: 0 0 auto; }
        .arrow {
          flex: 0 0 auto;
          color: #94a3b8;
          font-size: 12px;
        }
        .lang, .src {
          appearance: none;
          min-width: 0;
          max-width: 140px;
          border: 0;
          padding: 0;
          background: transparent;
          color: #1d4ed8;
          font: inherit;
          cursor: pointer;
        }
        .lang:hover, .src:hover { text-decoration: underline; }
        .lang:focus-visible, .src:focus-visible { outline: 2px solid #93c5fd; outline-offset: 1px; }
        .cover {
          flex: 0 0 auto;
          padding: 2px 5px;
          border: 0;
          border-radius: 6px;
          background: transparent;
          color: #1d4ed8;
          font: inherit;
          font-size: 12px;
          cursor: pointer;
        }
        .cover:hover { background: rgba(29, 78, 216, 0.08); }
        .cover:disabled { color: #94a3b8; cursor: default; background: transparent; }
        .toggle {
          flex: 0 0 auto;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 22px;
          height: 22px;
          padding: 0;
          border: 0;
          border-radius: 6px;
          background: transparent;
          color: #64748b;
          font-size: 12px;
          line-height: 1;
          cursor: pointer;
        }
        .toggle:hover { background: rgba(15, 23, 42, 0.06); }
        .pin[aria-pressed="true"] { color: #1d4ed8; background: #dbeafe; }
        .origin, .retry { border: 0; background: transparent; color: #1d4ed8; cursor: pointer; font: inherit; }
        .foot { display: flex; gap: 10px; padding: 0 10px 7px; font-size: 12px; }
        button:focus-visible { outline: 2px solid #2563eb; outline-offset: -2px; }
        [hidden] { display: none !important; }
        :host([data-context-toolbar]) .head,
        :host([data-context-toolbar]) .foot { display: none; }
        .body { padding: 10px 12px; }
        .text {
          margin: 0;
          white-space: pre-wrap;
          overflow-wrap: anywhere;
        }
        .text[data-state="loading"] { color: #64748b; }
        .text[data-state="error"] { color: #b42318; }
        .mode-note { margin: 0 0 8px; color: #64748b; font-size: 11px; }
        .collapsed .body { display: none; }
        .collapsed .head { border-bottom: 0; }
        @keyframes enter { from { opacity:0; transform:translateY(4px) } to { opacity:1; transform:none } }
        @media(prefers-reduced-motion:reduce) { .card { animation:none } }
      </style>
      <div class="card">
        <div class="head">
          <div class="title">
            <span class="title-label">翻译：</span>
            <select class="src" aria-label="源语言"></select>
            <span class="arrow" aria-hidden="true">→</span>
            <select class="lang" aria-label="目标语言"></select>
          </div>
          <button class="cover" type="button" aria-pressed="false" disabled>覆盖至原文</button>
          <button class="toggle pin" type="button" aria-pressed="false" aria-label="固定译文" title="固定译文">⌖</button>
          <button class="toggle" type="button" aria-expanded="true" aria-label="收起译文">▾</button>
          <button class="toggle close" type="button" aria-label="关闭译文" title="关闭译文">×</button>
        </div>
        <div class="body"><p class="mode-note" hidden>已保留复杂原文结构，以下为译文。</p><p class="text" role="status" aria-live="polite"></p></div>
        <div class="foot"><button class="origin" type="button">定位原文</button><button class="retry" type="button" hidden>重试</button></div>
      </div>
    `;

    const card = shadow.querySelector(".card");
    const text = shadow.querySelector(".text");
    const select = shadow.querySelector(".lang");
    const sourceSelect = shadow.querySelector(".src");
    const coverButton = shadow.querySelector(".cover");
    const toggle = shadow.querySelector(".toggle[aria-expanded]");
    const pin = shadow.querySelector(".pin");
    const origin = shadow.querySelector(".origin");
    const retry = shadow.querySelector(".retry");
    host.setAttribute("role", "region");
    host.setAttribute("aria-label", "MasLingo 网页译文");
    for (const name of sourceLanguages()) {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      sourceSelect.appendChild(option);
    }
    sourceSelect.value = AUTO_SOURCE;
    for (const name of languages()) {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      select.appendChild(option);
    }
    const measureCanvas = document.createElement("canvas");
    const measureContext = measureCanvas.getContext("2d");
    function fitSelect(target) {
      const option = target.options?.[target.selectedIndex];
      if (!option || !measureContext) return;
      const style = getComputedStyle(target);
      measureContext.font = `${style.fontWeight || 400} ${style.fontSize || "13px"} ${
        style.fontFamily || '"Noto Sans SC", "Microsoft YaHei", system-ui, sans-serif'
      }`;
      const width = measureContext.measureText(option.textContent || "").width;
      target.style.width = `${Math.min(140, Math.ceil(width + 2))}px`;
    }
    fitSelect(sourceSelect);
    fitSelect(select);

    sourceSelect.dataset.quickLabel = '原文'; select.dataset.quickLabel = '译文';
    const providerSelect = document.createElement('select'); providerSelect.className='provider';providerSelect.dataset.quickLabel='来源';providerSelect.setAttribute('aria-label','翻译来源');
    for(const item of globalThis.MAS_providers.list)if(item.id!=='none')providerSelect.append(new Option(item.label,item.id));
    providerSelect.value=defaultProvider;
    const displaySelect=document.createElement('select');displaySelect.className='display-mode';displaySelect.setAttribute('aria-label','当前段落显示方式');
    for(const [value,label] of [['bilingual','双语对照'],['translated','覆盖译文'],['source','只看原文']])displaySelect.append(new Option(label,value));
    shadow.querySelector('.head').append(providerSelect,displaySelect);
    const box = {
      host,
      card,
      text,
      select,
      sourceSelect,
      coverButton,
      origin,
      retry,
      providerSelect, displaySelect,
      localDisplayMode: null,
      modeNote: shadow.querySelector(".mode-note"),
      paragraph: null,
      translation: "",
      paragraphText: "",
      covered: false,
      originalNodes: null,
      coverSpan: null,
      inlineCover: null,
      linkedParts: null,
      linkedTranslations: null,
      collapsed: false,
      translated: false,
      loading: false,
      sameLanguage: false,
      error: false,
      visible: false,
      requestId: 0,
      manualTarget: false,
      manualSource: false,
      automatic: false,
      pinned: false,
      dismissed: false,
      key: "",
      nodes: [],
      canCover: false,
      setPinned(value) {
        box.pinned = value;
        pin.setAttribute("aria-pressed", String(value));
        pin.setAttribute("aria-label", value ? "取消固定" : "固定译文");
        pin.title = value ? "取消固定" : "固定译文";
      },
      setSource(name) {
        if (!name) return;
        if (![...sourceSelect.options].some((option) => option.value === name)) {
          const option = document.createElement("option");
          option.value = name;
          option.textContent = name;
          sourceSelect.appendChild(option);
        }
        sourceSelect.value = name;
        fitSelect(sourceSelect);
      },
      getSource() {
        return sourceSelect.value || AUTO_SOURCE;
      },
      setLanguage(name) {
        if (!name) return;
        if (![...select.options].some((option) => option.value === name)) {
          const option = document.createElement("option");
          option.value = name;
          option.textContent = name;
          select.appendChild(option);
        }
        select.value = name;
        fitSelect(select);
      },
      getLanguage() {
        return select.value || language;
      },
      refit() {
        fitSelect(sourceSelect);
        fitSelect(select);
      },
      toggleCollapsed() {
        box.collapsed = !box.collapsed;
        card.classList.toggle("collapsed", box.collapsed);
        toggle.setAttribute("aria-expanded", box.collapsed ? "false" : "true");
        toggle.textContent = box.collapsed ? "▸" : "▾";
        toggle.setAttribute("aria-label", box.collapsed ? "展开译文" : "收起译文");
      },
      setLoading() {
        retry.hidden = true;
        text.dataset.state = "loading";
        text.textContent = "翻译中…";
        box.translated = false;
        box.sameLanguage = false;
        if (!box.covered) coverButton.disabled = true;
      },
      setText(value, linkedTranslations = null) {
        retry.hidden = true;
        text.dataset.state = "done";
        text.textContent = value || "";
        box.translation = value || "";
        box.linkedTranslations = linkedTranslations;
        box.translated = true;
        box.sameLanguage = false;
        box.error = false;
        coverButton.disabled = !box.translation || !box.canCover;
        if (box.covered && box.coverSpan) box.coverSpan.textContent = box.translation;
      },
      setNotice(message) {
        retry.hidden = true;
        text.dataset.state = "done";
        text.textContent = message;
        box.translation = "";
        box.translated = false;
        box.sameLanguage = true;
        box.error = false;
        coverButton.disabled = true;
      },
      setError(message) {
        retry.hidden = false;
        text.dataset.state = "error";
        text.textContent = "翻译失败：" + message;
        box.translation = "";
        box.translated = false;
        box.error = true;
        if (!box.covered) coverButton.disabled = true;
      },
      // Linked paragraphs keep their original anchors and event handlers.
      toggleCover() {
        if (!box.paragraph || (!box.canCover && !box.covered) || (!box.translation && !box.covered)) return;
        if (!box.covered && !canCoverParagraph(box.paragraph)) {
          box.canCover = false;
          coverButton.disabled = true;
          coverButton.title = "原文结构已变化，保留原文显示译文";
          return;
        }
        if (!box.covered) {
          box.wasPinnedBeforeCover = box.pinned;
          if (box.paragraph.querySelector("a[href]")) {
            const unit = unitFor(box.paragraph);
            const parts = linkedParts(unit);
            if (!parts || !sameLinkedParts(parts, box.linkedParts) || !box.linkedTranslations) {
              invalidate(box);
              if (unit?.text === box.paragraphText) enqueue(box);
              else scheduleScan();
              return;
            }
            box.inlineCover = coverLinkedParts(box.paragraph, parts, box.linkedTranslations);
          } else {
            const fragment = document.createDocumentFragment();
            while (box.paragraph.firstChild) fragment.appendChild(box.paragraph.firstChild);
            box.originalNodes = fragment;
            const span = document.createElement("span");
            span.dataset.maslingoCover = "1";
            span.style.whiteSpace = "pre-wrap";
            span.textContent = box.translation;
            box.paragraph.appendChild(span);
            box.coverSpan = span;
          }
          box.covered = true;
          if (!box.collapsed) box.toggleCollapsed();
        } else {
          // A client-side page may replace the paragraph while it is covered.
          // Its new content wins; never append the parked stale original to it.
          if (box.inlineCover) {
            for (const { node, parent, original, translated } of box.inlineCover.edits) {
              if (node.parentNode === parent && box.paragraph.contains(node) && node.data === translated) node.data = original;
            }
          } else {
            const unchanged = coverIntact(box);
            box.coverSpan?.remove();
            if (unchanged && box.originalNodes) box.paragraph.appendChild(box.originalNodes);
          }
          box.originalNodes = null;
          box.coverSpan = null;
          box.inlineCover = null;
          box.covered = false;
          if (box.collapsed) box.toggleCollapsed();
        }
        coverButton.textContent = box.covered ? "还原原文" : "覆盖至原文";
        coverButton.setAttribute("aria-pressed", box.covered ? "true" : "false");
        if (box.covered) box.setPinned(true);
        else box.setPinned(Boolean(box.wasPinnedBeforeCover));
        pin.disabled = box.covered;
      },
    };

    select.addEventListener("change", () => {
      fitSelect(select);
      box.manualTarget = true;
      if (box.covered) box.toggleCover();
      invalidate(box);
      enqueue(box);
    });
    sourceSelect.addEventListener("change", () => {
      fitSelect(sourceSelect);
      box.manualSource = true;
      if (box.covered) box.toggleCover();
      invalidate(box);
      enqueue(box);
    });
    function chooseDisplay(mode) {
      box.localDisplayMode = mode;
      displaySelect.value = mode;
      applyDisplay(box);
      globalThis.MAS_quick?.refresh(box);
    }
    displaySelect.onchange=()=>chooseDisplay(displaySelect.value);
    providerSelect.onchange=()=>{if(box.covered)box.toggleCover();invalidate(box);enqueue(box);};
    coverButton.addEventListener("click", () => chooseDisplay(box.covered?'bilingual':'translated'));
    toggle.addEventListener("click", () => box.toggleCollapsed());
    pin.addEventListener("click", () => box.setPinned(!box.pinned));
    retry.addEventListener("click", () => enqueue(box));
    shadow.querySelector(".close").addEventListener("click", () => {
      if (box.covered) box.toggleCover();
      box.setPinned(false);
      box.dismissed = true;
      hideBox(box);
      globalThis.MAS_quick?.hide(box);
    });
    origin.addEventListener("click", () => {
      box.paragraph?.scrollIntoView({ block: "center", behavior: "smooth" });
      box.paragraph?.animate?.([{ outline: "2px solid #2563eb" }, { outline: "2px solid transparent" }], { duration: 1400 });
    });
    shadow.querySelector(".title").addEventListener("click", (event) => {
      if (event.target.closest("select")) return;
      box.toggleCollapsed();
    });
    return box;
  }

  function parentOf(element) {
    return element.parentElement || element.getRootNode?.()?.host || null;
  }

  function canCoverParagraph(element) {
    // A Bing sitelink is itself the replacement target, so its anchor stays
    // connected while the translated label replaces its children.
    if (element.matches('button, summary, [role="button"]') ||
        (element.matches("a") && !(bingSearchPage && element.matches(BING_RESULT_SUBTITLE)))) return false;
    return ![...element.querySelectorAll("*")].some((child) =>
      BLOCK_TAGS.has(child.tagName) || SKIP_TAGS.has(child.tagName.toUpperCase()) ||
      child.matches('[contenteditable], [role="button"], [role="math"]') ||
      /^(block|flow-root|flex|grid|list-item|table-cell|table-caption)$/.test(getComputedStyle(child).display));
  }

  function excluded(element) {
    for (let node = element; node; node = parentOf(node)) {
      if (SKIP_TAGS.has(node.tagName?.toUpperCase()) || node.isContentEditable ||
          node.matches?.('[hidden], [inert], [aria-hidden="true"], [role="textbox"], [role="math"]') || isOwnUi(node)) return true;
    }
    return false;
  }

  // Assign each text node to its nearest reading block. A wrapper's own text
  // remains eligible even when a nested paragraph, list or figure is present.
  // Inline links/emphasis stay in the surrounding sentence; table cells are
  // separate units rather than one enormous table-sized translation.
  function ownerOf(element, styles = new Map()) {
    for (let node = element; node && node !== document.body && node !== document.documentElement; node = parentOf(node)) {
      if (bingSearchPage && node.matches(BING_RESULT_SUBTITLE)) return node;
      if (BLOCK_TAGS.has(node.tagName)) return node;
      let display = styles.get(node);
      if (!display) {
        display = getComputedStyle(node).display;
        styles.set(node, display);
      }
      if (/^(block|flow-root|flex|grid|list-item|table-cell|table-caption)$/.test(display)) return node;
    }
    // Standalone inline text directly in body / an open shadow root.
    return element !== document.body && element !== document.documentElement ? element : null;
  }

  function readable(element) {
    if (!element?.isConnected || excluded(element)) return false;
    const style = getComputedStyle(element);
    if (style.display === "contents") return style.visibility === "visible" && Number(style.opacity) !== 0 && readable(parentOf(element));
    if (element.checkVisibility) {
      if (!element.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true })) return false;
    } else {
      if (style.display === "none" || style.visibility !== "visible" || Number(style.opacity) === 0 || !element.getClientRects().length) return false;
    }
    return element.getClientRects().length > 0;
  }

  function normalized(text) {
    return text.replace(/[\s\u200b]+/g, " ").trim();
  }

  function unitFor(element, styles = new Map()) {
    if (!readable(element)) return null;
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    const nodes = [];
    const chunks = [];
    const citations = new Set();
    let separated = false;
    let node;
    while ((node = walker.nextNode())) {
      if (node.nodeType === 1) {
        if (node.tagName === "BR") separated = true;
        continue;
      }
      if (!excluded(node.parentElement) && ownerOf(node.parentElement, styles) === element && readable(node.parentElement)) {
        if (separated) chunks.push(" ");
        nodes.push(node);
        const sup = node.parentElement.closest("sup");
        if (sup?.querySelector('a[href*="ref"], a[role="doc-biblioref"]')) {
          // AlphaFold 2 + superscript reference 1 must not become AlphaFold 21.
          if (!citations.has(sup)) chunks.push(`[${normalized(sup.textContent)}]`);
          citations.add(sup);
        } else chunks.push(node.nodeValue);
        separated = false;
      } else separated = true;
    }
    const text = normalized(chunks.join(""));
    if (text.length < MIN_TEXT_LENGTH || !/\p{L}/u.test(text)) return null;
    return { element, nodes, text };
  }

  function linkedParts(unit) {
    if (!unit?.element.querySelector("a[href]")) return null;
    const { element, nodes } = unit;
    const included = new Set(nodes);
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    const parts = [];
    let part, node;
    while ((node = walker.nextNode())) {
      if (node.tagName === "BR" || node.tagName === "IMG") { part = null; continue; }
      if (!included.has(node)) continue;
      const anchor = node.parentElement.closest("a[href]");
      const link = anchor && anchor !== element && element.contains(anchor) ? anchor : null;
      if (!part || part.link !== link) {
        part = { link, nodes: [], raw: "" };
        parts.push(part);
      }
      part.nodes.push(node);
      part.raw += node.data;
    }
    return parts.map(part => ({ ...part, text: normalized(part.raw) }));
  }

  function sameLinkedParts(parts, previous) {
    return parts.length === previous?.length && parts.every((part, index) =>
      part.text === previous[index].text && Boolean(part.link) === Boolean(previous[index].link));
  }

  function coverLinkedParts(element, parts, translations) {
    const edits = [];
    parts.forEach(({ nodes, raw, text }, index) => {
      const result = translations[index];
      if (!result || result === text) return;
      const first = nodes.find(node => node.data.trim());
      for (const node of nodes) {
        const original = node.data;
        const translated = node === first ? preserveSpacing(raw, result) : "";
        if (original !== translated) {
          edits.push({ node, parent: node.parentNode, original, translated });
          node.data = translated;
        }
      }
    });
    return { edits, text: element.textContent };
  }

  function preserveSpacing(raw, text) {
    return raw.match(/^\s*/)[0] + text + raw.match(/\s*$/)[0];
  }

  function coverIntact(box) {
    const inline = box.inlineCover;
    if (inline) return box.paragraph.textContent === inline.text && inline.edits.every(({ node, parent, translated }) =>
      node.parentNode === parent && box.paragraph.contains(node) && node.data === translated);
    return box.coverSpan?.parentNode === box.paragraph && box.paragraph.childNodes.length === 1;
  }

  function automaticCandidate(element) {
    if (bingSearchPage) return element.matches(BING_RESULT_SUBTITLE) && canCoverParagraph(element);
    // Reading mode concentrates on the article when one exists. Menus/forms
    // remain available on hover without generating requests during reading.
    const scope = element.getRootNode?.()?.host || element;
    if (element.closest('nav, footer, aside, [role="navigation"], [role="menu"], [role="complementary"], form, button, summary')) return false;
    if (document.querySelector("article, [role='article']")) return Boolean(scope.closest("article, [role='article']"));
    if (element.closest("header")) return false;
    const main = document.querySelector("main, [role='main']");
    return !main || main.contains(scope);
  }

  function findBlock(target) {
    if (!(target instanceof Element) || excluded(target)) return null;
    const styles = new Map();
    for (let element = ownerOf(target, styles); element && element !== document.body; element = parentOf(element)) {
      const unit = unitFor(element, styles);
      if (unit) return unit;
    }
    return null;
  }

  function sourceUnchanged(box) {
    return box.covered ? coverIntact(box) : unitFor(box.paragraph)?.text === box.paragraphText;
  }

  function invalidate(box) {
    box.requestId++;
    queue.delete(box);
    box.loading = false;
    box.translated = false;
    box.sameLanguage = false;
    box.error = false;
    box.dismissed = false;
    box.key = "";
    if (box.covered) box.toggleCover();
    box.linkedParts = null;
    box.linkedTranslations = null;
  }

  function discard(box) {
    invalidate(box);
    globalThis.MAS_reader?.remove(box.host.dataset.readerId);
    globalThis.MAS_quick?.hide(box);
    box.host.remove();
    boxes.delete(box.paragraph);
  }

  function mount(box) {
    const element = box.paragraph;
    const host = box.host;
    host.dataset.mode = box.automatic ? "auto" : "hover";
    const shadow = host.shadowRoot;
    host.toggleAttribute("data-context-toolbar", Boolean(globalThis.MAS_quick));
    shadow.querySelector(".pin").hidden = box.automatic;
    host.style.cssText = "display:none;box-sizing:border-box;text-align:left;";
    if (bingSearchPage) {
      document.documentElement.appendChild(host);
      return;
    }
    host.style.margin = "8px 0 14px";
    host.style.width = "100%";
    const parentTag = element.parentElement?.tagName;
    const complex = element.querySelector('p, div, section, ul, ol, table, figure, h1, h2, h3, h4, h5, h6');
    if (complex || ["TD", "TH", "LI", "DD", "DT", "FIGCAPTION", "CAPTION"].includes(element.tagName) ||
        ["TABLE", "TBODY", "THEAD", "TFOOT", "TR", "UL", "OL", "DL"].includes(parentTag)) {
      let anchor = box.nodes.at(-1);
      while (anchor?.parentNode && anchor.parentNode !== element) anchor = anchor.parentNode;
      if (anchor?.parentNode === element) anchor.after(host);
      else element.appendChild(host);
      box.canCover = false;
      box.coverButton.disabled = true;
    } else element.after(host);
    if (box.automatic) globalThis.MAS_reader?.remove(host.dataset.readerId);
    else mountReader(box);
    box.refit();
    host.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        if (box.covered) box.toggleCover();
        box.setPinned(false);
        box.dismissed = true;
        hideBox(box);
        globalThis.MAS_quick?.hide(box);
        event.stopPropagation();
      }
    });
  }

  function createBox(unit, automatic = false) {
    const { element, text, nodes } = unit;
    let box = boxes.get(element);
    if (box && !box.host.isConnected) { discard(box); box = null; }
    if (box) {
      if (box.paragraphText !== text && !box.covered) {
        invalidate(box);
        box.paragraphText = text;
        box.nodes = nodes;
      }
      if (box.automatic !== automatic) {
        globalThis.MAS_quick?.hide(box);
        box.automatic = automatic;
        mount(box);
        applyDisplay(box);
      }
      return box;
    }
    const hoverBoxes = [...boxes.values()].filter((item) => !item.automatic);
    if (!automatic && hoverBoxes.length >= MAX_HOVER_CACHE) {
      const victim = hoverBoxes.find((item) => !item.visible && !item.covered && !item.pinned && !item.loading);
      if (victim) discard(victim);
    }
    box = createTextBox();
    box.paragraph = element;
    box.paragraphText = text;
    box.nodes = nodes;
    box.automatic = automatic;
    // Replacing a reading paragraph is reversible; mixed containers, table
    // cells with controls and live widgets are always kept intact.
    box.canCover = canCoverParagraph(element);
    box.coverButton.title = box.canCover ? "可随时还原原文" : "此元素包含公式、控件或其他段落，保留原文显示译文";
    box.setSource(AUTO_SOURCE);
    box.setLanguage(language);
    boxes.set(element, box);
    mount(box);
    return box;
  }

  function keyFor(box) {
    return JSON.stringify([revision, box.paragraphText, box.getSource(), box.getLanguage(), box.providerSelect.value]);
  }

  function displayModeFor(box) {
    return box.localDisplayMode || (box.automatic || bingSearchPage ? displayMode : "bilingual");
  }

  function keepQuickBadge(box) {
    if (bingSearchPage) return;
    box.displaySelect.value = displayModeFor(box);
    box.displaySelect.querySelector('[value=translated]').disabled=!box.canCover;
    const inline = !['TD','TH','LI','DD','DT','CAPTION','BUTTON','SUMMARY','A'].includes(box.paragraph.tagName) && !['TABLE','TBODY','THEAD','TR','UL','OL','DL'].includes(box.paragraph.parentElement?.tagName);
    const anchorRect = () => {
      const node = box.coverSpan || (box.inlineCover ? box.paragraph : box.nodes.at(-1));
      if (!node?.isConnected) return box.paragraph.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(node);
      return [...range.getClientRects()].at(-1) || box.paragraph.getBoundingClientRect();
    };
    const controls = [box.sourceSelect, box.select, box.providerSelect, box.displaySelect, box.coverButton, box.origin, box.retry];
    globalThis.MAS_quick?.keepBadge({owner:box,element:box.paragraph,inline,observe:box.host.shadowRoot,
      label: box.paragraphText.slice(0, 40),
      rect:anchorRect, badgeRect:anchorRect,
      controls,
    });
  }

  function mountReader(box) {
    globalThis.MAS_reader?.mount(box.host, {
      kind: '网页段落', source: () => box.paragraphText, element: box.paragraph, hideHost: false,
      dismiss() { if(box.covered)box.toggleCover();box.dismissed = true;hideBox(box);globalThis.MAS_quick?.hide(box); },
    });
  }

  function hideBox(box) {
    box.visible = false;
    box.host.style.setProperty("display", "none", "important");
  }

  function applyDisplay(box) {
    if (bingSearchPage) {
      if (displayMode === "source" && box.covered) box.toggleCover();
      if (displayMode !== "source" && box.translated && !box.covered) box.toggleCover();
      return;
    }
    const mode = displayModeFor(box);
    box.modeNote.hidden = true;
    if (mode !== "translated" && box.covered) box.toggleCover();
    if (box.dismissed || (box.sameLanguage && !box.manualSource && !box.manualTarget)) {
      globalThis.MAS_quick?.hide(box);
      hideBox(box);
      return;
    }
    keepQuickBadge(box);
    if (mode === "source") {
      hideBox(box);
      return;
    }
    if (mode === "translated" && box.translated && box.translation) {
      if (box.canCover && !box.covered) box.toggleCover();
      if (box.covered) {
        hideBox(box);
        return;
      }
      box.modeNote.hidden = false;
    }
    box.visible = true;
    box.host.style.setProperty("display", "block", "important");
  }

  function enqueue(box) {
    if (!enabled || box.loading || !box.paragraphText || box.dismissed) return;
    if (displayModeFor(box) === "source") return;
    if ((box.translated || box.sameLanguage) && box.key === keyFor(box)) return;
    box.requestId++;
    box.key = keyFor(box);
    const needsLinkedParts = box.canCover && displayModeFor(box) === "translated" && box.paragraph.querySelector("a[href]");
    box.linkedParts = needsLinkedParts ? linkedParts(unitFor(box.paragraph)) : null;
    box.loading = true;
    box.setLoading();
    queue.add(box);
    // A microtask lets adjacent visible blocks join the same request.
    queueMicrotask(pump);
  }

  function withTimeout(promise) {
    let timer;
    return Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("请求超时，请重试")), 120000); }),
    ]).finally(() => clearTimeout(timer));
  }

  function requestTexts(box, texts) {
    return withTimeout(chrome.runtime.sendMessage({
      type: "TRANSLATE_TEXT_BLOCKS",
      texts,
      source: box.getSource(),
      target: box.getLanguage(),
      provider: box.providerSelect.value,
    }));
  }

  async function requestLinked(box, parts, isCurrent) {
    const translations = parts.map(part => part.text);
    const pending = parts.map((part, index) => /\p{L}/u.test(part.text) ? index : -1).filter(index => index >= 0);
    let skipped = true;
    for (let offset = 0; offset < pending.length;) {
      if (!isCurrent()) return null;
      const batch = [];
      let chars = 0;
      while (offset < pending.length && batch.length < 4) {
        const index = pending[offset];
        const length = parts[index].text.length;
        if (batch.length && chars + length > 7000) break;
        batch.push(index);
        chars += length;
        offset++;
      }
      const result = await requestTexts(box, batch.map(index => parts[index].text));
      if (!result?.ok) return result;
      for (let i = 0; i < batch.length; i++) {
        if (result.skipped?.[i]) continue;
        const text = String(result.translations?.[i] ?? "").trim();
        if (!text) return { ok: false, reason: "服务未返回完整的链接译文，请重试" };
        translations[batch[i]] = text;
        skipped = false;
      }
    }
    const paragraph = parts.map(({ raw, text }, index) =>
      text === translations[index] ? raw : preserveSpacing(raw, translations[index])).join("");
    return { ok: true, translations: [paragraph], skipped: [skipped], linkedTranslations: translations };
  }

  function pump() {
    if (!enabled) { queue.clear(); return; }
    while (activeRequests < 2 && queue.size) {
      const first = [...queue].find((box) => box.visible && !box.automatic) || queue.values().next().value;
      const group = [];
      let chars = 0;
      for (const box of [first, ...queue]) {
        if (group.includes(box) || !queue.has(box)) continue;
        if (box.getSource() !== first.getSource() || box.getLanguage() !== first.getLanguage() || box.providerSelect.value !== first.providerSelect.value) continue;
        if (group.length && (group[0].linkedParts || box.linkedParts)) continue;
        if (group.length >= 4 || (group.length && chars + box.paragraphText.length > 7000)) continue;
        queue.delete(box);
        if (displayModeFor(box) === "source") { box.loading = false; continue; }
        if (!box.paragraph.isConnected || box.dismissed) { box.loading = false; continue; }
        group.push(box);
        chars += box.paragraphText.length;
      }
      if (!group.length) continue;
      const requests = group.map((box) => ({ box, id: box.requestId, key: box.key }));
      activeRequests++;
      const leader = requests[0];
      const request = leader.box.linkedParts
        ? requestLinked(leader.box, leader.box.linkedParts, () => current(leader.box, leader.id, leader.key))
        : requestTexts(leader.box, group.map((box) => box.paragraphText));
      request.then((response) => {
        requests.forEach(({ box, id, key }, index) => {
          if (!current(box, id, key)) return;
          if (!response?.ok) { box.setError(response?.reason || "未知错误"); return; }
          if (response.skipped?.[index]) {
            box.sameLanguage = true;
            box.translation = "";
            if (box.manualSource || box.manualTarget) box.setNotice(`原文已是${box.getLanguage()}，无需翻译。`);
            applyDisplay(box);
            return;
          }
          const text = String(response.translations?.[index] ?? "").trim();
          if (text) { box.setText(text, response.linkedTranslations); applyDisplay(box); }
          else box.setError("服务未返回该段译文，请重试");
        });
      }).catch((error) => {
        for (const { box, id, key } of requests) if (current(box, id, key)) box.setError(String(error?.message || error));
      }).finally(() => {
        for (const { box, id } of requests) if (box.requestId === id) box.loading = false;
        activeRequests--;
        pump();
      });
    }
  }

  function current(box, id, key) {
    return enabled && box.requestId === id && box.key === key && keyFor(box) === key &&
      box.host.isConnected && box.paragraph.isConnected && sourceUnchanged(box);
  }

  function showBox(unit) {
    if (!hoverEnabled) return;
    if (bingSearchPage && (displayMode === "source" || !automaticCandidate(unit.element))) return;
    const box = createBox(unit, autoEnabled && displayMode !== "source" && automaticCandidate(unit.element));
    if (!box.manualSource && !box.manualTarget && globalThis.MAS_providers?.likelySameLanguage?.(unit.text, box.getLanguage())) return;
    box.dismissed = false;
    if (box.sameLanguage && box.key === keyFor(box)) return;
    if (!box.automatic && !bingSearchPage) mountReader(box);
    if (!bingSearchPage || !box.error) enqueue(box);
    applyDisplay(box);
  }

  function ownHost(target) {
    return target?.closest?.('[data-maslingo-textbox]') || target?.getRootNode?.()?.host?.closest?.('[data-maslingo-textbox]');
  }

  function onPointerOver(event) {
    if (!hoverEnabled || event.buttons || !window.getSelection()?.isCollapsed) return;
    const target = event.composedPath()[0];
    if(globalThis.MAS_quick?.isOwn(target))return;
    if (ownHost(target)) return;
    if (target?.closest?.('input, textarea, select, [contenteditable], [role="textbox"]')) return;
    const unit = findBlock(target);
    if (!unit || unit.element === hoverBlock) return;
    hoverBlock = unit.element;
    clearTimeout(showTimer);
    showTimer = setTimeout(() => {
      if (hoverEnabled && hoverBlock === unit.element && unit.element.isConnected && window.getSelection()?.isCollapsed) {
        showBox(unitFor(unit.element) || unit);
      }
    }, HOVER_DELAY);
  }

  function onPointerOut(event) {
    if (!hoverBlock) return;
    const to = event.relatedTarget;
    if (to && hoverBlock.contains(to)) return;
    hoverBlock = null;
    clearTimeout(showTimer);
  }

  function onFocus(event) {
    if (!hoverEnabled) return;
    const target = event.composedPath()[0];
    if (ownHost(target) || target?.matches?.('input, textarea, select, [contenteditable]')) return;
    const unit = findBlock(target);
    if (unit) showBox(unit);
  }

  function observeRoot(root) {
    if (observedRoots.has(root)) return;
    observedRoots.add(root);
    mutationObserver?.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["hidden", "aria-hidden", "class", "style", "open"] });
  }

  function scan() {
    if (!enabled) return;
    const next = new Map();
    const styles = new Map();
    const visit = (root) => {
      observeRoot(root);
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          if (node.nodeType === 1 && (SKIP_TAGS.has(node.tagName.toUpperCase()) || isOwnUi(node) || node.isContentEditable)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      });
      let node;
      while ((node = walker.nextNode())) {
        if (node.nodeType === 1) {
          if (node.shadowRoot) visit(node.shadowRoot);
          continue;
        }
        if (!node.nodeValue.trim() || excluded(node.parentElement)) continue;
        const element = ownerOf(node.parentElement, styles);
        if (element && !next.has(element) && readable(element)) {
          const unit = unitFor(element, styles);
          if (unit) next.set(element, unit);
        }
      }
    };
    visit(document.body);
    for (const [element, box] of boxes) {
      if (!element.isConnected) { discard(box); continue; }
      if (bingSearchPage && !element.matches(BING_RESULT_SUBTITLE)) { discard(box); continue; }
      const wasDisplayed = box.visible || box.covered;
      const wasCovered = box.covered;
      if (box.covered) {
        if (coverIntact(box)) continue;
        invalidate(box);
        const restored = unitFor(element);
        if (restored) next.set(element, restored);
        else next.delete(element);
      }
      const unit = next.get(element);
      if (!unit) { discard(box); continue; }
      if (unit.text !== box.paragraphText || wasCovered) {
        if (!wasCovered) invalidate(box);
        box.paragraphText = unit.text;
        box.nodes = unit.nodes;
        box.canCover = canCoverParagraph(element) && !element.contains(box.host);
        if (wasDisplayed && (!box.automatic || nearby.has(element))) {
          enqueue(box);
          applyDisplay(box);
        }
      }
    }
    for (const element of units.keys()) if (!next.has(element)) {
      visibilityObserver?.unobserve(element);
      nearby.delete(element);
    }
    units.clear();
    for (const [element, unit] of next) {
      units.set(element, unit);
      if (!autoEnabled || !automaticCandidate(element)) continue;
      visibilityObserver?.observe(element);
      if (nearby.has(element)) autoShow(unit);
    }
  }

  function autoShow(unit) {
    if (!autoEnabled || !automaticCandidate(unit.element) || !readable(unit.element)) return;
    if (displayMode === "source") return;
    if (globalThis.MAS_providers?.likelySameLanguage?.(unit.text, language)) return;
    const box = createBox(unit, true);
    if (box.dismissed || (box.sameLanguage && box.key === keyFor(box))) return;
    // Failures wait for an explicit retry, rather than looping on mutations.
    if (!box.error) enqueue(box);
    applyDisplay(box);
  }

  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 180);
  }

  function onMutations(records) {
    if (records.some((record) => !isOwnUi(record.target) && (
      record.type === "characterData" || record.type === "attributes" ||
      [...record.addedNodes, ...record.removedNodes].some((node) => !isOwnUi(node))
    ))) scheduleScan();
  }

  function onSelection() {
    if (!window.getSelection()?.isCollapsed) {
      hoverBlock = null;
      clearTimeout(showTimer);
    }
  }

  function onEscape(event) {
    if (event.key !== "Escape") return;
    clearTimeout(showTimer);
    hoverBlock = null;
  }

  function removeAll() {
    clearTimeout(showTimer);
    clearTimeout(scanTimer);
    hoverBlock = null;
    visibilityObserver?.disconnect();
    mutationObserver?.disconnect();
    observedRoots.clear();
    queue.clear();
    for (const box of [...boxes.values()]) discard(box);
    units.clear();
    nearby.clear();
  }

  function retranslateAll() {
    revision++;
    for (const box of boxes.values()) {
      const wasDisplayed = box.visible || box.covered;
      if (!box.manualTarget) box.setLanguage(language);
      invalidate(box);
      if (wasDisplayed && (!box.automatic || nearby.has(box.paragraph))) {
        enqueue(box);
        applyDisplay(box);
      }
    }
    scheduleScan();
  }

  async function sync(changed = false) {
    const version = ++syncVersion;
    const cfg = await readStore(["hoverTranslate", "webAutoTranslate", "webDisplayMode", "targetLanguage", "translationProvider", "translationMode"]);
    if (version !== syncVersion) return;
    language = cfg.targetLanguage || "简体中文";
    const oldDisplayMode = displayMode;
    displayMode = globalThis.MAS_webDisplayMode(cfg.webDisplayMode);
    const providerId = globalThis.MAS_providers.resolveProviderId(cfg);
    defaultProvider = providerId;
    const configured = providerId !== "none";
    const oldAuto = autoEnabled;
    const oldHover = hoverEnabled;
    autoEnabled = Boolean(cfg.webAutoTranslate) && configured;
    hoverEnabled = Boolean(cfg.hoverTranslate) && configured;
    const wanted = autoEnabled || hoverEnabled;
    if (wanted && !enabled) {
      enabled = true;
      mutationObserver = new MutationObserver(onMutations);
      visibilityObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          const visible = entry.isIntersecting && entry.intersectionRect.width > 0 && entry.intersectionRect.height > 0;
          if (visible) nearby.add(entry.target);
          else nearby.delete(entry.target);
          if (visible && units.has(entry.target)) autoShow(units.get(entry.target));
        }
      }, { rootMargin: "320px 0px" });
      document.addEventListener("pointerover", onPointerOver, true);
      document.addEventListener("pointerout", onPointerOut, true);
      document.addEventListener("focusin", onFocus, true);
      document.addEventListener("selectionchange", onSelection);
      document.addEventListener("keydown", onEscape);
      scan();
    } else if (!wanted && enabled) {
      enabled = false;
      document.removeEventListener("pointerover", onPointerOver, true);
      document.removeEventListener("pointerout", onPointerOut, true);
      document.removeEventListener("focusin", onFocus, true);
      document.removeEventListener("selectionchange", onSelection);
      document.removeEventListener("keydown", onEscape);
      removeAll();
    } else if (enabled) {
      if (oldAuto && !autoEnabled) {
        visibilityObserver.disconnect();
        nearby.clear();
        for (const box of [...boxes.values()]) if (box.automatic) discard(box);
      }
      if (oldHover && !hoverEnabled) {
        for (const box of [...boxes.values()]) if (!box.automatic) discard(box);
      }
      if (changed) retranslateAll();
      if (oldDisplayMode !== displayMode) {
        for (const box of boxes.values()) {
          if (!box.automatic && !bingSearchPage) continue;
          if (displayModeFor(box) === "source" && queue.delete(box)) box.loading = false;
          applyDisplay(box);
        }
      }
      scan();
    }
  }

  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area !== "local") return;
    const configChanged = ["targetLanguage", "translationProvider", "translationMode", "translationStrength", "translationModel", "translationModelProvider", "translationGlossary", "translationApiKey", "translationAppId", "translationEndpoint"].some((key) => changes[key]);
    if (changes.hoverTranslate || changes.webAutoTranslate || changes.webDisplayMode || configChanged) sync(configChanged).catch(() => {});
  });

  globalThis.MAS_text = { installed: true, sync, retranslateAll };
  sync().catch(() => {});
})();
