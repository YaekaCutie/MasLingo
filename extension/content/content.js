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

chrome.runtime.onMessage.addListener(message => {
  if (message.type === "START_SELECT") startSelect();
  if (message.type === "START_AUTO") startAutoRecognition();
  if (message.type === "RECOGNITION_RESULT") showRecognitionResult(message, activePageMode);
  if (message.type === "TRANSLATION_RESULT") showTranslationResult(message);
  if (message.type === "PING") return;
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
    if (
      candidate.width < 180 ||
      candidate.height < 180 ||
      candidate.width * candidate.height < minimumArea ||
      candidate.width * candidate.height >= viewportArea * 0.8
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
        discardSourcePatches();
        showTranslationNotice(`翻译连接已断开，当前保留日文原文：${reason}`);
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
  panel.className = fullPage ? "mt-overlay mt-overlay-status" : "mt-overlay";
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
  content.textContent = "正在自动识别页面文字…";
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
    renderResults(message.rect, message.result, pageMode);
    recognizedResultReady = true;
    const texts = (message.result.items || []).map(item => item.text).filter(Boolean);
    if (texts.length && activePort) {
      requestTimeout = setTimeout(() => {
        console.warn("翻译超时，保留 OCR 原文");
        discardSourcePatches();
        showTranslationNotice("翻译超时，当前保留日文原文。请检查翻译服务后重试。");
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

function showTranslationResult(message) {
  if (message.requestId !== activeRequestId) return;
  if (message.mode === "none") {
    discardSourcePatches();
    showTranslationNotice(
      "翻译未启用：当前显示的是日文原文。打开扩展设置，选择 Google 翻译或 OpenAI-compatible API。"
    );
  } else if (!message.result?.ok) {
    const error = message.result?.error || "未知错误";
    console.warn("翻译失败，保留 OCR 原文：", error);
    discardSourcePatches();
    showTranslationNotice(`翻译失败，当前保留日文原文：${error}`);
  } else {
    const items = message.result.items || [];
    const hasAllTranslations = items.length === resultContents.length &&
      items.every(item => typeof item.translated === "string" && item.translated.trim());
    if (!hasAllTranslations) {
      discardSourcePatches();
      showTranslationNotice("翻译服务未返回完整结果，当前保留日文原文。");
    } else if (resultContents.some(entry => !entry.patch?.dataUrl)) {
      discardSourcePatches();
      showTranslationNotice("缺少原图修复数据，请重载扩展并刷新漫画页面后重试。");
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

function showTranslationNotice(text) {
  const panel = document.createElement("div");
  panel.className = "mt-overlay mt-overlay-status";
  const content = document.createElement("div");
  content.className = "mt-overlay-loading";
  content.setAttribute("role", "status");
  content.setAttribute("aria-live", "polite");
  content.textContent = text;
  panel.appendChild(content);
  document.body.appendChild(panel);
  resultPanels.push(panel);
}

function discardSourcePatches() {
  for (const entry of resultContents) entry.canvas.remove();
  resultContents = [];
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
  const horizontalMargin = Math.max(1, Math.round(canvas.width * 0.004));
  const verticalMargin = Math.max(1, Math.round(canvas.height * 0.004));

  for (let y = top; y < bottom; y++) {
    const sampleTop = Math.max(0, top - verticalMargin);
    const sampleBottom = Math.min(canvas.height - 1, bottom + verticalMargin);
    const verticalPosition = (y - sampleTop) / Math.max(1, sampleBottom - sampleTop);
    for (let x = left; x < right; x++) {
      const sampleLeft = Math.max(0, left - horizontalMargin);
      const sampleRight = Math.min(canvas.width - 1, right + horizontalMargin);
      const horizontalPosition = (x - sampleLeft) / Math.max(1, sampleRight - sampleLeft);
      let difference = 0;
      const background = [];
      for (let channel = 0; channel < 3; channel++) {
        const horizontal = sample(sampleLeft, y, channel) * (1 - horizontalPosition) +
          sample(sampleRight, y, channel) * horizontalPosition;
        const vertical = sample(x, sampleTop, channel) * (1 - verticalPosition) +
          sample(x, sampleBottom, channel) * verticalPosition;
        background[channel] = (horizontal + vertical) / 2;
        difference = Math.max(difference, Math.abs(sample(x, y, channel) - background[channel]));
      }
      if (difference > 28) {
        const offset = (y * canvas.width + x) * 4;
        data[offset] = background[0];
        data[offset + 1] = background[1];
        data[offset + 2] = background[2];
      }
    }
  }
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
  const vertical = coreHeight > coreWidth * 1.35;
  let fontSize = Math.max(8, Math.min(
    25,
    Math.sqrt(coreWidth * coreHeight / (characters.length * (vertical ? 0.8 : 0.95)))
  ));
  fontSize *= cssScale;
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
  alert(`识别失败：${message}`);
}

function renderResults(rect, result, pageMode) {
  if (!result?.ok) throw new Error(result?.error || "未知错误");
  const items = result.items || [];
  const visibleItems = pageMode
    ? items.filter(item => item.rect && item.text?.trim())
    : items.filter(item => item.text?.trim()).map(item => ({...item, rect}));
  if (visibleItems.length === 0) {
    showTranslationNotice("未识别到文字");
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
    const entry = {canvas, context, image, patch, translatedText: null};
    if (patch?.dataUrl) {
      image.onload = () => {
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        if (entry.translatedText) drawTranslatedPatch(entry, entry.translatedText);
      };
      image.onerror = () => {
        canvas.remove();
        showTranslationNotice("无法载入原图画布，未能融合翻译结果。");
      };
      image.src = patch.dataUrl;
    } else {
      canvas.width = Math.max(1, Math.round(bounds.width * window.devicePixelRatio));
      canvas.height = Math.max(1, Math.round(bounds.height * window.devicePixelRatio));
      canvas.setAttribute("aria-label", `${item.text || ""}（请重新加载扩展以启用画面融合）`);
      showTranslationNotice("当前扩展未提供原图修复数据，请重载扩展并刷新漫画页面。");
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
  resultPanels.forEach(panel => panel.remove());
  resultPanels = [];
  resultContents = [];
  busyPanel = null;
  document.removeEventListener("keydown", onResultKeyDown, true);
  if (activeRequestId) {
    closeRequestPort();
    activeRequestId = null;
  }
}
