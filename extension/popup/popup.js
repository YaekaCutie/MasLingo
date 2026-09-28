const status = document.getElementById("status");
const geminiStatus = document.getElementById("geminiStatus");
const modelName = document.getElementById("modelName");
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
  const cfg = await chrome.storage.local.get(["geminiApiKey", "geminiModel"]);
  modelName.textContent = cfg.geminiModel || "gemini-3.8-flash";
  geminiStatus.textContent = cfg.geminiApiKey ? "已配置" : "未配置";
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
  const cfg = await chrome.storage.local.get(["geminiApiKey"]);
  if (!cfg.geminiApiKey) {
    status.textContent = "请先在“API Key / 模型设置”中填写 Gemini API Key。";
    return;
  }
  const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
  try {
    await chrome.tabs.sendMessage(tab.id, {type:"START_SELECT"});
    window.close();
  } catch (e) {
    status.textContent = "无法注入当前页面：" + e.message;
  }
};

refreshConfig();