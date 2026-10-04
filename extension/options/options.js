const debugMode = document.getElementById("debugMode");
const result = document.getElementById("result");
const backendUrl = document.getElementById("backendUrl");
const backendHint = document.getElementById("backendHint");
const translationMode = document.getElementById("translationMode");
const translationEndpoint = document.getElementById("translationEndpoint");
const translationModel = document.getElementById("translationModel");
const translationApiKey = document.getElementById("translationApiKey");
const clearApiKey = document.getElementById("clearApiKey");
const keyStatus = document.getElementById("keyStatus");
let savedApiKeyExists = false;

function describeBackend() {
  const value = backendUrl.value.trim();
  const hosted = globalThis.OMT_BACKEND_URL || "";
  if (value) {
    backendHint.textContent = `识别时会优先把页面截图发送到 ${value}。`;
  } else if (hosted) {
    backendHint.textContent = `识别时会把页面截图发送到官方托管后端 ${hosted}；它只用于 OCR，不做其它用途。`;
  } else {
    backendHint.textContent = "未配置托管后端，识别时会尝试本机 http://127.0.0.1:8001。";
  }
}

async function load() {
  const cfg = await chrome.storage.local.get([
    "debugMode", "backendUrl", "translationMode", "translationEndpoint",
    "translationModel", "translationApiKey"
  ]);
  debugMode.checked = cfg.debugMode !== false;
  backendUrl.value = cfg.backendUrl || "";
  translationMode.value = cfg.translationMode || "none";
  translationEndpoint.value = cfg.translationEndpoint || "";
  translationModel.value = cfg.translationModel || "";
  savedApiKeyExists = Boolean(cfg.translationApiKey);
  describeBackend();
  updateTranslationFields();
}

function updateTranslationFields() {
  document.getElementById("openaiSettings").hidden =
    translationMode.value !== "openai-compatible";
  keyStatus.textContent = savedApiKeyExists
    ? "本机已有保存的 API Key；输入新值可替换。"
    : "API Key 仅保存在此浏览器的扩展本地存储中。";
}

debugMode.addEventListener("change", async () => {
  await chrome.storage.local.set({ debugMode: debugMode.checked });
  result.textContent = debugMode.checked ? "调试模式已开启。" : "调试模式已关闭。";
});

backendUrl.addEventListener("input", describeBackend);
translationMode.addEventListener("change", updateTranslationFields);
clearApiKey.addEventListener("change", () => {
  if (clearApiKey.checked) translationApiKey.value = "";
});

document.getElementById("save").onclick = async () => {
  const cfg = {
    debugMode: debugMode.checked,
    backendUrl: backendUrl.value.trim().replace(/\/+$/, ""),
    translationMode: translationMode.value,
    translationEndpoint: translationEndpoint.value.trim(),
    translationModel: translationModel.value.trim()
  };
  const newKey = translationApiKey.value.trim();
  if (newKey) cfg.translationApiKey = newKey;
  else if (clearApiKey.checked) cfg.translationApiKey = "";
  await chrome.storage.local.set(cfg);
  savedApiKeyExists = Boolean(newKey) || (savedApiKeyExists && !clearApiKey.checked);
  translationApiKey.value = "";
  clearApiKey.checked = false;
  describeBackend();
  updateTranslationFields();
  result.textContent = "已保存本机设置。";
};

load();
