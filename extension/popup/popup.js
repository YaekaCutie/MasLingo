const status = document.getElementById("status");
const BACKEND_URLS = ["http://127.0.0.1:8001", "http://localhost:8001"];

async function fetchBackend(path, options = {}) {
  let lastError = null;
  for (const base of BACKEND_URLS) {
    try {
      const resp = await fetch(`${base}${path}`, options);
      if (resp.ok || resp.status >= 400) {
        return resp;
      }
      lastError = new Error(`后端响应失败: ${resp.status}`);
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError || new Error("后端未运行或无法访问");
}

async function refreshConfig() {
}

async function startSelection(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, {type:"START_SELECT"});
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
  await chrome.tabs.sendMessage(tabId, {type:"START_SELECT"});
}

document.getElementById("settings").onclick =
document.getElementById("settings2").onclick = () => chrome.runtime.openOptionsPage();

document.getElementById("health").onclick = async () => {
  try {
    const r = await fetchBackend("/health");
    const j = await r.json();
    status.textContent = JSON.stringify(j, null, 2);
    await refreshConfig();
  } catch (e) {
    status.textContent = "后端未运行：" + e.message;
  }
};

document.getElementById("select").onclick = async () => {
  await refreshConfig();
  const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
  try {
    if (!tab?.id) throw new Error("无法获取当前页面");
    await startSelection(tab.id);
    window.close();
  } catch (e) {
    const restrictedPage = /Cannot access|cannot be scripted|extensions gallery/i.test(e.message);
    status.textContent = restrictedPage
      ? "当前页面受 Chrome 限制，无法框选。请切换到普通网页后重试。"
      : "无法启动框选：" + e.message;
  }
};

refreshConfig();