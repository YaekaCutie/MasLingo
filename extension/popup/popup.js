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
  const backends = await globalThis.OMT_backendCandidates();
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
      func: () => Boolean(globalThis.__OMT_LOADED__),
    });
    return probe?.result ? "stale" : "missing";
  } catch (error) {
    return /Cannot access|chrome:\/\/|extensions gallery|The extensions gallery/i.test(error.message)
      ? "restricted"
      : "restricted";
  }
}

async function injectContentScript(tabId) {
  await chrome.scripting.insertCSS({ target: { tabId }, files: ["content/styles.css"] });
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content/overlay.js", "content/auto.js", "content/content.js"],
  });
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
    if (busy > 0) {
      setStatusText(`正在翻译 ${busy} 个区域`, "working");
    } else if (stats.translated > 0 && stats.failed === 0) {
      setStatusText(`✓ 当前页面翻译完成（${stats.translated} 处）`, "done");
    } else if (stats.translated > 0) {
      setStatusText(`已完成 ${stats.translated} 处，${stats.failed} 处失败`, "error");
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

function pollWhileOpen() {
  refreshAutoStatus();
  statusTimer = setInterval(refreshAutoStatus, 1000);
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
