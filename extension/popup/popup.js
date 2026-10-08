const status = document.getElementById("status");
const autoToggle = document.getElementById("autoTranslate");
const autoState = document.getElementById("autoState");
const autoStateText = document.getElementById("autoStateText");

let statusTimer = null;
let activeTabId = null;
let lastTabUrl = "";

function setStatusText(text, state = "idle") {
  autoState.dataset.state = state;
  autoStateText.textContent = text;
}

function normalize(url) {
  return String(url || "").trim().replace(/\/+$/, "");
}

async function fetchBackend(path, options = {}) {
  const backends = await globalThis.MAS_backendCandidates();
  let lastError = null;
  for (const base of backends) {
    try {
      const resp = await fetch(`${base}${path}`, options);
      if (resp.ok || resp.status >= 400) return { resp, base };
      lastError = new Error(`${base} 响应失败: ${resp.status}`);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("未配置后端且本机后端未运行");
}

// --- auto translate status --------------------------------------------------

/**
 * Work out why a page is not answering.
 *
 * Three different situations all present as "no response", and telling the user
 * the wrong one sends them nowhere:
 *
 *   ok         — the content script is there and talking;
 *   stale      — a script from a previous version of the extension is still in
 *                the page but its runtime is gone (the extension was reloaded
 *                with the page open). Only a page refresh fixes this; injecting
 *                again would just stack a second copy on top of a dead one;
 *   missing    — nothing was injected here, which is normal for a page that was
 *                already open when the extension loaded. Injecting fixes it;
 *   restricted — the browser forbids extensions on this page.
 */
async function diagnoseFrame(tabId) {
  if (!tabId) return "restricted";
  try {
    await chrome.tabs.sendMessage(tabId, { type: "PING" });
    return "ok";
  } catch {
    /* fall through to the probe */
  }
  try {
    const [probe] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => Boolean(globalThis.__MAS_LOADED__),
    });
    return probe?.result ? "stale" : "missing";
  } catch (error) {
    return /Cannot access|chrome:\/\/|extensions gallery|The extensions gallery/i.test(error.message)
      ? "restricted"
      : "restricted";
  }
}

// Kept in step with manifest.json's content_scripts list by check-extension.mjs.
// It was missing panel.js, config.js and providers.js: the repair path then gave
// a page auto translate but no panel at all — and because content.js still set
// __MAS_LOADED__, the next popup open diagnosed "ok" and never retried, so the
// panel was gone for the life of that page with no error anywhere.
const CONTENT_SCRIPTS = [
  "config.js",
  "translation/providers.js",
  "content/glass.js",
  "content/status.js",
  "content/overlay.js",
  "content/auto.js",
  "content/panel.js",
  "content/content.js",
];

// Order matters: the tokens and the material come first, then the surfaces that
// use them. Same list as the manifest, and check-extension.mjs compares the two
// so a repaired page cannot end up styled differently from a freshly loaded one.
const CONTENT_STYLES = [
  "content/styles/glass.css",
  "content/styles/window.css",
  "content/styles/status.css",
  "content/styles/marker.css",
  "content/styles/page.css",
];

async function injectContentScript(tabId) {
  await chrome.scripting.insertCSS({ target: { tabId }, files: CONTENT_STYLES });
  await chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_SCRIPTS });
}

/**
 * Ask the page what auto translate is doing, repairing what can be repaired.
 */
async function refreshAutoStatus({ allowInject = true } = {}) {
  const state = await diagnoseFrame(activeTabId);
  if (state === "restricted") {
    setStatusText(tabIsImage() ? "此页面受浏览器限制" : "当前页面无法使用", "idle");
    return;
  }
  if (state === "stale") {
    setStatusText("扩展已更新，请刷新此页面", "error");
    return;
  }
  if (state === "missing") {
    if (!allowInject) {
      setStatusText("当前页面无法使用", "idle");
      return;
    }
    try {
      await injectContentScript(activeTabId);
    } catch {
      setStatusText("当前页面无法使用", "idle");
      return;
    }
  }

  try {
    const stats = await chrome.tabs.sendMessage(activeTabId, { type: "AUTO_STATUS" });
    if (!stats || !stats.enabled) {
      setStatusText("未开启", "idle");
      return;
    }
    const busy = stats.queued + stats.running;
    const images = stats.imageFailures || {};
    const unreadable = (images.unreadable || 0) + (images.other || 0);
    if (busy > 0) {
      setStatusText(`正在翻译 ${busy} 个区域`, "working");
    } else if (stats.failed > 0) {
      // A region got as far as OCR and then failed — that is a translation
      // problem, and the translation source is what to look at.
      setStatusText(`✗ ${stats.failed} 处翻译失败，请检查翻译来源`, "error");
    } else if (unreadable > 0 && stats.translated === 0) {
      // The picture never reached the backend. Blaming the backend here is what
      // sent the user looking in the wrong place; a page can be full of images
      // the browser will not hand over, and that is not an error worth alarming
      // about unless nothing at all worked.
      setStatusText(`✗ ${unreadable} 张图片无法读取`, "error");
    } else if (images.ocr > 0 && stats.translated === 0) {
      setStatusText(`✗ ${images.ocr} 张图片识别失败，请检查后端`, "error");
    } else if (stats.translated > 0 && stats.translationMode === "none") {
      // The regions were read and painted, but with their original text: no
      // translation source is configured. Reporting a plain success here would
      // hide the one thing the user has to do.
      setStatusText(`✓ 已识别 ${stats.translated} 处 · 翻译来源未设置，显示的是原文`, "error");
    } else if (stats.translated > 0 && stats.failed === 0) {
      setStatusText(`✓ 当前页面翻译完成（${stats.translated} 处）`, "done");
    } else if (stats.translated > 0) {
      setStatusText(`已完成 ${stats.translated} 处，另有 ${stats.failed} 处失败`, "error");
    } else {
      setStatusText("● 正在检测漫画", "scanning");
    }
  } catch {
    setStatusText("当前页面无法使用", "idle");
  }
}

/** A tab showing an image directly: Chrome wraps it in its own minimal HTML. */
function tabIsImage() {
  return /\.(jpe?g|png|webp|gif|avif)(\?|#|$)/i.test(lastTabUrl || "");
}

/** Render the content script's own account of what it has been doing. */
async function refreshDiagnostics() {
  const node = document.getElementById("autoDiag");
  if (!activeTabId) {
    node.textContent = "自动翻译：没有可用的标签页";
    return;
  }
  try {
    const diag = await chrome.tabs.sendMessage(activeTabId, { type: "AUTO_DIAG" });
    if (!diag || !diag.enabled) {
      node.textContent = "自动翻译：未开启";
      return;
    }
    const lines = [
      `自动翻译：已开启（并发 ${diag.concurrency}）`,
      `扫描到的图片元素：${diag.seen.collected}`,
      `其中符合漫画尺寸：${diag.seen.candidates}`,
      `已入队：${diag.seen.enqueued}   队列中：${diag.queued}   进行中：${diag.running}`,
      `画面上已锚定的译文：${diag.anchored}`,
      `翻译来源：${diag.translationMode || "尚未调用"}`,
      `图片失败：读不出来 ${diag.imageFailures.unreadable} · 识别 ${diag.imageFailures.ocr} · 其它 ${diag.imageFailures.other}`,
    ];
    if (diag.lastError) {
      lines.push(`最后一次错误：${diag.lastError.message}`);
      if (diag.lastError.src) lines.push(`  来源：${String(diag.lastError.src).slice(0, 90)}`);
    }
    if (diag.seen.collected === 0) {
      lines.push("");
      lines.push("一个图片元素都没找到 —— 如果不是图片页面，请把这一屏截图给我。");
    } else if (diag.seen.candidates === 0) {
      lines.push("");
      lines.push("找到了图片，但都小于 260px。如果漫画确实更大，说明它当时还没展开。");
    }
    node.textContent = lines.join("\n");
  } catch (error) {
    node.textContent = `自动翻译：读不到页面状态（${error.message}）`;
  }
}

function pollWhileOpen() {
  refreshAutoStatus();
  refreshDiagnostics();
  statusTimer = setInterval(() => {
    refreshAutoStatus();
    refreshDiagnostics();
  }, 1000);
}

window.addEventListener("unload", () => {
  if (statusTimer) clearInterval(statusTimer);
});

// --- controls ---------------------------------------------------------------

autoToggle.addEventListener("change", async () => {
  await chrome.storage.local.set({ autoTranslate: autoToggle.checked });
  setStatusText(autoToggle.checked ? "● 正在检测漫画" : "未开启", autoToggle.checked ? "scanning" : "idle");
  // The content script learns about this through storage.onChanged; give it a
  // moment before reading the status back.
  setTimeout(refreshAutoStatus, 600);
});

document.getElementById("settings").onclick = () => chrome.runtime.openOptionsPage();

document.getElementById("health").onclick = async () => {
  status.textContent = "正在检查…";
  document.getElementById("details").open = true;
  try {
    const { resp, base } = await fetchBackend("/health");
    status.textContent = `${base}\n${JSON.stringify(await resp.json(), null, 2)}`;
  } catch (error) {
    status.textContent = `OCR 后端未运行：${error.message}\n\n` +
      "识别需要后端：请在设置里填写后端地址，并在那台机器上启动 backend/（见仓库 deploy/ 目录）。";
  }
};

async function prepareContentScript(tabId) {
  const state = await diagnoseFrame(tabId);
  if (state === "ok") return;
  if (state === "stale") {
    throw new Error("扩展已更新，请先刷新此页面");
  }
  if (state === "restricted") {
    throw new Error("当前页面受浏览器限制，无法在这里运行");
  }
  await injectContentScript(tabId);
}

function reportStartFailure(action, error) {
  const restricted = /Cannot access|cannot be scripted|extensions gallery/i.test(error.message);
  document.getElementById("details").open = true;
  status.textContent = restricted
    ? `当前页面受 Chrome 限制，无法${action}。请切换到普通网页后重试。`
    : `无法${action}：${error.message}`;
}

document.getElementById("select").onclick = async () => {
  try {
    if (!activeTabId) throw new Error("无法获取当前页面");
    await prepareContentScript(activeTabId);
    await chrome.tabs.sendMessage(activeTabId, { type: "START_SELECT" });
    window.close();
  } catch (error) {
    reportStartFailure("框选", error);
  }
};

document.getElementById("autoPage").onclick = async () => {
  try {
    if (!activeTabId) throw new Error("无法获取当前页面");
    await prepareContentScript(activeTabId);
    await chrome.tabs.sendMessage(activeTabId, { type: "START_AUTO" });
    window.close();
  } catch (error) {
    reportStartFailure("整页识别", error);
  }
};

// --- boot -------------------------------------------------------------------

(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab?.id ?? null;
  lastTabUrl = tab?.url || "";
  const cfg = await chrome.storage.local.get(["autoTranslate"]);
  autoToggle.checked = Boolean(cfg.autoTranslate);
  pollWhileOpen();
})();
