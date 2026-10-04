const debugMode = document.getElementById("debugMode");
const result = document.getElementById("result");
const backendUrl = document.getElementById("backendUrl");
const backendHint = document.getElementById("backendHint");
const ocrMode = document.getElementById("ocrMode");
const ocrModeHint = document.getElementById("ocrModeHint");
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
  const onDevice = ocrMode.value !== "backend";

  // Only claim screenshots are uploaded when they actually are. With on-device
  // recognition the page never leaves the machine, and saying otherwise would
  // be a false privacy statement.
  if (onDevice) {
    backendHint.textContent = value
      ? `当前为本机识别，截图不会发送到任何服务器；只有在识别失败时才会回退到 ${value}。`
      : hosted
        ? `当前为本机识别，截图不会发送到任何服务器；只有在识别失败时才会回退到官方托管后端。`
        : "当前为本机识别，截图不会发送到任何服务器。";
    return;
  }
  if (value) {
    backendHint.textContent = `识别时会把页面截图发送到 ${value}；它只用于 OCR，不做其它用途。`;
  } else if (hosted) {
    backendHint.textContent = `识别时会把页面截图发送到官方托管后端 ${hosted}；它只用于 OCR，不做其它用途。`;
  } else {
    backendHint.textContent = "未配置后端，将尝试本机 http://127.0.0.1:8001。";
  }
}

function describeOcrMode() {
  ocrModeHint.textContent = ocrMode.value === "backend"
    ? "后端识别：页面截图会发送到后端服务，由服务器完成识别。"
    : "本机识别：模型在你的浏览器里运行，页面截图不会离开这台电脑。首次识别需要加载约 117 MB 的模型（已随扩展安装，无需联网下载）。";
}

async function load() {
  const cfg = await chrome.storage.local.get([
    "debugMode", "backendUrl", "ocrMode", "translationMode", "translationEndpoint",
    "translationModel", "translationApiKey"
  ]);
  debugMode.checked = cfg.debugMode !== false;
  backendUrl.value = cfg.backendUrl || "";
  ocrMode.value = cfg.ocrMode === "backend" ? "backend" : "on-device";
  translationMode.value = cfg.translationMode || "none";
  translationEndpoint.value = cfg.translationEndpoint || "";
  translationModel.value = cfg.translationModel || "";
  savedApiKeyExists = Boolean(cfg.translationApiKey);
  describeOcrMode();
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
ocrMode.addEventListener("change", () => {
  describeOcrMode();
  describeBackend();
});
translationMode.addEventListener("change", updateTranslationFields);
clearApiKey.addEventListener("change", () => {
  if (clearApiKey.checked) translationApiKey.value = "";
});

document.getElementById("save").onclick = async () => {
  const cfg = {
    debugMode: debugMode.checked,
    backendUrl: backendUrl.value.trim().replace(/\/+$/, ""),
    ocrMode: ocrMode.value === "backend" ? "backend" : "on-device",
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
  describeOcrMode();
  describeBackend();
  updateTranslationFields();
  result.textContent = "已保存本机设置。";
};

load();
