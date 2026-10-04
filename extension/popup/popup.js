const status = document.getElementById("status");
const ocrStatus = document.getElementById("ocrStatus");
const translateStatus = document.getElementById("translateStatus");

function normalize(url) {
  return String(url || "").trim().replace(/\/+$/, "");
}

function isLocal(base) {
  return /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(normalize(base));
}

function setStatus(element, text, state = "") {
  element.textContent = text;
  if (state) element.dataset.state = state;
  else delete element.dataset.state;
}

async function fetchBackend(path, options = {}) {
  const backends = await globalThis.OMT_backendCandidates();
  let lastError = null;
  for (const base of backends) {
    try {
      const resp = await fetch(`${base}${path}`, options);
      if (resp.ok || resp.status >= 400) {
        return { resp, base };
      }
      lastError = new Error(`${base} 响应失败: ${resp.status}`);
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError || new Error("未配置后端且本机后端未运行");
}

/** OCR still runs on the backend, so this is a real dependency. */
async function refreshOcrStatus() {
  try {
    const { resp, base } = await fetchBackend("/health");
    const data = await resp.json();
    if (resp.ok && data.ok) {
      const where = base === normalize(globalThis.OMT_BACKEND_URL) ? "托管后端"
        : isLocal(base) ? "本机后端" : "自建后端";
      setStatus(ocrStatus, `${where} · 已就绪`, "ok");
    } else {
      setStatus(ocrStatus, "后端异常", "warn");
    }
  } catch (error) {
    setStatus(ocrStatus, "未连接", "warn");
  }
}

async function refreshTranslateStatus() {
  const cfg = await chrome.storage.local.get(["translationProvider", "translationMode"]);
  const registry = globalThis.OMT_providers;
  let providerId = cfg.translationProvider;
  if (!providerId) {
    providerId = !cfg.translationMode || cfg.translationMode === "none" ? "none"
      : cfg.translationMode === "free-translate" ? "google-free" : "openai";
  }
  const provider = registry.byId(providerId);
  if (!provider || provider.id === "none") {
    setStatus(translateStatus, "已关闭", "");
    return;
  }
  setStatus(translateStatus, provider.label, "ok");
}

async function prepareContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, {type:"PING"});
    return;
  } catch (error) {
    if (!error.message?.includes("Receiving end does not exist")) {
      throw error;
    }
  }

  await chrome.scripting.insertCSS({
    target:{tabId},
    files:["content/styles.css"]
  });
  await chrome.scripting.executeScript({
    target:{tabId},
    files:["content/content.js"]
  });
}

async function startPageAction(tabId, type) {
  await prepareContentScript(tabId);
  await chrome.tabs.sendMessage(tabId, {type});
}

function reportStartFailure(action, error) {
  const restrictedPage = /Cannot access|cannot be scripted|extensions gallery/i.test(error.message);
  document.getElementById("details").open = true;
  status.textContent = restrictedPage
    ? `当前页面受 Chrome 限制，无法${action}。请切换到普通网页后重试。`
    : `无法${action}：${error.message}`;
}

document.getElementById("settings").onclick =
document.getElementById("settings2").onclick = () => chrome.runtime.openOptionsPage();

document.getElementById("health").onclick = async () => {
  status.textContent = "正在检查…";
  document.getElementById("details").open = true;
  try {
    const { resp, base } = await fetchBackend("/health");
    const payload = await resp.json();
    status.textContent = `${base}\n${JSON.stringify(payload, null, 2)}`;
  } catch (e) {
    status.textContent = `OCR 后端未运行：${e.message}\n\n` +
      "识别需要后端：请在设置里填写后端地址，并在那台机器上启动 backend/（见仓库 deploy/ 目录）。";
  }
  await refreshOcrStatus();
};

document.getElementById("select").onclick = async () => {
  const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
  try {
    if (!tab?.id) throw new Error("无法获取当前页面");
    await startPageAction(tab.id, "START_SELECT");
    window.close();
  } catch (e) {
    reportStartFailure("框选", e);
  }
};

document.getElementById("auto").onclick = async () => {
  const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
  try {
    if (!tab?.id) throw new Error("无法获取当前页面");
    await startPageAction(tab.id, "START_AUTO");
    window.close();
  } catch (e) {
    reportStartFailure("自动识别", e);
  }
};

refreshOcrStatus();
refreshTranslateStatus();
