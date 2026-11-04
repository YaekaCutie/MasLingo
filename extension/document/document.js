(() => {
  const $ = id => document.getElementById(id);
  const registry = globalThis.MAS_providers;
  const sourceSelect = $("source");
  const targetSelect = $("target");
  const fileInput = $("file");
  const progress = $("progress");
  const translateButton = $("translate");
  const maxSize = 15 * 1024 * 1024;
  let controller = null;
  let cached = null;

  sourceSelect.append(new Option(registry.autoSource), ...registry.languages.map(language => new Option(language.name)));
  targetSelect.append(...registry.languages.map(language => new Option(language.name)));

  async function settings() {
    const cfg = await chrome.storage.local.get(["translationProvider", "translationMode", "targetLanguage"]);
    const base = (await globalThis.MAS_backendCandidates())[0];
    const url = new URL(base);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("后端地址无效");
    const provider = registry.byId(registry.resolveProviderId(cfg));
    if (!provider) throw new Error("请先在扩展设置中选择翻译来源");
    $("route").textContent = `文档交由 ${url.origin} 处理，待译文字发送给 ${provider.label}。`;
    return { base, provider, defaultTarget: cfg.targetLanguage || "简体中文" };
  }

  function status(message, error = false) {
    $("status").textContent = message;
    $("status").toggleAttribute("data-error", error);
  }

  async function requestDocument(base, path, file, signal, fields = {}) {
    const body = new FormData();
    body.append("file", file);
    for (const [key, value] of Object.entries(fields)) body.append(key, value);
    let response;
    try {
      response = await fetch(`${base}/api/document/${path}`, {
        method: "POST", body, signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]), redirect: "error",
      });
    } catch {
      signal.throwIfAborted();
      throw new Error("无法连接文档后端，请确认服务已开启");
    }
    if (!response.ok) {
      const error = await response.json().catch(() => null);
      if (response.status === 404) throw new Error("当前后端未提供文档翻译，请更新并重启后端");
      throw new Error(typeof error?.detail === "string" ? error.detail : `文档处理失败（${response.status}）`);
    }
    return response;
  }

  function download(blob, file, mode) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    const suffix = mode === "bilingual" ? "双语" : "译文";
    link.download = `${file.name.replace(/\.docx$/i, "")}-${suffix}.docx`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  async function run(file, signal) {
    const { base, provider } = await settings();
    const source = sourceSelect.value;
    const target = targetSelect.value;
    const mode = $("mode").value;
    const key = JSON.stringify([base, provider.id, source, target]);
    if (cached?.file !== file || cached.key !== key) {
      status("正在读取 Word 文档…");
      const response = await requestDocument(base, "text", file, signal);
      const { texts } = await response.json();
      if (!Array.isArray(texts) || !texts.length) throw new Error("没有找到可翻译的文字");
      cached = { file, key, texts, translations: new Map() };
    }
    const { texts, translations } = cached;
    const unique = [...new Set(texts)];
    const pending = unique.filter(text => !translations.has(text));
    const batchSize = provider.perRequest ? 1 : 2;
    progress.hidden = false;
    progress.max = unique.length;
    progress.value = translations.size;
    for (let i = 0; i < pending.length; i += batchSize) {
      signal.throwIfAborted();
      status(`正在翻译 ${translations.size} / ${unique.length}…`);
      const batch = pending.slice(i, i + batchSize);
      const result = await chrome.runtime.sendMessage({
        type: "TRANSLATE_TEXT_BLOCKS", texts: batch, source, target, provider: provider.id,
      });
      signal.throwIfAborted();
      if (!result?.ok) throw new Error(result?.reason || "翻译请求失败");
      const output = result.translations;
      if (!Array.isArray(output) || output.length !== batch.length || output.some(text => typeof text !== "string" || !text.trim())) {
        throw new Error("翻译服务返回的内容不完整，可重试剩余片段");
      }
      batch.forEach((text, index) => translations.set(text, output[index]));
      progress.value = translations.size;
    }
    status("正在生成 Word 文档…");
    const response = await requestDocument(base, "export", file, signal, {
      texts: JSON.stringify(texts.map(text => translations.get(text))), mode,
    });
    const blob = await response.blob();
    signal.throwIfAborted();
    if (!blob.size || !blob.type.includes("wordprocessingml.document")) throw new Error("后端未返回 Word 文件");
    download(blob, file, mode);
    status("翻译完成，已生成下载文件。");
  }

  $("form").onsubmit = async event => {
    event.preventDefault();
    if (controller) return;
    const file = fileInput.files[0];
    if (!file || !/\.docx$/i.test(file.name) || !file.size || file.size > maxSize) {
      status("请选择 15 MB 以内的 Word .docx 文档", true);
      return;
    }
    controller = new AbortController();
    $("fields").disabled = true;
    translateButton.disabled = true;
    $("cancel").hidden = false;
    progress.hidden = true;
    try { await run(file, controller.signal); }
    catch (error) {
      const { aborted, reason } = controller.signal;
      status(aborted ? (typeof reason === "string" ? reason : "已取消。再次开始可复用已完成的译文。") : error.message, !aborted);
    }
    finally {
      controller = null;
      $("fields").disabled = false;
      translateButton.disabled = false;
      $("cancel").hidden = true;
    }
  };
  $("cancel").onclick = () => controller?.abort();
  fileInput.onchange = () => { cached = null; progress.hidden = true; status("请选择输出方式后开始翻译。"); };
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !Object.keys(changes).some(key => key.startsWith("translation") || key === "backendUrl")) return;
    cached = null;
    controller?.abort("翻译设置已变更，请重新开始。");
  });
  settings().then(({ defaultTarget }) => {
    if (![...targetSelect.options].some(option => option.value === defaultTarget)) targetSelect.append(new Option(defaultTarget));
    targetSelect.value = defaultTarget;
  }).catch(error => status(error.message, true)).finally(() => { translateButton.disabled = false; });
})();
