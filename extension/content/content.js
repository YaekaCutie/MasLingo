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
    if (entry.image.complete && entry.image.naturalWidth) {
      drawTranslatedPatch(entry, entry.sourceText);
    } else {
      entry.translatedText = entry.sourceText;
    }
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
    } else if (resultContents.some(entry => !entry.patch?.dataUrl)) {
      clearOverlay();
      showToast("缺少原图修复数据，请重载扩展并刷新漫画页面后重试。", "error");
    } else {
      resultContents.forEach((entry, index) => {
        if (entry.canvas.isConnected && entry.patch) {
          const translated = items[index].translated.trim();
          entry.canvas.setAttribute("aria-label", translated);
          if (entry.image.complete && entry.image.naturalWidth) {
            drawTranslatedPatch(entry, translated);
          } else {
            entry.translatedText = translated;
          }
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

function showToast(text, kind = "info") {
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
 * Rebuild the artwork behind recognised text.
 *
 * The previous approach replaced each pixel with a bilinear blend of four
 * single samples taken from the edges of the text box, keeping anything within
 * 28 levels of that estimate. Two things went wrong with it: thick strokes left
 * ghosts (their interior sits close to the blend), and a gradient or screentone
 * cannot be reconstructed from four points, so patches of tone survived.
 *
 * Here the box is classified into "ink" and "background" against a per-row and
 * per-column band average (which follows gradients in both axes), the ink mask
 * is dilated so the antialiased fringe goes too, and the holes are then filled
 * by inward diffusion from the surrounding pixels — layer by layer, so the fill
 * follows the local tone instead of guessing at it.
 *
 * @returns {void} mutates `data` in place
 */
function reconstructBackground(data, width, height, box) {
  const {left, top, right, bottom} = box;
  const boxWidth = right - left;
  const boxHeight = bottom - top;
  if (boxWidth < 3 || boxHeight < 3) return;

  const at = (x, y, channel) => data[(y * width + x) * 4 + channel];
  const band = Math.max(1, Math.round(Math.min(boxWidth, boxHeight) * 0.12));

  // Average a band just outside each edge: one sample per side (the old code)
  // lets a single dark speck or a stray stroke skew the whole estimate.
  const rowBand = (from, to) => {
    const out = [];
    for (let y = top; y < bottom; y++) {
      const sum = [0, 0, 0];
      let count = 0;
      for (let x = Math.max(0, from); x < Math.min(width, to); x++) {
        for (let c = 0; c < 3; c++) sum[c] += at(x, y, c);
        count++;
      }
      out.push(count ? sum.map(value => value / count) : null);
    }
    return out;
  };
  const columnBand = (from, to) => {
    const out = [];
    for (let x = left; x < right; x++) {
      const sum = [0, 0, 0];
      let count = 0;
      for (let y = Math.max(0, from); y < Math.min(height, to); y++) {
        for (let c = 0; c < 3; c++) sum[c] += at(x, y, c);
        count++;
      }
      out.push(count ? sum.map(value => value / count) : null);
    }
    return out;
  };

  const leftBand = rowBand(left - band, left);
  const rightBand = rowBand(right, right + band);
  const topBand = columnBand(top - band, top);
  const bottomBand = columnBand(bottom, bottom + band);

  const mix = (a, b, position) => {
    if (!a) return b;
    if (!b) return a;
    return [
      a[0] + (b[0] - a[0]) * position,
      a[1] + (b[1] - a[1]) * position,
      a[2] + (b[2] - a[2]) * position,
    ];
  };

  const ink = new Uint8Array(boxWidth * boxHeight);
  const estimate = new Float32Array(boxWidth * boxHeight * 3);

  // How flat is the paper around this box? The bands sampled just outside it are
  // background by construction, so their spread answers that before the mask is
  // built — which matters, because the right mask depends on the answer. A
  // generous mask is safe on flat paper (the fill is solid anyway) and damaging
  // on a gradient (it eats artwork the diffusion then has to invent).
  const bandLuma = [];
  for (const band of [leftBand, rightBand, topBand, bottomBand]) {
    for (const sample of band) {
      if (sample) bandLuma.push((sample[0] * 299 + sample[1] * 587 + sample[2] * 114) / 1000);
    }
  }
  let flatPaper = false;
  if (bandLuma.length >= 8) {
    const histogram = new Uint32Array(256);
    for (const value of bandLuma) histogram[Math.max(0, Math.min(255, Math.round(value)))] += 1;
    let mode = 0;
    let modeCount = 0;
    for (let value = 0; value < 256; value += 1) {
      if (histogram[value] > modeCount) { modeCount = histogram[value]; mode = value; }
    }
    let within = 0;
    // Tight on purpose. Real balloon paper stays within a couple of levels, and
    // a loose band here misclassifies a gentle gradient as flat — which then
    // gets a solid fill and shows up as a rectangle.
    for (let value = Math.max(0, mode - 6); value <= Math.min(255, mode + 6); value += 1) {
      within += histogram[value];
    }
    flatPaper = within / bandLuma.length >= 0.9;
  }

  // Deliberately generous on flat paper: the fill is solid, so anything the mask
  // misses stays behind as a grey speck on white, which is far more noticeable
  // than covering a few extra pixels of a balloon.
  const threshold = flatPaper ? 18 : 26;

  for (let y = top; y < bottom; y++) {
    const verticalPosition = (y - top + 0.5) / boxHeight;
    for (let x = left; x < right; x++) {
      const horizontalPosition = (x - left + 0.5) / boxWidth;
      // Interpolate along both axes and average, so a vertical gradient and a
      // horizontal one are each followed instead of one winning outright.
      const horizontal = mix(leftBand[y - top], rightBand[y - top], horizontalPosition);
      const vertical = mix(topBand[x - left], bottomBand[x - left], verticalPosition);
      const index = (y - top) * boxWidth + (x - left);
      let difference = 0;
      for (let c = 0; c < 3; c++) {
        const value = (horizontal[c] + vertical[c]) / 2;
        estimate[index * 3 + c] = value;
        difference = Math.max(difference, Math.abs(at(x, y, c) - value));
      }
      ink[index] = difference > threshold ? 1 : 0;
    }
  }

  // Dilate by two pixels: antialiased stroke edges sit close to the estimate
  // and would otherwise survive as a pale outline around the new text.
  const mask = new Uint8Array(boxWidth * boxHeight);
  const dilate = flatPaper ? 2 : 1;
  for (let y = 0; y < boxHeight; y++) {
    for (let x = 0; x < boxWidth; x++) {
      let hit = 0;
      for (let dy = -dilate; dy <= dilate && !hit; dy++) {
        for (let dx = -dilate; dx <= dilate; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= boxWidth || ny >= boxHeight) continue;
          if (ink[ny * boxWidth + nx]) { hit = 1; break; }
        }
      }
      mask[y * boxWidth + x] = hit;
    }
  }

  // --- dominant background colour ------------------------------------------
  //
  // Diffusion gave a soft, smeared fill: whatever ink the mask missed got
  // averaged into the result, so a white balloon came back light grey and read
  // as "blurry". Manga balloons are flat, so the right answer is usually the
  // single most common tone, painted on solid — indistinguishable from the
  // untouched page. Diffusion is kept only for genuinely non-uniform
  // backgrounds, where a flat fill would show up as a rectangle.
  const lumaHistogram = new Uint32Array(256);
  let backgroundPixels = 0;
  for (let index = 0; index < mask.length; index++) {
    if (mask[index]) continue;
    const x = left + (index % boxWidth);
    const y = top + Math.floor(index / boxWidth);
    const offset = (y * width + x) * 4;
    const luma = (data[offset] * 299 + data[offset + 1] * 587 + data[offset + 2] * 114) / 1000;
    lumaHistogram[Math.max(0, Math.min(255, Math.round(luma)))] += 1;
    backgroundPixels += 1;
  }
  let modalLuma = 0;
  let modalCount = 0;
  for (let value = 0; value < 256; value += 1) {
    if (lumaHistogram[value] > modalCount) {
      modalCount = lumaHistogram[value];
      modalLuma = value;
    }
  }
  let inModalBand = 0;
  for (let value = Math.max(0, modalLuma - 8); value <= Math.min(255, modalLuma + 8); value += 1) {
    inModalBand += lumaHistogram[value];
  }
  const uniformity = backgroundPixels ? inModalBand / backgroundPixels : 0;

  // Average the modal band rather than the exact mode, so a slightly warm or
  // cool paper keeps its tint.
  const flat = new Float32Array([modalLuma, modalLuma, modalLuma]);
  if (backgroundPixels) {
    const sums = [0, 0, 0];
    let counted = 0;
    for (let index = 0; index < mask.length; index++) {
      if (mask[index]) continue;
      const x = left + (index % boxWidth);
      const y = top + Math.floor(index / boxWidth);
      const offset = (y * width + x) * 4;
      const luma = (data[offset] * 299 + data[offset + 1] * 587 + data[offset + 2] * 114) / 1000;
      if (Math.abs(luma - modalLuma) > 8) continue;
      for (let c = 0; c < 3; c += 1) sums[c] += data[offset + c];
      counted += 1;
    }
    if (counted) for (let c = 0; c < 3; c += 1) flat[c] = sums[c] / counted;
  }

  if (uniformity >= 0.72 && backgroundPixels > 0) {
    for (let index = 0; index < mask.length; index += 1) {
      if (!mask[index]) continue;
      const x = left + (index % boxWidth);
      const y = top + Math.floor(index / boxWidth);
      const offset = (y * width + x) * 4;
      data[offset] = flat[0];
      data[offset + 1] = flat[1];
      data[offset + 2] = flat[2];
    }
    return;
  }

  // Colours to fill, seeded from the original pixels; `known` marks the ones we
  // trust (background inside the box plus the dilated-away fringe).
  const colors = new Float32Array(boxWidth * boxHeight * 3);
  for (let index = 0; index < boxWidth * boxHeight; index++) {
    const x = left + (index % boxWidth);
    const y = top + Math.floor(index / boxWidth);
    for (let c = 0; c < 3; c++) colors[index * 3 + c] = at(x, y, c);
  }

  let unknown = 0;
  for (let index = 0; index < mask.length; index++) if (mask[index]) unknown++;

  const filled = new Uint8Array(mask.length);
  let remaining = unknown;
  let guard = 0;
  const maxPasses = Math.max(8, Math.ceil(Math.max(boxWidth, boxHeight) / 2) + 4);
  while (remaining > 0 && guard++ < maxPasses) {
    const candidates = [];
    for (let y = 0; y < boxHeight; y++) {
      for (let x = 0; x < boxWidth; x++) {
        const index = y * boxWidth + x;
        if (!mask[index] || filled[index]) continue;
        const sum = [0, 0, 0];
        let count = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= boxHeight) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= boxWidth) continue;
            const neighbour = ny * boxWidth + nx;
            if (mask[neighbour] && !filled[neighbour]) continue;
            for (let c = 0; c < 3; c++) sum[c] += colors[neighbour * 3 + c];
            count++;
          }
        }
        if (count) candidates.push([index, sum[0] / count, sum[1] / count, sum[2] / count]);
      }
    }
    if (!candidates.length) break;
    // Applied after the scan so each pass advances exactly one layer inward,
    // which keeps the diffusion symmetric instead of bleeding in scan order.
    for (const [index, r, g, b] of candidates) {
      colors[index * 3] = r;
      colors[index * 3 + 1] = g;
      colors[index * 3 + 2] = b;
      filled[index] = 1;
      remaining--;
    }
  }

  // Anything the guard left behind (very large solid areas) falls back to the
  // band estimate rather than to black.
  for (let index = 0; index < mask.length; index++) {
    if (!mask[index] || filled[index]) continue;
    for (let c = 0; c < 3; c++) colors[index * 3 + c] = estimate[index * 3 + c];
  }

  for (let index = 0; index < mask.length; index++) {
    if (!mask[index]) continue;
    const x = left + (index % boxWidth);
    const y = top + Math.floor(index / boxWidth);
    const offset = (y * width + x) * 4;
    data[offset] = colors[index * 3];
    data[offset + 1] = colors[index * 3 + 1];
    data[offset + 2] = colors[index * 3 + 2];
  }
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
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  const data = pixels.data;
  const left = Math.max(0, Math.floor(patch.core.left * canvas.width));
  const top = Math.max(0, Math.floor(patch.core.top * canvas.height));
  const right = Math.min(canvas.width, Math.ceil((patch.core.left + patch.core.width) * canvas.width));
  const bottom = Math.min(canvas.height, Math.ceil((patch.core.top + patch.core.height) * canvas.height));
  const sample = (x, y, channel) => data[(y * canvas.width + x) * 4 + channel];
  reconstructBackground(data, canvas.width, canvas.height, {left, top, right, bottom});

  // Only the text box is painted; everything outside it is made transparent so
  // the untouched artwork underneath shows through.
  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      if (x < left || x >= right || y < top || y >= bottom) {
        data[(y * canvas.width + x) * 4 + 3] = 0;
      }
    }
  }
  context.putImageData(pixels, 0, 0);
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

  const corners = [
    sample(left, top, 0), sample(right - 1, top, 0),
    sample(left, bottom - 1, 0), sample(right - 1, bottom - 1, 0)
  ];
  const lightBackground = corners.reduce((sum, value) => sum + value, 0) / corners.length > 145;
  context.fillStyle = lightBackground ? "#171512" : "#fffdf5";
  context.strokeStyle = lightBackground ? "rgba(255,253,245,.76)" : "rgba(20,18,16,.78)";
  context.lineWidth = Math.max(1, fontSize * 0.09);

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
    const image = new Image();
    const entry = {
      canvas, context, image, patch,
      translatedText: null,
      sourceText: item.text?.trim() || "",
      direction: item.direction || null
    };
    if (patch?.dataUrl) {
      image.onload = () => {
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        if (entry.translatedText) drawTranslatedPatch(entry, entry.translatedText);
      };
      image.onerror = () => {
        canvas.remove();
        showToast("无法载入原图画布，未能融合翻译结果。", "error");
      };
      image.src = patch.dataUrl;
    } else {
      canvas.width = Math.max(1, Math.round(bounds.width * window.devicePixelRatio));
      canvas.height = Math.max(1, Math.round(bounds.height * window.devicePixelRatio));
      canvas.setAttribute("aria-label", `${item.text || ""}（请重新加载扩展以启用画面融合）`);
      showToast("当前扩展未提供原图修复数据，请重载扩展并刷新漫画页面。", "error");
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
globalThis.OMT_render = { drawTranslatedPatch, reconstructBackground, resolveTextDirection };

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
