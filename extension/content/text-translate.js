// Webpage paragraph translation, on hover.
//
// The old version scanned every paragraph on load and translated the whole
// page. That is useful when the page is a wall of prose, but it costs a request
// for every block before the user has looked at any of them, and it misses text
// outside the handful of tags the scanner knew. This version translates the
// paragraph under the pointer: hover a block for a moment, a white card opens
// under it, and moving away hides it. Results are cached per block, so returning
// to the same paragraph is instant.
//
// Cards are plain divs with shadow roots. The isolated world does not expose
// customElements, and a shadow root keeps a host page's global CSS from
// reshaping the card.

(() => {
  "use strict";
  if (globalThis.MAS_text?.installed) return;

  const AUTO_SOURCE = "自动识别";
  const MIN_TEXT_LENGTH = 4;
  const MIN_WIDTH = 40;
  const MIN_HEIGHT = 6;
  const MAX_BLOCKS = 80;
  const HOVER_DELAY = 220;
  const HIDE_DELAY = 320;
  const SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "TEXTAREA", "INPUT", "SELECT",
    "OPTION", "CODE", "PRE", "KBD", "SAMP", "SVG", "CANVAS", "VIDEO", "AUDIO",
    "IFRAME", "OBJECT", "EMBED", "HEAD", "META", "LINK", "BUTTON", "A",
    "TABLE", "TR", "TD", "TH",
  ]);

  let enabled = false;
  let resizeTimer = null;
  let language = "简体中文";
  let hoverBlock = null;
  let showTimer = null;
  let hideTimer = null;
  const boxes = new Map(); // paragraph element -> box record
  const languages = () =>
    (globalThis.MAS_providers?.languages || [{ name: "简体中文" }]).map((item) => item.name);
  const sourceLanguages = () =>
    [globalThis.MAS_providers?.autoSource || AUTO_SOURCE, ...languages()];
  const readStore = (keys) => chrome.storage?.local?.get?.(keys).catch(() => ({}));

  function isOwnUi(node) {
    const element = node?.nodeType === 1 ? node : node?.parentElement;
    return Boolean(element?.closest?.(
      "[data-maslingo-textbox], #maslingo-panel, #maslingo-selection-popup, " +
      "#maslingo-layer, .maslingo-overlay-text-canvas",
    ));
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
        :host { display: block; }
        .card {
          background: #ffffff;
          border: 1px solid rgba(15, 23, 42, 0.12);
          border-radius: 10px;
          overflow: hidden;
          box-shadow: 0 1px 2px rgba(15, 23, 42, 0.05);
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
          background: #f8fafc;
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
        .body { padding: 10px 12px; }
        .text {
          margin: 0;
          white-space: pre-wrap;
          overflow-wrap: anywhere;
        }
        .text[data-state="loading"] { color: #64748b; }
        .text[data-state="error"] { color: #b42318; }
        .collapsed .body { display: none; }
        .collapsed .head { border-bottom: 0; }
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
          <button class="toggle" type="button" aria-expanded="true" aria-label="收起译文">▾</button>
        </div>
        <div class="body"><p class="text" role="status" aria-live="polite"></p></div>
      </div>
    `;

    const card = shadow.querySelector(".card");
    const text = shadow.querySelector(".text");
    const select = shadow.querySelector(".lang");
    const sourceSelect = shadow.querySelector(".src");
    const coverButton = shadow.querySelector(".cover");
    const toggle = shadow.querySelector(".toggle");
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

    const box = {
      host,
      card,
      text,
      select,
      sourceSelect,
      coverButton,
      paragraph: null,
      translation: "",
      paragraphText: "",
      covered: false,
      originalNodes: null,
      coverSpan: null,
      collapsed: false,
      translated: false,
      loading: false,
      sameLanguage: false,
      error: false,
      visible: false,
      requestId: 0,
      manualTarget: false,
      manualSource: false,
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
        text.dataset.state = "loading";
        text.textContent = "翻译中…";
        box.translated = false;
        box.sameLanguage = false;
        if (!box.covered) coverButton.disabled = true;
      },
      setText(value) {
        text.dataset.state = "done";
        text.textContent = value || "";
        box.translation = value || "";
        box.translated = true;
        box.sameLanguage = false;
        box.error = false;
        coverButton.disabled = !box.translation;
        if (box.covered && box.coverSpan) box.coverSpan.textContent = box.translation;
      },
      setNotice(message) {
        text.dataset.state = "done";
        text.textContent = message;
        box.translation = "";
        box.translated = false;
        box.sameLanguage = true;
        box.error = false;
        coverButton.disabled = true;
      },
      setError(message) {
        text.dataset.state = "error";
        text.textContent = "翻译失败：" + message;
        box.translation = "";
        box.translated = false;
        box.error = true;
        if (!box.covered) coverButton.disabled = true;
      },
      /**
       * Replace the paragraph's own text with the translation (or put the
       * original back). The original child nodes are parked in a fragment, so
       * links and inline markup survive a round trip.
       */
      toggleCover() {
        if (!box.paragraph || (!box.translation && !box.covered)) return;
        if (!box.covered) {
          const fragment = document.createDocumentFragment();
          while (box.paragraph.firstChild) fragment.appendChild(box.paragraph.firstChild);
          box.originalNodes = fragment;
          const span = document.createElement("span");
          span.dataset.maslingoCover = "1";
          span.style.whiteSpace = "pre-wrap";
          span.textContent = box.translation;
          box.paragraph.appendChild(span);
          box.coverSpan = span;
          box.covered = true;
          if (!box.collapsed) box.toggleCollapsed();
        } else {
          box.coverSpan?.remove();
          if (box.originalNodes) box.paragraph.appendChild(box.originalNodes);
          box.originalNodes = null;
          box.coverSpan = null;
          box.covered = false;
          if (box.collapsed) box.toggleCollapsed();
        }
        coverButton.textContent = box.covered ? "还原原文" : "覆盖至原文";
        coverButton.setAttribute("aria-pressed", box.covered ? "true" : "false");
      },
    };

    select.addEventListener("change", () => {
      fitSelect(select);
      box.manualTarget = true;
      if (box.covered) box.toggleCover();
      translateBox(box, box.paragraphText);
    });
    sourceSelect.addEventListener("change", () => {
      fitSelect(sourceSelect);
      box.manualSource = true;
      if (box.covered) box.toggleCover();
      translateBox(box, box.paragraphText);
    });
    coverButton.addEventListener("click", () => box.toggleCover());
    toggle.addEventListener("click", () => box.toggleCollapsed());
    // Keep the card alive while one of its controls (especially a native
    // language select and its popup) has focus; pointer moves alone should not
    // yank it away mid-choice.
    host.addEventListener("focusin", () => clearTimeout(hideTimer));
    host.addEventListener("focusout", () => {
      hideTimer = setTimeout(() => {
        if (!host.matches(":focus-within")) hideBox(box);
      }, HIDE_DELAY);
    });
    shadow.querySelector(".title").addEventListener("click", (event) => {
      if (event.target.closest("select")) return;
      box.toggleCollapsed();
    });
    return box;
  }

  function blockish(element) {
    const display = getComputedStyle(element).display;
    return /(^|\s)(block|flex|grid|list-item|table-cell|flow-root)(\s|$)/.test(display) ||
      ["P", "LI", "BLOCKQUOTE", "DD", "FIGCAPTION", "H1", "H2", "H3", "H4", "H5", "H6",
        "ARTICLE", "SECTION", "DIV"].includes(element.tagName);
  }

  /** A paragraph is a visible block of prose, not a wrapper around blocks. */
  function isCandidate(element) {
    if (!(element instanceof HTMLElement)) return false;
    if (element === document.body || element === document.documentElement) return false;
    if (SKIP_TAGS.has(element.tagName)) return false;
    if (element.isContentEditable) return false;
    if (isOwnUi(element)) return false;
    if (!blockish(element)) return false;
    const text = (element.innerText || "").trim();
    if (text.length < MIN_TEXT_LENGTH) return false;
    if (!/[\p{L}\p{N}]/u.test(text)) return false;
    // A wrapper around other blocks is not a paragraph: the inner blocks will
    // be picked up instead (and translating both would duplicate the text).
    for (const child of element.children) {
      const display = getComputedStyle(child).display;
      if (display !== "inline" && display !== "inline-block" && display !== "contents") {
        return false;
      }
    }
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
      return false;
    }
    const rect = element.getBoundingClientRect();
    if (rect.width < MIN_WIDTH || rect.height < MIN_HEIGHT) return false;
    return true;
  }

  function findBlock(target) {
    let element = target instanceof Element ? target : target?.parentElement;
    while (element && element !== document.body && element !== document.documentElement) {
      if (isCandidate(element)) return element;
      element = element.parentElement;
    }
    return null;
  }

  function createBox(element) {
    const existing = boxes.get(element);
    if (existing?.host.isConnected) return existing;
    if (existing) boxes.delete(element);
    if (boxes.size >= MAX_BLOCKS) {
      for (const [key, box] of boxes) {
        if (!box.visible) {
          box.host.remove();
          boxes.delete(key);
          break;
        }
      }
    }
    const box = createTextBox();
    box.paragraph = element;
    box.setSource(AUTO_SOURCE);
    box.setLanguage(language);
    box.paragraphText = (element.innerText || "").trim();
    const rect = element.getBoundingClientRect();
    box.host.style.width = Math.round(rect.width) + "px";
    box.host.style.maxWidth = "100%";
    box.host.style.margin = "6px 0 12px";
    box.host.style.display = "none";
    const parent = element.parentElement;
    if (parent) {
      const display = getComputedStyle(parent).display;
      if (display.includes("flex")) box.host.style.flex = "1 1 100%";
      else if (display.includes("grid")) box.host.style.gridColumn = "1 / -1";
    }
    element.insertAdjacentElement("afterend", box.host);
    box.refit();
    boxes.set(element, box);
    return box;
  }

  async function translateBox(box, text) {
    if (!enabled || !text) return;
    const requestId = (box.requestId || 0) + 1;
    box.requestId = requestId;
    box.loading = true;
    box.setLoading();
    try {
      const response = await chrome.runtime.sendMessage({
        type: "TRANSLATE_TEXT_BLOCKS",
        texts: [text],
        source: box.getSource(),
        target: box.getLanguage(),
      });
      if (box.requestId !== requestId || !box.host.isConnected) return;
      if (!response?.ok) {
        box.setError(response?.reason || "未知错误");
        return;
      }
      if (response.skipped?.[0]) {
        box.sameLanguage = true;
        box.translation = "";
        if (box.manualTarget || box.manualSource) {
          box.setNotice(`原文已是${box.getLanguage()}，无需翻译。`);
        } else {
          box.visible = false;
          box.host.style.display = "none";
        }
        return;
      }
      box.setText(String(response.translations?.[0] ?? "").trim());
    } catch (error) {
      if (box.requestId === requestId) box.setError(String(error?.message || error));
    } finally {
      if (box.requestId === requestId) box.loading = false;
    }
  }

  function showBox(element) {
    if (!enabled) return;
    const prior = boxes.get(element);
    const target = prior?.getLanguage() || language;
    if (!prior?.translated && globalThis.MAS_providers?.likelySameLanguage?.(
      (element.innerText || "").trim(),
      target,
    )) {
      if (prior) hideBox(prior, true);
      return;
    }
    const box = createBox(element);
    if (!box || !box.host.isConnected) return;
    if (box.sameLanguage) return;
    clearTimeout(hideTimer);
    box.visible = true;
    box.host.style.display = "block";
    if (!box.translated && !box.loading) translateBox(box, box.paragraphText);
  }

  function hideBox(box, force = false) {
    if (!box) return;
    if (!force && box.host.matches?.(":focus-within")) return;
    box.visible = false;
    box.host.style.display = "none";
  }

  function nodeInBox(box, node) {
    if (!box || !node) return false;
    if (box.host.contains(node)) return true;
    return node.getRootNode?.()?.host === box.host;
  }

  function onPointerOver(event) {
    if (!enabled) return;
    const target = event.target;
    if (target instanceof Element) {
      if (target.closest("input, textarea, select, [contenteditable='true']")) return;
      const host = target.closest?.("[data-maslingo-textbox]");
      if (host) {
        const box = [...boxes.values()].find((item) => item.host === host);
        if (box) {
          clearTimeout(hideTimer);
          return;
        }
      }
    }
    const block = findBlock(target);
    if (!block || block === hoverBlock) return;
    // One card at a time. The pointerout for the old paragraph may already
    // have nulled `hoverBlock`, so retire every other visible card rather than
    // relying on the previous pointer target.
    for (const box of boxes.values()) {
      if (box.visible && box.paragraph !== block) hideBox(box, true);
    }
    hoverBlock = block;
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    showTimer = setTimeout(() => {
      if (enabled && hoverBlock === block) showBox(block);
    }, HOVER_DELAY);
  }

  function onPointerOut(event) {
    if (!enabled || !hoverBlock) return;
    const block = hoverBlock;
    const box = boxes.get(block);
    const to = event.relatedTarget;
    if (to && (block.contains(to) || nodeInBox(box, to))) return;
    hoverBlock = null;
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (hoverBlock) return;
      hideBox(box);
    }, HIDE_DELAY);
  }

  function keepWidths() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      for (const [element, box] of boxes) {
        if (!element.isConnected || !box.host.isConnected) {
          boxes.delete(element);
          continue;
        }
        const rect = element.getBoundingClientRect();
        if (rect.width >= MIN_WIDTH) box.host.style.width = Math.round(rect.width) + "px";
      }
    }, 150);
  }

  function removeAll() {
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    showTimer = null;
    hideTimer = null;
    hoverBlock = null;
    for (const [element, box] of boxes) {
      if (box.covered) box.toggleCover();
      box.host.remove();
      boxes.delete(element);
    }
    boxes.clear();
  }

  /** Mark cached cards stale; visible ones re-request now, hidden ones later. */
  function retranslateAll() {
    for (const [element, box] of boxes) {
      if (!box.manualTarget) box.setLanguage(language);
      if (box.covered) box.toggleCover();
      box.translated = false;
      box.sameLanguage = false;
      box.error = false;
      if (box.visible) translateBox(box, box.paragraphText || (element.innerText || "").trim());
    }
  }

  async function sync() {
    const cfg = await readStore([
      "hoverTranslate", "targetLanguage", "translationProvider", "translationMode",
    ]);
    language = cfg.targetLanguage || "简体中文";
    const provider = String(cfg.translationProvider || "");
    const configured = provider ? provider !== "none" : String(cfg.translationMode || "none") !== "none";
    const wanted = Boolean(cfg.hoverTranslate) && configured;
    if (wanted && !enabled) {
      enabled = true;
      document.addEventListener("pointerover", onPointerOver, true);
      document.addEventListener("pointerout", onPointerOut, true);
      window.addEventListener("resize", keepWidths, { passive: true });
    } else if (!wanted && enabled) {
      enabled = false;
      document.removeEventListener("pointerover", onPointerOver, true);
      document.removeEventListener("pointerout", onPointerOut, true);
      window.removeEventListener("resize", keepWidths);
      removeAll();
    }
  }

  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.hoverTranslate || changes.translationProvider || changes.translationMode) {
      sync().catch(() => {});
      return;
    }
    if (!enabled) return;
    if (changes.targetLanguage) {
      language = changes.targetLanguage.newValue || "简体中文";
      retranslateAll();
    } else if (
      changes.translationStrength || changes.translationModel ||
      changes.translationModelProvider || changes.translationGlossary ||
      changes.translationApiKey || changes.translationEndpoint
    ) {
      retranslateAll();
    }
  });

  globalThis.MAS_text = { installed: true, sync, retranslateAll };
  sync().catch(() => {});
})();
