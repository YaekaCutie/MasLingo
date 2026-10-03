const debugMode = document.getElementById("debugMode");
const result = document.getElementById("result");
const translationMode = document.getElementById("translationMode");
const translationEndpoint = document.getElementById("translationEndpoint");
const translationModel = document.getElementById("translationModel");
const translationApiKey = document.getElementById("translationApiKey");
const clearApiKey = document.getElementById("clearApiKey");
const keyStatus = document.getElementById("keyStatus");
let savedApiKeyExists = false;

async function load() {
  const cfg = await chrome.storage.local.get([
    "debugMode", "translationMode", "translationEndpoint", "translationModel",
    "translationApiKey"
  ]);
  debugMode.checked = cfg.debugMode !== false;
  translationMode.value = cfg.translationMode || "none";
  translationEndpoint.value = cfg.translationEndpoint || "";
  translationModel.value = cfg.translationModel || "";
  savedApiKeyExists = Boolean(cfg.translationApiKey);
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

translationMode.addEventListener("change", updateTranslationFields);
clearApiKey.addEventListener("change", () => {
  if (clearApiKey.checked) translationApiKey.value = "";
});

document.getElementById("save").onclick = async () => {
  const cfg = {
    debugMode: debugMode.checked,
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
  updateTranslationFields();
  result.textContent = "已保存本机设置。";
};

load();