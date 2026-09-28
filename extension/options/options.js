const model = document.getElementById("model");
const debugMode = document.getElementById("debugMode");
const result = document.getElementById("result");
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

async function load() {
  const cfg = await chrome.storage.local.get(["ollamaModel", "debugMode"]);
  model.value = cfg.ollamaModel || "qwen2.5vl:7b";
  debugMode.checked = cfg.debugMode !== false;
}

debugMode.addEventListener("change", async () => {
  await chrome.storage.local.set({ debugMode: debugMode.checked });
  result.textContent = debugMode.checked ? "调试模式已开启。" : "调试模式已关闭。";
});

document.getElementById("save").onclick = async () => {
  const selectedModel = model.value.trim();
  if (!selectedModel) { result.textContent="请填写 Ollama 模型名称。"; return; }
  await chrome.storage.local.set({
    ollamaModel: selectedModel
  });
  result.textContent="已保存。";
};

document.getElementById("test").onclick = async () => {
  const selectedModel = model.value.trim();
  if (!selectedModel) { result.textContent="请先填写 Ollama 模型名称。"; return; }

  result.textContent="正在测试…";
  try {
    const r = await fetchBackend("/api/test-ollama", {
      method:"POST",
      headers:{"X-Ollama-Model": selectedModel}
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.detail || "测试失败");
    result.textContent=`Ollama 已连接\n视觉模型：${j.model}\n本机已安装：${j.installed_models.join(", ")}`;
  } catch (e) {
    result.textContent="测试失败：" + e.message;
  }
};

load();