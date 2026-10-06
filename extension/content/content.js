// Marks this frame as carrying the extension's scripts. The popup probes for it
// to tell "never injected here" apart from "injected by a previous version of
// the extension and now orphaned", which is what happens when the extension is
// reloaded while a page stays open. The two look identical from the popup and
// need opposite advice: inject, or refresh the page.
globalThis.__OMT_LOADED__ = true;

let selecting = false;
let dragging = false;
let startX = 0;
let startY = 0;
let selectionBox = null;
let selectionRect = null;
let selectionSize = null;
let activeRequestId = null;
let resultContents = [];
let resultPanels = [];
let activePort = null;
let keepAliveTimer = null;
let requestTimeout = null;
let recognizedResultReady = false;
let activePageMode = false;
let busyPanel = null;
// Mirrors the "显示识别到的日文原文" setting. With translation off this is what
// makes recognition visible at all — otherwise a successful run leaves the page
// pixel-identical and looks like nothing happened.
let showSourceText = true;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "START_SELECT") startSelect();
  if (message.type === "START_AUTO") startAutoRecognition();
  if (message.type === "RECOGNITION_RESULT") showRecognitionResult(message, activePageMode);
  if (message.type === "TRANSLATION_RESULT") showTranslationResult(message);
  if (message.type === "PING") return;
  if (message.type === "AUTO_STATUS") {
    // The popup polls this while it is open; it must never be slower than the
    // poll interval, so it only reads counters.
    sendResponse(OMT_auto.stats());
    return true;
  }
  if (message.type === "AUTO_DIAG") {
    sendResponse(OMT_auto.diagnostics());
    return true;
  }
  return undefined;
});

function startSelect() {
  if (selecting) return;
  selecting = true;
  dragging = false;
  selectionBox = document.createElement("div");
  selectionBox.className = "mt-selection";
  selectionRect = document.createElement("div");
  selectionRect.className = "mt-selection-rect";
  selectionSize = document.createElement("span");
  selectionSize.className = "mt-selection-size";
  selectionRect.appendChild(selectionSize);
  selectionBox.appendChild(selectionRect);
  selectionBox.addEventListener("pointerdown", onPointerDown);
  selectionBox.addEventListener("pointermove", onPointerMove);
  selectionBox.addEventListener("pointerup", onPointerUp);
  selectionBox.addEventListener("pointercancel", cancelSelection);
  document.addEventListener("keydown", onSelectionKeyDown, true);
  document.body.appendChild(selectionBox);
}

function stopEvent(event) {
  event.preventDefault();
  event.stopPropagation();
}

function onPointerDown(event) {
  stopEvent(event);
  if (event.button !== 0) return;
  dragging = true;
  startX = event.clientX;
  startY = event.clientY;
  selectionBox.setPointerCapture(event.pointerId);
  updateSelection(event.clientX, event.clientY);
}

function onPointerMove(event) {
  if (!selecting || !dragging) return;
  stopEvent(event);
  updateSelection(event.clientX, event.clientY);
}

function updateSelection(x, y) {
  const left = Math.min(startX, x);
  const top = Math.min(startY, y);
  const width = Math.abs(x - startX);
  const height = Math.abs(y - startY);
  Object.assign(selectionRect.style, {
    left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px`
  });
  selectionSize.textContent = `${Math.round(width)} × ${Math.round(height)}`;
}

function onPointerUp(event) {
  if (!selecting || !dragging) return;
  stopEvent(event);
  dragging = false;
  const rect = {
    left: Math.min(startX, event.clientX),
    top: Math.min(startY, event.clientY),
    width: Math.abs(startX - event.clientX),
    height: Math.abs(startY - event.clientY)
  };
  finishSelection();
  if (rect.width >= 20 && rect.height >= 20) startRecognition(rect);
}

function onSelectionKeyDown(event) {
  if (event.key === "Escape") cancelSelection(event);
}

function cancelSelection(event) {
  if (event) stopEvent(event);
  finishSelection();
}

function finishSelection() {
  selecting = false;
  dragging = false;
  document.removeEventListener("keydown", onSelectionKeyDown, true);
  if (selectionBox) {
    selectionBox.removeEventListener("pointerdown", onPointerDown);
    selectionBox.removeEventListener("pointermove", onPointerMove);
    selectionBox.removeEventListener("pointerup", onPointerUp);
    selectionBox.removeEventListener("pointercancel", cancelSelection);
    selectionBox.remove();
  }
  selectionBox = null;
  selectionRect = null;
  selectionSize = null;
}

function startAutoRecognition() {
  const mediaRect = findPrimaryMediaRect();
  startRecognition(
    {left: 0, top: 0, width: window.innerWidth, height: window.innerHeight},
    true,
    mediaRect
  );
}

function findPrimaryMediaRect() {
  const viewportArea = window.innerWidth * window.innerHeight;
  const minimumArea = viewportArea * 0.08;
  const mediaSelector = "img, canvas, video, svg image, [role='img']";
  const candidates = new Map();
  const addCandidate = (element, isMediaElement) => {
    const bounds = element.getBoundingClientRect();
    const left = Math.max(0, bounds.left);
    const top = Math.max(0, bounds.top);
    const right = Math.min(window.innerWidth, bounds.right);
    const bottom = Math.min(window.innerHeight, bounds.bottom);
    const candidate = {
      left,
      top,
      width: Math.max(0, right - left),
      height: Math.max(0, bottom - top),
      isMediaElement
    };
    // No upper size limit on purpose: a manga page read at full size fills the
    // whole viewport, which is the *normal* case, not a reason to refuse. There
    // used to be an 80% cap here and it rejected exactly that.
    if (
      candidate.width < 180 ||
      candidate.height < 180 ||
      candidate.width * candidate.height < minimumArea
    ) return;
    const key = `${candidate.left}:${candidate.top}:${candidate.width}:${candidate.height}`;
    const existing = candidates.get(key);
    if (!existing || isMediaElement) candidates.set(key, candidate);
  };
  for (const element of document.querySelectorAll(mediaSelector)) {
    addCandidate(element, true);
  }
  for (const element of document.querySelectorAll("*")) {
    const bounds = element.getBoundingClientRect();
    const width = Math.max(0, Math.min(window.innerWidth, bounds.right) - Math.max(0, bounds.left));
    const height = Math.max(0, Math.min(window.innerHeight, bounds.bottom) - Math.max(0, bounds.top));
    if (width < 180 || height < 180 || width * height < minimumArea) continue;
    if (/url\(|image-set\(/i.test(getComputedStyle(element).backgroundImage)) {
      addCandidate(element, false);
    }
  }
  return [...candidates.values()]
    .sort((a, b) =>
      Number(b.isMediaElement) - Number(a.isMediaElement) ||
      b.width * b.height - a.width * a.height
    )[0] || null;
}

function startRecognition(rect, detectPage = false, mediaRect = null) {
  dismissResults();
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  activeRequestId = requestId;
  activePageMode = detectPage;
  resultContents = [];
  resultPanels = [];
  try {
    const port = chrome.runtime.connect({name: "manga-recognition"});
    activePort = port;
    port.onMessage.addListener(message => {
      if (message.type === "CAPTURE_READY" && message.requestId === requestId) {
        showBusy(rect, detectPage);
      }
      if (message.type === "RECOGNITION_RESULT") showRecognitionResult(message, detectPage);
      if (message.type === "TRANSLATION_RESULT") showTranslationResult(message);
    });
    port.onDisconnect.addListener(() => {
      if (activePort !== port || activeRequestId !== requestId) return;
      const reason = chrome.runtime.lastError?.message || "后台识别连接已断开";
      if (recognizedResultReady) {
        console.warn("翻译连接已断开，保留 OCR 原文：", reason);
        clearOverlay();
        showToast(`翻译连接已断开，已保留日文原文：${reason}`, "error");
        closeRequestPort();
      } else {
        console.warn("OCR 通道已断开，等待后台结果通过消息通道返回：", reason);
        if (keepAliveTimer) clearInterval(keepAliveTimer);
        keepAliveTimer = null;
        activePort = null;
      }
    });
    keepAliveTimer = setInterval(() => {
      if (activePort === port) port.postMessage({type: "KEEPALIVE", requestId});
    }, 10000);
    requestTimeout = setTimeout(
      () => failRecognition(requestId, "识别超时，请重试"),
      detectPage ? 360000 : 180000
    );
    recognizedResultReady = false;
    port.postMessage({
      type: detectPage ? "RECOGNIZE_PAGE" : "RECOGNIZE_REGION",
      rect,
      mediaRect,
      requestId,
      viewport: {width: window.innerWidth, height: window.innerHeight}
    });
  } catch (error) {
    failRecognition(requestId, error.message);
  }
}

function showBusy(rect, fullPage) {
  const panel = document.createElement("div");
  panel.className = fullPage ? "mt-overlay mt-overlay-page" : "mt-overlay";
  if (!fullPage) {
    Object.assign(panel.style, {
      left: `${rect.left}px`, top: `${rect.top}px`,
      width: `${rect.width}px`, height: `${rect.height}px`
    });
  }
  const content = document.createElement("div");
  content.className = "mt-overlay-loading";
  content.setAttribute("role", "status");
  content.setAttribute("aria-live", "polite");
  const spinner = document.createElement("span");
  spinner.className = "mt-loading-spinner";
  const label = document.createElement("span");
  label.textContent = fullPage ? "正在识别整页文字…" : "正在识别…";
  content.append(spinner, label);
  panel.appendChild(content);
  document.body.appendChild(panel);
  busyPanel = panel;
  resultPanels = [panel];
}

function removeBusy() {
  for (const panel of resultPanels) panel.remove();
  resultPanels = [];
  busyPanel = null;
}

function showRecognitionResult(message, pageMode) {
  if (message.requestId !== activeRequestId) return;
  removeBusy();
  if (!message.result?.ok) {
    failRecognition(message.requestId, message.result?.error || "未知错误");
    return;
  }
  if (requestTimeout) {
    clearTimeout(requestTimeout);
    requestTimeout = null;
  }
  try {
    showSourceText = message.result.debug_mode !== false;
    renderResults(message.rect, message.result, pageMode);
    recognizedResultReady = true;
    const texts = (message.result.items || []).map(item => item.text).filter(Boolean);
    if (texts.length && activePort) {
      requestTimeout = setTimeout(() => {
        console.warn("翻译超时，保留 OCR 原文");
        clearOverlay();
        showToast("翻译超时，已保留日文原文。请检查翻译服务后重试。", "error");
        closeRequestPort();
      }, 45000);
      activePort.postMessage({type: "TRANSLATE_TEXTS", texts, requestId: message.requestId});
    } else {
      closeRequestPort();
    }
  } catch (error) {
    failRecognition(message.requestId, `显示结果失败：${error.message}`);
  }
}

/**
 * Draw the recognised Japanese back over itself.
 *
 * This is what the "显示识别到的日文原文" setting means in practice: with
 * translation off, drawing the recognised text is the only evidence the user
 * gets that recognition ran at all. Without it a successful page-wide run left
 * the page byte-identical and read as "nothing happened".
 *
 * @returns {boolean} whether anything was painted
 */
function paintSourceText() {
  let painted = false;
  for (const entry of resultContents) {
    if (!entry.canvas.isConnected || !entry.sourceText) continue;
    entry.canvas.setAttribute("aria-label", entry.sourceText);
    drawTranslatedPatch(entry, entry.sourceText);
    painted = true;
  }
  return painted;
}

function showTranslationResult(message) {
  if (message.requestId !== activeRequestId) return;
  if (message.mode === "none") {
    if (showSourceText && paintSourceText()) {
      showToast("翻译未启用：画面上的日文是识别结果。在设置里选择翻译来源即可看到中文。", "info");
    } else {
      clearOverlay();
      showToast("翻译未启用，已保留日文原文。在设置里选择翻译来源即可看到中文。", "info");
    }
  } else if (!message.result?.ok) {
    const error = message.result?.error || "未知错误";
    console.warn("翻译失败，保留 OCR 原文：", error);
    clearOverlay();
    showToast(`翻译失败，已保留日文原文：${error}`, "error");
  } else {
    const items = message.result.items || [];
    const hasAllTranslations = items.length === resultContents.length &&
      items.every(item => typeof item.translated === "string" && item.translated.trim());
    if (!hasAllTranslations) {
      clearOverlay();
      showToast("翻译服务未返回完整结果，已保留日文原文。", "error");
    } else if (resultContents.some(entry => !entry.patch)) {
      clearOverlay();
      showToast("缺少文字框位置，请重载扩展并刷新漫画页面后重试。", "error");
    } else {
      resultContents.forEach((entry, index) => {
        if (entry.canvas.isConnected && entry.patch) {
          const translated = items[index].translated.trim();
          entry.canvas.setAttribute("aria-label", translated);
          drawTranslatedPatch(entry, translated);
        }
      });
    }
  }
  closeRequestPort();
}

// Small, self-dismissing status line in the corner.
//
// Translation results are never shown in a panel — they are painted over the
// original text. This exists only to explain *why nothing changed* (translation
// off, provider unreachable), so it stays out of the way and never covers the
// artwork.
let toastTimer = null;

/**
 * Status text goes to the panel's single-line strip.
 *
 * There used to be a second, independent toast element. Two places showing
 * status meant neither was authoritative, and the strip is the one that sits
 * where the eye already goes during auto translate. Keeping one also removes any
 * chance of the two overlapping.
 */
function showToast(text, kind = "info") {
  if (globalThis.OMT_panel) {
    OMT_panel.status(text, kind);
    return;
  }
  let toast = document.getElementById("mt-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "mt-toast";
    toast.setAttribute("role", "status");
    toast.setAttribute("aria-live", "polite");
    document.body.appendChild(toast);
  }
  toast.className = `mt-toast mt-toast-${kind} mt-toast-visible`;
  toast.textContent = text;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove("mt-toast-visible");
    toastTimer = null;
  }, kind === "error" ? 8000 : 4500);
}

function hideToast() {
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = null;
  document.getElementById("mt-toast")?.remove();
}

/** Remove everything this extension painted, leaving the page untouched. */
function clearOverlay() {
  for (const entry of resultContents) entry.canvas.remove();
  resultContents = [];
  for (const panel of resultPanels) panel.remove();
  resultPanels = [];
  busyPanel = null;
}

/**
 * Which way to typeset a region.
 *
 * The recogniser's verdict wins, because it looked at the pixels. The box's
 * aspect ratio is only a fallback for when it had no opinion — short crops
 * often leave the grid vote undecided, and a tall box is not evidence of
 * vertical text: a two-line horizontal block is taller than it is wide too.
 *
 * @param {"vertical"|"horizontal"|null|undefined} direction from the backend
 * @returns {boolean} true to typeset vertically
 */
function resolveTextDirection(direction, coreWidth, coreHeight) {
  if (direction === "vertical") return true;
  if (direction === "horizontal") return false;
  return coreHeight > coreWidth * 1.35;
}

function drawTranslatedPatch(entry, text) {
  const {canvas, context, image, patch} = entry;
  const left = Math.max(0, Math.floor(patch.core.left * canvas.width));
  const top = Math.max(0, Math.floor(patch.core.top * canvas.height));
  const right = Math.min(canvas.width, Math.ceil((patch.core.left + patch.core.width) * canvas.width));
  const bottom = Math.min(canvas.height, Math.ceil((patch.core.top + patch.core.height) * canvas.height));

  // Flat white over the original lettering, then the translation on top.
  //
  // This replaced a background reconstruction pass that sampled the surrounding
  // paper and diffused it inward. It was cleverer and worse: any mismatch showed
  // as a visible patch, and on a balloon — which is plain white anyway — there
  // was nothing to reconstruct. Nothing is drawn outside the text box, so the
  // artwork around it is untouched either way.
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#ffffff";
  context.fillRect(left, top, Math.max(0, right - left), Math.max(0, bottom - top));
  canvas.style.visibility = "visible";

  const cssScale = canvas.width / patch.rect.width;
  const coreWidth = (right - left) / cssScale;
  const coreHeight = (bottom - top) / (canvas.height / patch.rect.height);
  const characters = [...text.replace(/\s+/g, "")];
  if (!characters.length) return;
  // Trust the recogniser's verdict; only guess from the box's shape when it had
  // no opinion.
  const vertical = resolveTextDirection(entry.direction, coreWidth, coreHeight);
  let fontSize = Math.max(8, Math.min(
    25,
    Math.sqrt(coreWidth * coreHeight / (characters.length * (vertical ? 0.8 : 0.95)))
  ));
  fontSize *= cssScale * OMT_display.fontScale;
  canvas.style.opacity = String(OMT_display.opacity);
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.lineJoin = "round";
  context.font = `600 ${fontSize}px "Noto Sans CJK SC", "Microsoft YaHei", sans-serif`;

  // Dark text, because the box behind it was just filled white. The outline is
  // a light halo, which is what keeps glyphs legible where the box edge cuts
  // across artwork.
  context.fillStyle = "#171512";
  context.strokeStyle = "rgba(255,253,245,.76)";
  context.lineWidth = Math.max(1, fontSize * 0.09);

  // Clipped to the box. Glyph metrics can push the last column or line slightly
  // past the edge, and anything that spills lands on the drawing where it is no
  // longer sitting on the white cover — measured at 192 stray pixels before this.
  context.save();
  context.beginPath();
  context.rect(left, top, Math.max(0, right - left), Math.max(0, bottom - top));
  context.clip();

  if (vertical) {
    const maxCharsPerColumn = Math.max(1, Math.floor((bottom - top) / (fontSize * 1.2)));
    let columns = [];
    for (let index = 0; index < characters.length; index += maxCharsPerColumn) {
      columns.push(characters.slice(index, index + maxCharsPerColumn));
    }
    if (columns.length * fontSize * 1.2 > right - left) {
      fontSize = Math.max(8, (right - left) / (columns.length * 1.2));
      context.font = `600 ${fontSize}px "Noto Sans CJK SC", "Microsoft YaHei", sans-serif`;
      const adjustedCharsPerColumn = Math.max(1, Math.floor((bottom - top) / (fontSize * 1.2)));
      columns = [];
      for (let index = 0; index < characters.length; index += adjustedCharsPerColumn) {
        columns.push(characters.slice(index, index + adjustedCharsPerColumn));
      }
    }
    columns.forEach((column, columnIndex) => {
      const x = right - (columnIndex + 0.5) * fontSize * 1.2;
      const blockHeight = column.length * fontSize * 1.2;
      const startY = top + (bottom - top - blockHeight) / 2 + fontSize * 0.6;
      column.forEach((character, characterIndex) => {
        const y = startY + characterIndex * fontSize * 1.2;
        context.strokeText(character, x, y);
        context.fillText(character, x, y);
      });
    });
    context.restore();
    return;
  }

  const maxLineWidth = right - left;
  const maxCharsPerLine = Math.max(1, Math.floor(maxLineWidth / (fontSize * 1.1)));
  const lines = [];
  for (let index = 0; index < characters.length; index += maxCharsPerLine) {
    lines.push(characters.slice(index, index + maxCharsPerLine).join(""));
  }
  if (lines.length * fontSize * 1.25 > bottom - top) {
    fontSize = Math.max(8, (bottom - top) / (lines.length * 1.25));
    context.font = `600 ${fontSize}px "Noto Sans CJK SC", "Microsoft YaHei", sans-serif`;
  }
  const lineHeight = fontSize * 1.25;
  const firstY = top + (bottom - top - lines.length * lineHeight) / 2 + lineHeight / 2;
  lines.forEach((line, index) => {
    context.strokeText(line, (left + right) / 2, firstY + index * lineHeight, maxLineWidth);
    context.fillText(line, (left + right) / 2, firstY + index * lineHeight, maxLineWidth);
  });
  context.restore();
}

function closeRequestPort() {
  if (keepAliveTimer) clearInterval(keepAliveTimer);
  if (requestTimeout) clearTimeout(requestTimeout);
  keepAliveTimer = null;
  requestTimeout = null;
  const port = activePort;
  activePort = null;
  if (port) port.disconnect();
}

function failRecognition(requestId, message) {
  if (activeRequestId !== requestId) return;
  closeRequestPort();
  removeBusy();
  activeRequestId = null;
  resultContents = [];
  showToast(`识别失败：${message}`, "error");
}

function renderResults(rect, result, pageMode) {
  if (!result?.ok) throw new Error(result?.error || "未知错误");
  const items = result.items || [];
  const visibleItems = pageMode
    ? items.filter(item => item.rect && item.text?.trim())
    : items.filter(item => item.text?.trim()).map(item => ({...item, rect}));
  if (visibleItems.length === 0) {
    showToast("未识别到文字，请框选得再紧一些或换一处试试。", "info");
    return;
  }

  for (const item of visibleItems) {
    const bounds = item.rect;
    const patch = item.patch;
    const displayRect = patch?.rect || bounds;
    const canvas = document.createElement("canvas");
    canvas.className = "mt-overlay-text-canvas";
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", item.text?.trim() || "未识别到文字");
    Object.assign(canvas.style, {
      left: `${displayRect.left}px`, top: `${displayRect.top}px`,
      width: `${displayRect.width}px`, height: `${displayRect.height}px`,
      visibility: "hidden"
    });
    canvas.width = patch ? Math.max(1, Math.round(patch.rect.width * window.devicePixelRatio)) : 1;
    canvas.height = patch ? Math.max(1, Math.round(patch.rect.height * window.devicePixelRatio)) : 1;
    const context = canvas.getContext("2d", {willReadFrequently: true});
    const entry = {
      canvas, context, patch,
      translatedText: null,
      sourceText: item.text?.trim() || "",
      direction: item.direction || null
    };
    // Nothing to load any more: the cover is flat white, so painting needs the
    // geometry and nothing else. Waiting on an image decode here used to delay
    // every result by a frame trip for pixels that are no longer used.
    if (patch) {
      if (entry.translatedText) drawTranslatedPatch(entry, entry.translatedText);
    } else {
      canvas.width = Math.max(1, Math.round(bounds.width * window.devicePixelRatio));
      canvas.height = Math.max(1, Math.round(bounds.height * window.devicePixelRatio));
      canvas.setAttribute("aria-label", item.text || "");
      showToast("当前扩展未提供文字框位置，请重载扩展并刷新漫画页面。", "error");
    }
    document.body.appendChild(canvas);
    resultPanels.push(canvas);
    resultContents.push(entry);
  }
  document.addEventListener("keydown", onResultKeyDown, true);
}

function onResultKeyDown(event) {
  if (event.key === "Escape") dismissResults();
}

function dismissResults() {
  clearOverlay();
  hideToast();
  document.removeEventListener("keydown", onResultKeyDown, true);
  if (activeRequestId) {
    closeRequestPort();
    activeRequestId = null;
  }
}

// --- display preferences ----------------------------------------------------
//
// Mirrored from storage so every paint sees the current values without a storage
// round-trip; the settings page writes them and the change listener below keeps
// this in step.
const OMT_display = { fontScale: 1, opacity: 1 };

async function loadDisplayPreferences() {
  try {
    const cfg = await chrome.storage.local.get(["fontScale", "overlayOpacity"]);
    if (Number.isFinite(cfg.fontScale)) OMT_display.fontScale = Math.min(2, Math.max(0.4, cfg.fontScale));
    if (Number.isFinite(cfg.overlayOpacity)) OMT_display.opacity = Math.min(1, Math.max(0.2, cfg.overlayOpacity));
  } catch {
    /* extension APIs unreachable in this frame; defaults are fine */
  }
}

// --- shared with auto.js ----------------------------------------------------
//
// Both files are classic content scripts sharing one scope, so auto.js could
// simply call these — but an implicit cross-file dependency is invisible to
// anyone reading either file, and the static checker rightly flags it. Naming
// the shared surface makes the dependency explicit and checkable.
globalThis.OMT_render = { drawTranslatedPatch, resolveTextDirection };

// --- auto translate wiring --------------------------------------------------

// Anchored overlays only need re-placing when layout moves, which for window
// scrolling it does not — but an inner scroller, a resize or a late-loading
// font does. Passive and rAF-coalesced, so the cost stays near zero.
window.addEventListener("scroll", () => OMT_overlay.reposition(), { passive: true, capture: true });
window.addEventListener("resize", () => OMT_overlay.reposition(), { passive: true });

// Guarded: the script can land in frames where extension APIs are not reachable
// (sandboxed iframes), and a throw here would break manual translation too.
chrome.storage?.onChanged?.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.autoTranslate) OMT_auto.sync();
  if (changes.fontScale || changes.overlayOpacity) {
    loadDisplayPreferences().then(() => {
      // Already-painted regions keep their old size until repainted; that is
      // cheaper than tracking every canvas, and the next translation picks the
      // new value up.
    });
  }
});

loadDisplayPreferences();
OMT_auto.sync();

// The in-page panel is the primary surface now: the popup closes as soon as the
// user touches the page, which makes it useless for controls you need while
// reading. Mounting is cheap and does no work beyond one health check.
globalThis.OMT_panel?.mount?.().catch(() => {});
