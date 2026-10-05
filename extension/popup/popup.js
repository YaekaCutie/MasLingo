const status = document.getElementById("status");
const autoToggle = document.getElementById("autoTranslate");
const autoState = document.getElementById("autoState");
const autoStateText = document.getElementById("autoStateText");

let statusTimer = null;
let activeTabId = null;

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

/** Ask the page what auto translate is doing. Failures are normal: the content
 *  script is absent on chrome:// pages and the Web Store. */
async function refreshAutoStatus() {
  if (!activeTabId) {
    setStatusText("当前页面无法使用", "idle");
    return;
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
  try {
    await chrome.tabs.sendMessage(tabId, { type: "PING" });
    return;
  } catch (error) {
    if (!error.message?.includes("Receiving end does not exist")) throw error;
  }
  await chrome.scripting.insertCSS({ target: { tabId }, files: ["content/styles.css"] });
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content/overlay.js", "content/auto.js", "content/content.js"],
  });
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
  const cfg = await chrome.storage.local.get(["autoTranslate"]);
  autoToggle.checked = Boolean(cfg.autoTranslate);
  pollWhileOpen();
})();
