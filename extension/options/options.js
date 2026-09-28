const apiKey = document.getElementById("apiKey");
const model = document.getElementById("model");
const autoFallbackEnabled = document.getElementById("autoFallbackEnabled");
const debugMode = document.getElementById("debugMode");
const result = document.getElementById("result");
const BACKEND_URLS = ["http://127.0.0.1:8001", "http://localhost:8001"];
const RETIRED_MODELS = {
  "gemini-2.5-flash": "gemini-3.8-flash",
  "gemini-2.5-flash-lite": "gemini-3.5-flash-lite"
};

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

async function load() {
  const cfg = await chrome.storage.local.get(["geminiApiKey","geminiModel","debugMode","autoFallbackEnabled"]);
  apiKey.value = cfg.geminiApiKey || "";
  model.value = RETIRED_MODELS[cfg.geminiModel] || cfg.geminiModel || "gemini-3.8-flash";
  if (cfg.geminiModel && RETIRED_MODELS[cfg.geminiModel]) {
    await chrome.storage.local.set({ geminiModel: model.value });
    result.textContent = `已将停用模型替换为 ${model.value}。`;
  }
  debugMode.checked = cfg.debugMode !== false;
  autoFallbackEnabled.checked = cfg.autoFallbackEnabled !== false;
}

debugMode.addEventListener("change", async () => {
  await chrome.storage.local.set({ debugMode: debugMode.checked });
  result.textContent = debugMode.checked ? "调试模式已开启。" : "调试模式已关闭。";
});

autoFallbackEnabled.addEventListener("change", async () => {
  await chrome.storage.local.set({ autoFallbackEnabled: autoFallbackEnabled.checked });
  result.textContent = autoFallbackEnabled.checked ? "自动切换下级模型已开启。" : "自动切换下级模型已关闭。";
});

document.getElementById("toggleKey").onclick = () => {
  const b = document.getElementById("toggleKey");
  if (apiKey.type === "password") { apiKey.type="text"; b.textContent="隐藏"; }
  else { apiKey.type="password"; b.textContent="显示"; }
};

document.getElementById("save").onclick = async () => {
  const key = apiKey.value.trim();
  if (!key) { result.textContent="API Key 不能为空。"; return; }
  await chrome.storage.local.set({
    geminiApiKey: key,
    geminiModel: model.value
  });
  result.textContent="已保存。";
};

document.getElementById("test").onclick = async () => {
  const key = apiKey.value.trim();
  const selectedModel = model.value;
  if (!key) { result.textContent="请先填写 API Key。"; return; }

  result.textContent="正在测试…";
  try {
    const r = await fetchBackend("/api/test-gemini", {
      method:"POST",
      headers:{
        "X-Gemini-API-Key": key,
        "X-Gemini-Model": selectedModel
      }
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.detail || "测试失败");
    result.textContent=`连接成功\n模型：${j.model}\n模型名称：${j.display_name || "—"}`;
  } catch (e) {
    result.textContent="测试失败：" + e.message;
  }
};

load();