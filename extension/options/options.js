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
const translationProvider = providerSelect;
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
let savedAppIdExists = false;
// Which provider the stored model id was chosen for (see resolveModel in
// providers.js) — switching sources must not carry it over.
let savedModelOwner = "";

// --- 翻译来源选择 -----------------------------------------------------------

function buildProviderOptions() {
  const groups = new Map();
  for (const provider of registry.list) {
    if (!groups.has(provider.group)) groups.set(provider.group, []);
    groups.get(provider.group).push(provider);
  }
  for (const [group, items] of groups) {
    const optgroup = document.createElement("optgroup");
    optgroup.label = group;
    for (const provider of items) {
      const option = document.createElement("option");
      option.value = provider.id;
      option.textContent = provider.label;
      optgroup.appendChild(option);
    }
    providerSelect.appendChild(optgroup);
  }
}

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
  fieldAppId.hidden = !provider.appIdRequired;
  fieldKey.hidden = !provider.keyRequired;
  fieldTarget.hidden = provider.targetKind !== "name";
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
    translationModel.placeholder = provider.model ? `默认 ${provider.model}` : "例如 gpt-4o-mini";
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

providerSelect.addEventListener("change", () => {
  if (savedModelOwner && savedModelOwner !== providerSelect.value) {
    translationModel.value = "";
  }
  describeProvider();
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
  const endpoint = translationEndpoint.value.trim().replace(/\/+$/, "") ||
    (provider.endpointEditable ? "" : provider.endpoint || "");
  try {
    await ensureEndpointPermission(provider, endpoint);
  } catch (error) {
    showResult(error.message, "error");
    return;
  }

  const cfg = {
    debugMode: debugMode.checked,
    backendUrl: backendUrl.value.trim().replace(/\/+$/, ""),
    translationProvider: provider.id,
    // Kept in step for the code paths that still read it. Both branches used to
    // return the same string, so this looked like a mapping while mapping
    // nothing — and it pinned the "自建后端" provider to a mode that always
    // failed, whatever the user did.
    translationMode: (provider.id === "google-free" || provider.id === "backend")
      ? "free-translate"
      : "openai-compatible",
    translationEndpoint: endpoint,
    translationModel: translationModel.value.trim(),
    // Which provider the model box was filled in for. The panel has its own
    // model picker now, and this is what keeps one vendor's model id from
    // being sent to the next vendor after a source switch.
    translationModelProvider: provider.id,
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
  // Only the chat-based providers use the language *name*; saving the box's
  // leftover value while it is hidden is how a code-based provider (DeepL,
  // Baidu, Google) ended up being sent "繁體中文" as a language code. Leaving
  // the key out preserves whatever was last typed for the providers that do
  // use it.
  if (provider.targetKind === "name") {
    cfg.targetLanguage = targetLanguage.value.trim();
  }
  const newKey = translationApiKey.value.trim();
  if (newKey) cfg.translationApiKey = newKey;
  else if (clearApiKey.checked) cfg.translationApiKey = "";

  await chrome.storage.local.set(cfg);
  savedApiKeyExists = Boolean(newKey) || (savedApiKeyExists && !clearApiKey.checked);
  savedAppIdExists = Boolean(cfg.translationAppId) || savedAppIdExists;
  savedModelOwner = provider.id;
  translationApiKey.value = "";
  clearApiKey.checked = false;
  describeProvider();
  showResult(`已保存。翻译由「${provider.label}」完成。`);
};

document.getElementById("test").onclick = async () => {
  const provider = selectedProvider();
  if (!provider) return;
  testResult.hidden = false;
  testResult.dataset.kind = "pending";
  testResult.textContent = "正在测试…";
  try {
    const response = await chrome.runtime.sendMessage({ type: "TEST_TRANSLATION" });
    if (response?.ok) {
      testResult.dataset.kind = "ok";
      testResult.textContent = `测试成功：「おはよう」→「${response.translated}」`;
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
  const cfg = await chrome.storage.local.get([
    "debugMode", "backendUrl", "translationProvider", "translationMode",
    "translationEndpoint", "translationModel", "translationAppId",
      "translationModelProvider", "translationApiKey", "targetLanguage",
      "translationGlossary", "autoTranslate", "webAutoTranslate", "webDisplayMode", "videoDisplayMode", "hoverTranslate", "selectionTranslate", "inputAutoReplace", "autoConcurrency",
      "fontScale", "overlayOpacity", "translationStrength",
  ]);
  document.getElementById("translationStrength").value = String(registry.normalizeStrength(cfg.translationStrength));
  debugMode.checked = cfg.debugMode !== false;
  backendUrl.value = cfg.backendUrl || "";

  autoTranslate.checked = Boolean(cfg.autoTranslate);
  webAutoTranslate.checked = Boolean(cfg.webAutoTranslate);
  webDisplayMode.value = globalThis.MAS_webDisplayMode(cfg.webDisplayMode);
  videoDisplayMode.value = globalThis.MAS_webDisplayMode(cfg.videoDisplayMode);
  hoverTranslate.checked = Boolean(cfg.hoverTranslate);
  selectionPreference = cfg.selectionTranslate !== false;
  inputReplacePreference = cfg.inputAutoReplace !== false;
  autoConcurrency.value = String(Math.min(3, Math.max(1, cfg.autoConcurrency || 1)));
  fontScale.value = String(Math.round((cfg.fontScale ?? 1) * 100));
  overlayOpacity.value = String(Math.round((cfg.overlayOpacity ?? 1) * 100));
  syncSliderLabels();

  document.getElementById("version").textContent = chrome.runtime.getManifest().version;

  const providerId = registry.resolveProviderId(cfg);
  providerSelect.value = registry.byId(providerId) ? providerId : "none";

  translationEndpoint.value = cfg.translationEndpoint || "";
  savedModelOwner = cfg.translationModelProvider || "";
  // A model id chosen for a different source is not shown here: saving it as
  // this provider's model is exactly the cross-source leak resolveModel blocks.
  translationModel.value = savedModelOwner && savedModelOwner !== providerSelect.value
    ? ""
    : (cfg.translationModel || "");
  translationAppId.value = cfg.translationAppId || "";
  targetLanguage.value = cfg.targetLanguage || "";
  translationGlossary.value = registry.glossaryById?.(cfg.translationGlossary)?.id || "general";
  savedApiKeyExists = Boolean(cfg.translationApiKey);
  savedAppIdExists = Boolean(cfg.translationAppId);

  describeBackend();
  describeProvider();
}

backendUrl.addEventListener("input", describeBackend);

buildProviderOptions();
buildGlossaryOptions();
load();

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
