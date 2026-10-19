// Marks this frame as carrying the extension's scripts. The popup probes for it
// to tell "never injected here" apart from "injected by a previous version of
// the extension and now orphaned", which is what happens when the extension is
// reloaded while a page stays open. The two look identical from the popup and
// need opposite advice: inject, or refresh the page.
globalThis.__MAS_LOADED__ = true;

/**
 * Whether this is the frame the user is actually looking at.
 *
 * `all_frames` puts the scripts in every subframe, and auto translate wants that
 * — it reads picture bytes, so it works from anywhere. The *interface* does not:
 * every ad iframe would grow its own floating panel, and manual selection is
 * wrong inside a subframe because the service worker crops a tab-level
 * screenshot using frame-local coordinates. So the UI lives in the top frame
 * only.
 */
const MAS_isTopFrame = (() => {
  try {
    return window.top === window;
  } catch {
    return false;   // cross-origin parent: a subframe by definition
  }
})();

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
    sendResponse(MAS_auto.stats());
    return true;
  }
  if (message.type === "AUTO_DIAG") {
    sendResponse(MAS_auto.diagnostics());
    return true;
  }
  return undefined;
});

function startSelect() {
  if (selecting) return;
  if (!MAS_isTopFrame) {
    // The service worker crops a tab-level screenshot for the selected rect, and
    // a subframe's coordinates are relative to the frame, not the tab — so a
    // selection made here would recognise a different part of the screen. Say so
    // rather than doing it wrong.
    showToast("请在最外层页面上框选（iframe 内的坐标无法对应到截图）。", "error");
    return;
  }
  selecting = true;
  dragging = false;
  selectionBox = document.createElement("div");
  selectionBox.className = "maslingo-selection";
  selectionRect = document.createElement("div");
  selectionRect.className = "maslingo-selection-rect";
  selectionSize = document.createElement("span");
  selectionSize.className = "maslingo-selection-size";
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
  if (!MAS_isTopFrame) {
    showToast("请在最外层页面上使用整页识别。", "error");
    return;
  }
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
  panel.className = fullPage ? "maslingo-overlay maslingo-overlay-page" : "maslingo-overlay";
  if (!fullPage) {
    Object.assign(panel.style, {
      left: `${rect.left}px`, top: `${rect.top}px`,
      width: `${rect.width}px`, height: `${rect.height}px`
    });
  }
  const content = document.createElement("div");
  content.className = "maslingo-overlay-loading";
  content.setAttribute("role", "status");
  content.setAttribute("aria-live", "polite");
  const spinner = document.createElement("span");
  spinner.className = "maslingo-loading-spinner";
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
      // Longer than the service worker's own 120s provider deadline, so a slow
      // translation reports its real reason through the error path instead of
      // this guard discarding an answer that was about to arrive. It fired at
      // 45s before, which cut off local LLMs mid-request and then blamed
      // "translation timeout" for a provider that was merely slow.
      requestTimeout = setTimeout(() => {
        console.warn("翻译超时，保留 OCR 原文");
        clearOverlay();
        showToast("翻译超时，已保留日文原文。请检查翻译服务后重试。", "error");
        closeRequestPort();
      }, 135000);
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
  const result = message.result;
  const items = result?.items || [];
  // "Translation off" is true when the mode says so *or* when a successful
  // answer carried no items at all: the off path always answers that way, and
  // this second signal keeps an upgraded profile whose stored mode is stale
  // from discarding translations that really did arrive. A configured provider
  // always returns one item per input, or runTranslation throws.
  const translationOff = message.mode === "none" || (Boolean(result?.ok) && items.length === 0);
  if (translationOff) {
    if (showSourceText && paintSourceText()) {
      showToast("翻译未启用：画面上的日文是识别结果。在设置里选择翻译来源即可看到中文。", "info");
    } else {
      clearOverlay();
      showToast("翻译未启用，已保留日文原文。在设置里选择翻译来源即可看到中文。", "info");
    }
  } else if (!result?.ok) {
    const error = result?.error || "未知错误";
    console.warn("翻译失败，保留 OCR 原文：", error);
    clearOverlay();
    showToast(`翻译失败，已保留日文原文：${error}`, "error");
  } else {
    const skippedCount = items.filter((item) => item?.skipped).length;
    const hasAllTranslations = items.length === resultContents.length &&
      items.every(item => item?.skipped ||
        (typeof item?.translated === "string" && item.translated.trim()));
    if (!hasAllTranslations) {
      clearOverlay();
      showToast("翻译服务未返回完整结果，已保留日文原文。", "error");
    } else if (resultContents.some(entry => !entry.patch)) {
      clearOverlay();
      showToast("缺少文字框位置，请重载扩展并刷新漫画页面后重试。", "error");
    } else {
      resultContents.forEach((entry, index) => {
        if (items[index]?.skipped) return;
        if (entry.canvas.isConnected && entry.patch) {
          const translated = items[index].translated.trim();
          entry.canvas.setAttribute("aria-label", translated);
          drawTranslatedPatch(entry, translated);
        }
      });
      if (items.length && skippedCount === items.length) {
        clearOverlay();
        showToast("原文已是目标语言，无需翻译。", "info");
      }
    }
  }
  closeRequestPort();
}

// Status messages.
//
// Translation results are never shown in a panel — they are painted over the
// original text. This exists only to explain *why nothing changed* (translation
// off, provider unreachable), so it stays out of the way and never covers the
// artwork.
let toastTimer = null;

/**
 * Status text goes to the panel's own status line.
 *
 * The bottom-right popup that used to carry these messages is gone: every
 * progress line made a second floating surface appear over the artwork. The
 * panel (or, collapsed, its widget label) is the one place the user is already
 * looking. A subframe has no panel — page-level chrome lives in the top frame —
 * and a toast drawn there would be clipped inside the iframe, so a subframe
 * reports to the console and nothing else.
 */
function showToast(text, kind = "info") {
  if (globalThis.MAS_panel?.status) {
    MAS_panel.status(text, kind);
    return;
  }
  if (!MAS_isTopFrame) {
    console.warn("[OMT]", text);
    return;
  }
  // Only reachable when panel.js failed to load at all, which the package check
  // treats as a broken build. Kept as a last resort so a status message can
  // never be silently lost.
  let fallback = document.getElementById("maslingo-toast");
  if (!fallback) {
    fallback = document.createElement("div");
    fallback.id = "maslingo-toast";
    fallback.className = "maslingo-toast maslingo-surface";
    fallback.setAttribute("role", "status");
    fallback.setAttribute("aria-live", "polite");
    document.body.appendChild(fallback);
  }
  fallback.textContent = text;
  fallback.classList.add("maslingo-toast-visible");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    fallback.classList.remove("maslingo-toast-visible");
    toastTimer = null;
  }, kind === "error" ? 8000 : 4500);
}

function hideToast() {
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = null;
  document.getElementById("maslingo-toast")?.remove();
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

/** The old cover, kept for callers that carry geometry but no pixels. */
function paintFlatCover(context, left, top, right, bottom) {
  context.fillStyle = "#ffffff";
  context.fillRect(left, top, Math.max(0, right - left), Math.max(0, bottom - top));
  return { luminance: 255 };
}

/**
 * Erase only the original lettering inside the recognised box.
 *
 * This is deliberately a flat-colour cover, not local background
 * reconstruction: one dominant paper/panel colour is sampled, every pixel
 * belonging to a glyph is repainted with it, and nothing else is touched. The
 * hard part is the glyph mask, not the fill. A fixed luminance threshold left
 * anti-aliased edges behind on white paper and could swallow paper texture.
 * Here the mask uses the dominant background colour, an Otsu split, and weak
 * edge pixels that are connected to a strong stroke. The mask is then grown by
 * one eight-neighbour pixel so the blended edge disappears too. The caller
 * receives the background luminance for choosing a readable translation ink.
 */
function paintLetteringCover(entry, left, top, right, bottom) {
  const {context, patchPixels} = entry;
  const {data, width, height} = patchPixels;
  // Work on a copy: the cached pixels are the *original* artwork and a redraw
  // (font-size change, new translation) must start from them again.
  const pixels = new Uint8ClampedArray(data);
  const pixelLuminance = (offset) =>
    0.299 * pixels[offset] + 0.587 * pixels[offset + 1] + 0.114 * pixels[offset + 2];

  const firstX = Math.max(0, left);
  const firstY = Math.max(0, top);
  const lastX = Math.min(width, right);
  const lastY = Math.min(height, bottom);
  const coreWidth = Math.max(0, lastX - firstX);
  const coreHeight = Math.max(0, lastY - firstY);
  if (!coreWidth || !coreHeight) return { luminance: 255 };

  // Dominant colour, not a median: the glyphs can occupy a large share of a
  // tight crop, but the paper still usually owns the largest colour cluster.
  // Coarse 5-bit bins make the mode stable against JPEG noise and paper grain.
  const bins = new Map();
  const sampleStep = width * height > 260000 ? 2 : 1;
  let samples = 0;
  for (let y = 0; y < height; y += sampleStep) {
    for (let x = 0; x < width; x += sampleStep) {
      const offset = (y * width + x) * 4;
      const r = pixels[offset];
      const g = pixels[offset + 1];
      const b = pixels[offset + 2];
      const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      let bin = bins.get(key);
      if (!bin) {
        bin = { count: 0, r: 0, g: 0, b: 0 };
        bins.set(key, bin);
      }
      bin.count += 1;
      bin.r += r;
      bin.g += g;
      bin.b += b;
      samples += 1;
    }
  }
  let dominant = null;
  for (const bin of bins.values()) {
    if (!dominant || bin.count > dominant.count) dominant = bin;
  }
  const background = dominant
    ? [
      Math.round(dominant.r / dominant.count),
      Math.round(dominant.g / dominant.count),
      Math.round(dominant.b / dominant.count),
    ]
    : [255, 255, 255];
  const backgroundLuminance =
    0.299 * background[0] + 0.587 * background[1] + 0.114 * background[2];

  // Pick the polarity from the actual pixels instead of a hardcoded "paper is
  // light": a mid-grey page with black lettering must still use the dark-ink
  // branch. Then build an Otsu histogram only from the core box.
  let darkSamples = 0;
  let lightSamples = 0;
  for (let y = firstY; y < lastY; y += 1) {
    for (let x = firstX; x < lastX; x += 1) {
      const l = pixelLuminance((y * width + x) * 4);
      if (l < backgroundLuminance - 20) darkSamples += 1;
      else if (l > backgroundLuminance + 20) lightSamples += 1;
    }
  }
  const inkIsDark = darkSamples >= lightSamples;
  const strength = new Uint8Array(width * height);
  const histogram = new Uint32Array(256);
  let corePixels = 0;
  let maxStrength = 0;
  for (let y = firstY; y < lastY; y += 1) {
    for (let x = firstX; x < lastX; x += 1) {
      const index = y * width + x;
      const luminance = pixelLuminance(index * 4);
      const difference = inkIsDark
        ? backgroundLuminance - luminance
        : luminance - backgroundLuminance;
      const value = difference > 0 ? Math.min(255, Math.round(difference)) : 0;
      strength[index] = value;
      histogram[value] += 1;
      corePixels += 1;
      if (value > maxStrength) maxStrength = value;
    }
  }
  // A blank/texture-only crop has no meaningful foreground.
  if (!corePixels || maxStrength < 8) {
    context.putImageData(context.createImageData(width, height), 0, 0);
    return { luminance: backgroundLuminance };
  }

  // Otsu split, with a floor so a nearly uniform paper crop cannot classify
  // JPEG grain as lettering. The weak threshold is only admitted when it is
  // connected to a strong stroke; that is what brings the anti-aliased edge in
  // without turning every bit of paper texture into a cover pixel.
  let weightedSum = 0;
  for (let value = 0; value < 256; value += 1) weightedSum += value * histogram[value];
  let backgroundWeight = 0;
  let backgroundSum = 0;
  let bestVariance = -1;
  let otsu = 0;
  for (let value = 0; value < 256; value += 1) {
    backgroundWeight += histogram[value];
    if (!backgroundWeight) continue;
    const foregroundWeight = corePixels - backgroundWeight;
    if (!foregroundWeight) break;
    backgroundSum += value * histogram[value];
    const backgroundMean = backgroundSum / backgroundWeight;
    const foregroundMean = (weightedSum - backgroundSum) / foregroundWeight;
    const variance = backgroundWeight * foregroundWeight *
      (backgroundMean - foregroundMean) * (backgroundMean - foregroundMean);
    if (variance > bestVariance) {
      bestVariance = variance;
      otsu = value;
    }
  }
  const strongThreshold = Math.min(
    maxStrength,
    Math.max(inkIsDark ? 22 : 18, otsu),
  );
  const weakThreshold = Math.max(6, Math.round(strongThreshold * 0.42));

  const mask = new Uint8Array(width * height);
  const weak = new Uint8Array(width * height);
  const queue = new Int32Array(Math.max(1, coreWidth * coreHeight));
  let head = 0;
  let tail = 0;
  for (let y = firstY; y < lastY; y += 1) {
    for (let x = firstX; x < lastX; x += 1) {
      const index = y * width + x;
      if (strength[index] >= strongThreshold) {
        mask[index] = 1;
        if (tail < queue.length) queue[tail++] = index;
      } else if (strength[index] >= weakThreshold) {
        weak[index] = 1;
      }
    }
  }
  // Connected weak pixels: anti-aliased fringes belong to a stroke; isolated
  // paper grain does not.
  while (head < tail) {
    const index = queue[head++];
    const y = Math.floor(index / width);
    const x = index - y * width;
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        if (!dx && !dy) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < firstX || nx >= lastX || ny < firstY || ny >= lastY) continue;
        const next = ny * width + nx;
        if (!weak[next] || mask[next]) continue;
        mask[next] = 1;
        if (tail < queue.length) queue[tail++] = next;
      }
    }
  }

  // One diagonal-inclusive pixel of growth takes the blended edge that remains
  // outside the weak band. This is still a flat paper fill, not local repair.
  const grown = new Uint8Array(mask);
  for (let y = firstY; y < lastY; y += 1) {
    for (let x = firstX; x < lastX; x += 1) {
      if (!mask[y * width + x]) continue;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= firstX && nx < lastX && ny >= firstY && ny < lastY) {
            grown[ny * width + nx] = 1;
          }
        }
      }
    }
  }

  // A recognised text crop often includes the balloon frame or speed lines at
  // its edges. Those lines touch the crop boundary and form a component much
  // larger than a stroke; keep them out of the cover so the bubble outline
  // survives. Interior strokes (the actual lettering) are not boundary
  // components.
  const visited = new Uint8Array(width * height);
  const componentQueue = new Int32Array(Math.max(1, coreWidth * coreHeight));
  const borderAreaFloor = Math.max(80, Math.round(corePixels * 0.012));
  for (let y = firstY; y < lastY; y += 1) {
    for (let x = firstX; x < lastX; x += 1) {
      const start = y * width + x;
      if (!grown[start] || visited[start]) continue;
      let componentHead = 0;
      let componentTail = 0;
      let minX = x;
      let minY = y;
      let maxX = x;
      let maxY = y;
      const component = [];
      componentQueue[componentTail++] = start;
      visited[start] = 1;
      while (componentHead < componentTail) {
        const index = componentQueue[componentHead++];
        component.push(index);
        const cy = Math.floor(index / width);
        const cx = index - cy * width;
        if (cx < minX) minX = cx;
        if (cy < minY) minY = cy;
        if (cx > maxX) maxX = cx;
        if (cy > maxY) maxY = cy;
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            const nx = cx + dx;
            const ny = cy + dy;
            if (nx < firstX || nx >= lastX || ny < firstY || ny >= lastY) continue;
            const next = ny * width + nx;
            if (!grown[next] || visited[next]) continue;
            visited[next] = 1;
            if (componentTail < componentQueue.length) componentQueue[componentTail++] = next;
          }
        }
      }
      const touchesBorder = minX === firstX || minY === firstY ||
        maxX === lastX - 1 || maxY === lastY - 1;
      const spansMost = (maxX - minX + 1) >= coreWidth * 0.55 ||
        (maxY - minY + 1) >= coreHeight * 0.55;
      if (touchesBorder && (component.length >= borderAreaFloor || (
        component.length >= 40 && spansMost
      ))) {
        for (const index of component) grown[index] = 0;
      }
    }
  }

  // Only the erased strokes are written; everything else stays transparent so
  // the page's own pixels show through — the cover must never replace the
  // artwork with a copy of itself.
  const output = context.createImageData(width, height);
  for (let y = firstY; y < lastY; y += 1) {
    for (let x = firstX; x < lastX; x += 1) {
      const index = y * width + x;
      if (!grown[index]) continue;
      const offset = index * 4;
      output.data[offset] = background[0];
      output.data[offset + 1] = background[1];
      output.data[offset + 2] = background[2];
      output.data[offset + 3] = 255;
    }
  }
  context.putImageData(output, 0, 0);
  return { luminance: backgroundLuminance };
}

/**
 * Decode a region's pixels once, so painting can follow the artwork.
 *
 * The work surface is the overlay canvas' own resolution; the screenshot and
 * the canvas are both in device pixels, so the crop maps 1:1.
 */
function preparePatchPixels(entry, dataUrl) {
  const image = new Image();
  image.onload = () => {
    try {
      const surface = document.createElement("canvas");
      surface.width = entry.canvas.width;
      surface.height = entry.canvas.height;
      const context = surface.getContext("2d", {willReadFrequently: true});
      context.drawImage(image, 0, 0, surface.width, surface.height);
      entry.patchPixels = context.getImageData(0, 0, surface.width, surface.height);
      // If something was already painted before the pixels arrived, repaint so
      // the first frame does not keep the flat white block.
      if (entry.lastText) drawTranslatedPatch(entry, entry.lastText);
    } catch {
      /* keep the flat-white fallback */
    }
  };
  image.src = dataUrl;
}

function drawTranslatedPatch(entry, text) {
  const {canvas, context, image, patch} = entry;
  const left = Math.max(0, Math.floor(patch.core.left * canvas.width));
  const top = Math.max(0, Math.floor(patch.core.top * canvas.height));
  const right = Math.min(canvas.width, Math.ceil((patch.core.left + patch.core.width) * canvas.width));
  const bottom = Math.min(canvas.height, Math.ceil((patch.core.top + patch.core.height) * canvas.height));
  entry.lastText = text;

  // Erase the original lettering, not the artwork.
  //
  // The cover used to be a white rectangle over the whole recognised box, which
  // on a round balloon covered its frame and, on white lettering drawn over
  // black art, laid a white slab across the drawing. The patch now carries the
  // screenshot's own pixels: the most common colour inside it is the local
  // background, and only pixels that differ from it — the strokes — are
  // repainted with that colour. The balloon outline and everything outside it
  // keep their pixels. Without pixels (an older worker, or a geometry-only
  // caller) the flat white block is still the fallback.
  context.clearRect(0, 0, canvas.width, canvas.height);
  const cover = entry.patchPixels
    ? paintLetteringCover(entry, left, top, right, bottom)
    : paintFlatCover(context, left, top, right, bottom);
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
  fontSize *= cssScale * MAS_display.fontScale;
  canvas.style.opacity = String(MAS_display.opacity);
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.lineJoin = "round";
  context.font = `600 ${fontSize}px "Noto Sans CJK SC", "Microsoft YaHei", sans-serif`;

  // The text follows the cover: dark ink on paper, light ink where the
  // original lettering sat on a dark background, with the opposite halo.
  const lightCover = cover.luminance >= 140;
  context.fillStyle = lightCover ? "#171512" : "#f7f5ef";
  context.strokeStyle = lightCover ? "rgba(255,253,245,.76)" : "rgba(12,12,12,.72)";
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
    canvas.className = "maslingo-overlay-text-canvas";
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", item.text?.trim() || "未识别到文字");
    // Document coordinates, not viewport ones. `displayRect` comes from a
    // screenshot, so it is in viewport CSS pixels; the canvas is absolute, so
    // the scroll offset has to be added or the translation stays pinned to the
    // screen while the artwork scrolls away underneath it.
    Object.assign(canvas.style, {
      left: `${displayRect.left + window.scrollX}px`,
      top: `${displayRect.top + window.scrollY}px`,
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
    // The region's pixels let the cover erase only the lettering. Decode them
    // in the background: if a translation lands first, the flat-white fallback
    // paints immediately and is replaced as soon as the decode completes.
    if (patch?.image) preparePatchPixels(entry, patch.image);
    if (patch) {
      if (entry.translatedText) drawTranslatedPatch(entry, entry.translatedText);
    } else {
      canvas.width = Math.max(1, Math.round(bounds.width * window.devicePixelRatio));
      canvas.height = Math.max(1, Math.round(bounds.height * window.devicePixelRatio));
      canvas.setAttribute("aria-label", item.text || "");
      showToast("当前扩展未提供文字框位置，请重载扩展并刷新漫画页面。", "error");
    }
    // Into the same layer the auto flow uses. It already sits at the document
    // origin, so these document-coordinate canvases stay correct even on pages
    // that make <body> a positioned ancestor — appended straight to <body> they
    // were offset by whatever margin or positioning that ancestor carried.
    MAS_overlay.ensureLayer().appendChild(canvas);
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
const MAS_display = { fontScale: 1, opacity: 1 };

async function loadDisplayPreferences() {
  try {
    const cfg = await chrome.storage.local.get(["fontScale", "overlayOpacity"]);
    if (Number.isFinite(cfg.fontScale)) MAS_display.fontScale = Math.min(2, Math.max(0.4, cfg.fontScale));
    if (Number.isFinite(cfg.overlayOpacity)) MAS_display.opacity = Math.min(1, Math.max(0.2, cfg.overlayOpacity));
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
globalThis.MAS_render = { drawTranslatedPatch, resolveTextDirection };

// --- auto translate wiring --------------------------------------------------

// Anchored overlays only need re-placing when layout moves, which for window
// scrolling it does not — but an inner scroller, a resize or a late-loading
// font does. Passive and rAF-coalesced, so the cost stays near zero.
window.addEventListener("scroll", () => MAS_overlay.reposition(), { passive: true, capture: true });
window.addEventListener("resize", () => MAS_overlay.reposition(), { passive: true });

// Guarded: the script can land in frames where extension APIs are not reachable
// (sandboxed iframes), and a throw here would break manual translation too.
chrome.storage?.onChanged?.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.autoTranslate) MAS_auto.sync();
  if (changes.debugMode) MAS_auto.refreshPreferences();
  if (changes.fontScale || changes.overlayOpacity) {
    loadDisplayPreferences().then(() => {
      // Already-painted regions keep their old size until repainted; that is
      // cheaper than tracking every canvas, and the next translation picks the
      // new value up.
    });
  }
});

loadDisplayPreferences();

// The panel mounts before auto translate is switched on, and auto translate waits
// for it. The other order loses the first status message: sync() starts the scan
// immediately, and status() has nowhere to write until the panel exists — so the
// user's first sight of the feature would be a panel sitting on "就绪" while the
// scan is already running.
//
// The panel is the primary surface now: the popup closes as soon as the user
// touches the page, which makes it useless for controls you need while reading.
// The panel is the top frame's job. Auto translate still runs in every frame —
// it reads picture bytes, so subframes are useful — but a second floating panel
// inside every ad iframe is not.
if (MAS_isTopFrame) {
  globalThis.MAS_panel
    ?.mount?.()
    .catch(() => {})
    .then(() => MAS_auto.sync());
} else {
  MAS_auto.sync();
}
