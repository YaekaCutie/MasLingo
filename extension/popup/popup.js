const status = document.getElementById("status");
const backendRole = document.getElementById("backendRole");

function normalize(url) {
  return String(url || "").trim().replace(/\/+$/, "");
}

function isLocal(base) {
  return /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(normalize(base));
}

async function readOcrMode() {
  const cfg = await chrome.storage.local.get(["ocrMode"]);
  return cfg.ocrMode === "backend" ? "backend" : "on-device";
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

async function refreshConfig() {
  const mode = await readOcrMode();
  let backendLabel = "未连接";
  try {
    const { resp, base } = await fetchBackend("/health");
    const data = await resp.json();
    if (resp.ok && data.ok) {
      if (base === normalize(globalThis.OMT_BACKEND_URL)) {
        backendLabel = "官方托管后端";
      } else if (isLocal(base)) {
        backendLabel = "本机后端";
      } else {
        backendLabel = "自定义后端";
      }
    } else {
      backendLabel = "后端异常";
    }
  } catch (error) {
    // A missing backend is not a problem when recognition runs on-device — it
    // is only a fallback — so this must not look like a failure.
    backendLabel = "未运行（可选）";
  }

  if (mode === "backend") {
    backendRole.textContent = backendLabel;
  } else {
    backendRole.textContent = "本机（端上）";
  }
}

/** Ask the service worker how the on-device engine is doing. */
async function ocrStatusText() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "OCR_STATUS" });
    const state = response?.status;
    if (!state) return "本机识别：未初始化（首次识别时加载）";
    if (state.state === "ready") {
      return `本机识别：就绪（模型加载 ${state.loadMs ?? "?"} ms，已识别 ${state.recognitions} 次）`;
    }
    if (state.state === "loading") return "本机识别：正在加载模型…";
    if (state.state === "failed") return `本机识别：不可用（${state.error}）`;
  } catch (error) {
    // The worker may be asleep; that is normal and not worth surfacing.
  }
  return "本机识别：未初始化（首次识别时加载）";
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

document.getElementById("settings").onclick =
document.getElementById("settings2").onclick = () => chrome.runtime.openOptionsPage();

document.getElementById("health").onclick = async () => {
  const lines = [await ocrStatusText()];
  try {
    const { resp, base } = await fetchBackend("/health");
    const j = await resp.json();
    lines.push(`${base}\n${JSON.stringify(j, null, 2)}`);
  } catch (e) {
    lines.push(`后端（仅作回退，未运行不影响使用）：${e.message}`);
  }
  status.textContent = lines.join("\n\n");
  await refreshConfig();
};

document.getElementById("select").onclick = async () => {
  await refreshConfig();
  const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
  try {
    if (!tab?.id) throw new Error("无法获取当前页面");
    await startPageAction(tab.id, "START_SELECT");
    window.close();
  } catch (e) {
    const restrictedPage = /Cannot access|cannot be scripted|extensions gallery/i.test(e.message);
    status.textContent = restrictedPage
      ? "当前页面受 Chrome 限制，无法框选。请切换到普通网页后重试。"
      : "无法启动框选：" + e.message;
  }
};

document.getElementById("auto").onclick = async () => {
  const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
  try {
    if (!tab?.id) throw new Error("无法获取当前页面");
    await startPageAction(tab.id, "START_AUTO");
    window.close();
  } catch (e) {
    const restrictedPage = /Cannot access|cannot be scripted|extensions gallery/i.test(e.message);
    status.textContent = restrictedPage
      ? "当前页面受 Chrome 限制，无法自动识别。请切换到普通网页后重试。"
      : "无法启动自动识别：" + e.message;
  }
};

refreshConfig();
