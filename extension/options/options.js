const registry = globalThis.MAS_providers;

const debugMode = document.getElementById("debugMode");
const result = document.getElementById("result");
const backendUrl = document.getElementById("backendUrl");
const backendHint = document.getElementById("backendHint");

const providerSelect = document.getElementById("translationProvider");
const providerNote = document.getElementById("providerNote");
const providerKeyLink = document.getElementById("providerKeyLink");
const keyLink = document.getElementById("keyLink");
const fieldEndpoint = document.getElementById("fieldEndpoint");
const fieldModel = document.getElementById("fieldModel");
const fieldAppId = document.getElementById("fieldAppId");
const fieldKey = document.getElementById("fieldKey");
const fieldTarget = document.getElementById("fieldTarget");
const fieldGlossary = document.getElementById("fieldGlossary");
const translationEndpoint = document.getElementById("translationEndpoint");
const translationModel = document.getElementById("translationModel");
const translationAppId = document.getElementById("translationAppId");
const translationApiKey = document.getElementById("translationApiKey");
const targetLanguage = document.getElementById("targetLanguage");
const translationGlossary = document.getElementById("translationGlossary");
const clearApiKey = document.getElementById("clearApiKey");
const keyStatus = document.getElementById("keyStatus");
const keyLabel = document.getElementById("keyLabel");
const appIdLabel = document.getElementById("appIdLabel");
const testResult = document.getElementById("testResult");

// --- new controls -----------------------------------------------------------

const autoTranslate = document.getElementById("autoTranslate");
const webAutoTranslate = document.getElementById("webAutoTranslate");
const webDisplayMode = document.getElementById("webDisplayMode");
const videoDisplayMode = document.getElementById("videoDisplayMode");
const hoverTranslate = document.getElementById("hoverTranslate");
const selectionTranslate = document.getElementById("selectionTranslate");
const inputAutoReplace = document.getElementById("inputAutoReplace");
let selectionPreference = true;
let inputReplacePreference = true;
const autoConcurrency = document.getElementById("autoConcurrency");
const fontScale = document.getElementById("fontScale");
const overlayOpacity = document.getElementById("overlayOpacity");
const fontScaleValue = document.getElementById("fontScaleValue");
const overlayOpacityValue = document.getElementById("overlayOpacityValue");

function syncSliderLabels() {
  fontScaleValue.textContent = `${fontScale.value}%`;
  overlayOpacityValue.textContent = `${overlayOpacity.value}%`;
}

fontScale.addEventListener("input", syncSliderLabels);
overlayOpacity.addEventListener("input", syncSliderLabels);

// The key is typed blind by design; this only helps check a paste went in
// whole, and never reveals a key that was already saved.
document.getElementById("revealKey").onclick = (event) => {
  const revealing = translationApiKey.type === "password";
  translationApiKey.type = revealing ? "text" : "password";
  event.currentTarget.textContent = revealing ? "隐藏" : "显示";
};

let savedApiKeyExists = false;
let loadVersion = 0;
let editVersion = 0;
let providerDraftVersion = 0;
const drafts = new Map();
const providerFields = [
  "translationProvider", "translationEndpoint", "translationModel",
  "translationAppId", "translationApiKey", "clearApiKey",
];
const settingsKeys = [
  "debugMode", "backendUrl", "translationProvider", "translationMode",
  "translationEndpoint", "translationModel", "translationAppId",
  "translationModelProvider", "translationApiKey", "targetLanguage",
  "translationGlossary", "autoTranslate", "webAutoTranslate", "webDisplayMode",
  "videoDisplayMode", "hoverTranslate", "selectionTranslate", "inputAutoReplace",
  "autoConcurrency", "fontScale", "overlayOpacity", "translationStrength",
];
function markDraft(event) {
  if (event.target.matches?.("input[id], select[id]")) drafts.set(event.target.id, ++editVersion);
}
document.addEventListener("input", markDraft, true);
document.addEventListener("change", markDraft, true);

// --- 翻译来源选择 -----------------------------------------------------------

function buildGlossaryOptions() {
  for (const glossary of registry.glossaries || []) {
    const option = document.createElement("option");
    option.value = glossary.id;
    option.textContent = `${glossary.label} — ${glossary.hint}`;
    translationGlossary.append(option);
  }
  translationGlossary.value = "general";
}

function selectedProvider() {
  return registry.byId(providerSelect.value) || null;
}

function describeProvider() {
  const provider = selectedProvider();
  if (!provider) return;

  providerNote.textContent = provider.note || "";

  const hasKeyLink = Boolean(provider.keyUrl);
  providerKeyLink.hidden = !hasKeyLink;
  if (hasKeyLink) {
    keyLink.href = provider.keyUrl;
    keyLink.textContent = `获取 ${provider.label} 密钥 →`;
  }

  fieldEndpoint.hidden = !provider.endpointEditable;
  fieldModel.hidden = !provider.modelEditable;
  fieldAppId.hidden = !(provider.appIdRequired || provider.appIdOptional);
  fieldKey.hidden = !(provider.keyRequired || provider.keyOptional);
  fieldTarget.hidden = !provider.adapter;
  document.getElementById("targetHint").textContent = provider.targetKind === "name"
    ? "与侧栏及文档页同步，也可输入其他语言名称。"
    : "与侧栏及文档页同步。请选择此来源支持的目标语言。";
  const ai = registry.isChatProvider(provider);
  document.getElementById("translationStrength").disabled = !ai;
  fieldGlossary.classList.toggle("ai-disabled", !ai);
  translationGlossary.disabled = !ai;
  translationGlossary.setAttribute("aria-describedby", "glossaryHint");
  document.getElementById("glossaryHint").textContent = ai
    ? "译文会优先采用所选领域的专业术语与表达。"
    : "专业术语库仅支持 AI 翻译，切换到 DeepSeek 等 AI 来源后可用。";
  document.getElementById("selectionField").classList.toggle("ai-disabled", !ai);
  selectionTranslate.disabled = !ai;
  selectionTranslate.checked = ai && selectionPreference;
  inputAutoReplace.disabled = !ai || !selectionPreference;
  inputAutoReplace.checked = ai && selectionPreference && inputReplacePreference;
  document.getElementById("selectionHint").textContent = ai
    ? "选中文字，查看词义、例句或短句译文。"
    : "划词词典仅支持 AI 翻译，切换到 DeepSeek 等 AI 来源后可用。";

  if (provider.endpointEditable) {
    translationEndpoint.placeholder = provider.endpoint || "https://example.com/v1/chat/completions";
    document.getElementById("endpointHint").textContent =
      "保存时会向浏览器申请该域名的访问权限；只申请你填写的这一个域名。";
  }
  if (!fieldModel.hidden) {
    translationModel.placeholder = provider.model ? `默认 ${provider.model}` : "填写接口支持的模型 ID";
    document.getElementById("providerModels").replaceChildren(
      ...registry.modelsOf(provider).map(model => new Option(model.label, model.id)),
    );
  }
  if (!fieldKey.hidden) {
    keyLabel.textContent = provider.keyLabel || "API Key";
    keyStatus.textContent = savedApiKeyExists
      ? "本机已保存密钥；输入新值可替换。密钥只保存在此浏览器的扩展存储中。"
      : "密钥只保存在此浏览器的扩展存储中，直接发往上面这个服务。";
  }
  if (!fieldAppId.hidden) {
    appIdLabel.textContent = provider.appIdLabel || "APP ID";
  }
  if (!fieldTarget.hidden) {
    targetLanguage.placeholder = provider.target || "简体中文";
  }
  testResult.hidden = true;
}

// --- 保存 -------------------------------------------------------------------

/** Ask for the origin of a custom endpoint, at the moment the user saves it. */
async function ensureEndpointPermission(provider, endpoint) {
  if (!provider.endpointEditable || !endpoint) return true;
  let origin;
  try {
    origin = new URL(endpoint).origin;
  } catch {
    throw new Error("接口地址不是有效的 URL");
  }
  if (origin.startsWith("http://127.0.0.1") || origin.startsWith("http://localhost")) return true;
  const pattern = `${origin}/*`;
  if (await chrome.permissions.contains({ origins: [pattern] })) return true;
  const granted = await chrome.permissions.request({ origins: [pattern] });
  if (!granted) {
    throw new Error(`未授权访问 ${origin}，翻译请求会被浏览器拦截。`);
  }
  return true;
}

function showResult(text, kind = "ok") {
  result.hidden = false;
  result.textContent = text;
  result.dataset.kind = kind;
}

function showProviderSettings(settings) {
  for (const input of [translationEndpoint, translationModel, translationAppId]) {
    if (!drafts.has(input.id)) input.value = settings[input.id];
  }
  savedApiKeyExists = Boolean(settings.translationApiKey);
  describeProvider();
}

providerSelect.addEventListener("change", async () => {
  const version = ++providerDraftVersion;
  const id = providerSelect.value;
  for (const key of providerFields.slice(1)) drafts.delete(key);
  translationApiKey.value = "";
  clearApiKey.checked = false;
  showProviderSettings(registry.providerSettings({}, id));
  const cfg = await chrome.storage.local.get([...registry.profileKeys, registry.profileKey(id)]);
  if (version === providerDraftVersion) showProviderSettings(registry.providerSettings(cfg, id));
});

selectionTranslate.addEventListener("change", () => {
  selectionPreference = selectionTranslate.checked;
  describeProvider();
});

inputAutoReplace.addEventListener("change", () => {
  inputReplacePreference = inputAutoReplace.checked;
});

document.getElementById("save").onclick = async () => {
  const provider = selectedProvider();
  if (!provider) return;
  const editing = new Map(drafts);
  const providerChanged = editing.has("translationProvider");
  const endpoint = provider.endpointEditable
    ? translationEndpoint.value.trim().replace(/\/+$/, "")
    : "";

  const cfg = {
    debugMode: debugMode.checked,
    backendUrl: backendUrl.value.trim().replace(/\/+$/, ""),
    translationEndpoint: endpoint,
    translationModel: translationModel.value.trim(),
    translationAppId: translationAppId.value.trim(),
    autoTranslate: autoTranslate.checked,
    webAutoTranslate: webAutoTranslate.checked,
    webDisplayMode: globalThis.MAS_webDisplayMode(webDisplayMode.value),
    videoDisplayMode: globalThis.MAS_webDisplayMode(videoDisplayMode.value),
    hoverTranslate: hoverTranslate.checked,
    selectionTranslate: selectionPreference,
    inputAutoReplace: inputReplacePreference,
    translationGlossary: translationGlossary.value || "general",
    translationStrength: Number(document.getElementById("translationStrength").value),
    autoConcurrency: Number(autoConcurrency.value) || 1,
    fontScale: Number(fontScale.value) / 100,
    overlayOpacity: Number(overlayOpacity.value) / 100
  };
  cfg.targetLanguage = targetLanguage.value.trim();
  const newKey = translationApiKey.value.trim();
  if (newKey) cfg.translationApiKey = newKey;
  else if (clearApiKey.checked) cfg.translationApiKey = "";

  // Saving one draft must not write old copies of fields edited in the sidebar.
  for (const key of Object.keys(cfg)) {
    if (editing.has(key) || key === "translationApiKey") continue;
    delete cfg[key];
  }
  if (!providerChanged && !Object.keys(cfg).length) { showResult("没有需要保存的修改。"); return; }
  const save = document.getElementById("save");
  save.disabled = true;
  try {
    if (editing.has("translationEndpoint")) await ensureEndpointPermission(provider, endpoint);
    if (providerFields.some(key => editing.has(key))) {
      await registry.saveProvider(provider.id, cfg, { onlyIfCurrent: !providerChanged });
    } else {
      await chrome.storage.local.set(cfg);
    }
  } catch (error) {
    showResult(error.message, "error");
    return;
  } finally {
    save.disabled = false;
  }
  for (const [key, version] of editing) if (drafts.get(key) === version) drafts.delete(key);
  if (!drafts.has("translationApiKey")) translationApiKey.value = "";
  if (!drafts.has("clearApiKey")) clearApiKey.checked = false;
  await load();
  showResult(`已保存。翻译由「${provider.label}」完成。`);
};

document.getElementById("test").onclick = async () => {
  const provider = selectedProvider();
  if (!provider) return;
  testResult.hidden = false;
  testResult.dataset.kind = "pending";
  testResult.textContent = "正在测试…";
  try {
    if (providerFields.some(key => drafts.has(key)) || drafts.has("targetLanguage")) {
      throw new Error("请先保存翻译设置，再测试连接");
    }
    const response = await chrome.runtime.sendMessage({ type: "TEST_TRANSLATION" });
    if (response?.ok) {
      testResult.dataset.kind = "ok";
      testResult.textContent = `测试成功：「${response.text}」→「${response.translated}」`;
    } else {
      testResult.dataset.kind = "error";
      testResult.textContent = `测试失败：${response?.error || "未知错误"}`;
    }
  } catch (error) {
    testResult.dataset.kind = "error";
    testResult.textContent = `测试失败：${error.message}`;
  }
};

// --- 载入 -------------------------------------------------------------------

function describeBackend() {
  const value = backendUrl.value.trim();
  backendHint.textContent = value
    ? `漫画画面会发送到 ${value}，只用于 OCR。自动翻译发送图片本身，框选翻译发送截图。`
    : "留空则在识别时尝试本机 http://127.0.0.1:8001。自建后端请参考仓库里的 deploy/。";
}

async function load() {
  const version = ++loadVersion;
  const cfg = await chrome.storage.local.get([
    ...settingsKeys, ...registry.list.map(provider => registry.profileKey(provider.id)),
  ]);
  if (version !== loadVersion) return;
  const set = (element, value) => {
    if (!drafts.has(element.id)) element[element.type === "checkbox" ? "checked" : "value"] = value;
  };
  set(document.getElementById("translationStrength"), String(registry.normalizeStrength(cfg.translationStrength)));
  set(debugMode, cfg.debugMode !== false);
  set(backendUrl, cfg.backendUrl || "");
  set(autoTranslate, Boolean(cfg.autoTranslate));
  set(webAutoTranslate, Boolean(cfg.webAutoTranslate));
  set(webDisplayMode, globalThis.MAS_webDisplayMode(cfg.webDisplayMode));
  set(videoDisplayMode, globalThis.MAS_webDisplayMode(cfg.videoDisplayMode));
  set(hoverTranslate, Boolean(cfg.hoverTranslate));
  if (!drafts.has("selectionTranslate")) selectionPreference = cfg.selectionTranslate !== false;
  if (!drafts.has("inputAutoReplace")) inputReplacePreference = cfg.inputAutoReplace !== false;
  set(autoConcurrency, String(Math.min(3, Math.max(1, cfg.autoConcurrency || 1))));
  set(fontScale, String(Math.round((cfg.fontScale ?? 1) * 100)));
  set(overlayOpacity, String(Math.round((cfg.overlayOpacity ?? 1) * 100)));
  syncSliderLabels();

  document.getElementById("version").textContent = chrome.runtime.getManifest().version;

  if (!providerFields.some(key => drafts.has(key))) {
    providerSelect.value = registry.resolveProviderId(cfg);
  }
  set(targetLanguage, cfg.targetLanguage || "");
  set(translationGlossary, registry.glossaryById?.(cfg.translationGlossary)?.id || "general");
  describeBackend();
  showProviderSettings(registry.providerSettings(cfg, providerSelect.value));
}

backendUrl.addEventListener("input", describeBackend);

registry.appendProviderOptions(providerSelect);
for (const language of registry.languages) document.getElementById("targetLanguages").append(new Option(language.name));
buildGlossaryOptions();
load();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && settingsKeys.some(key => key in changes)) load().catch(() => {});
});

// Keep all fields mounted while switching groups so unsaved edits survive.
const sectionLinks = [...document.querySelectorAll('.settings-nav a')];
function selectSection() {
  const selected = sectionLinks.some(link => link.hash === location.hash) ? location.hash.slice(1) : 'reading';
  let first = true;
  for (const section of document.querySelectorAll('[data-settings-group]')) {
    section.hidden = section.dataset.settingsGroup !== selected;
    section.classList.toggle('group-start', !section.hidden && first);
    if (!section.hidden) first = false;
  }
  for (const link of sectionLinks) {
    if (link.hash === '#' + selected) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}
for (const link of sectionLinks) link.onclick = event => {
  event.preventDefault(); history.replaceState(null, '', link.hash); selectSection();
};
window.addEventListener('hashchange', selectSection);
selectSection();
