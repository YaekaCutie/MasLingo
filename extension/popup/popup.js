const status = document.getElementById("status");
const backendRole = document.getElementById("backendRole");

function normalize(url) {
  return String(url || "").trim().replace(/\/+$/, "");
}

function isLocal(base) {
  return /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(normalize(base));
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
  try {
    const { resp, base } = await fetchBackend("/health");
    const data = await resp.json();
    if (resp.ok && data.ok) {
      if (base === normalize(globalThis.OMT_BACKEND_URL)) {
        backendRole.textContent = "官方托管后端";
      } else if (isLocal(base)) {
        backendRole.textContent = "本机后端";
      } else {
        backendRole.textContent = "自定义后端";
      }
    } else {
      backendRole.textContent = "后端异常";
    }
  } catch (error) {
    backendRole.textContent = "未连接";
  }
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
  try {
    const { resp, base } = await fetchBackend("/health");
    const j = await resp.json();
    status.textContent = `${base}\n${JSON.stringify(j, null, 2)}`;
    await refreshConfig();
  } catch (e) {
    status.textContent = "后端未运行：" + e.message;
    backendRole.textContent = "未连接";
  }
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
