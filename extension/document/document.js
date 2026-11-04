(() => {
  const $ = id => document.getElementById(id);
  const registry = globalThis.MAS_providers;
  const fileInput = $("file");
  const providerSelect = $("provider");
  const sourceSelect = $("source");
  const targetSelect = $("target");
  const glossarySelect = $("glossary");
  const progress = $("progress");
  const formats = new Set(fileInput.accept.split(","));
  const legacy = new Set([".doc", ".xls", ".ppt", ".rtf"]);
  const maxSize = 15 * 1024 * 1024;
  const pageSize = 5;
  let config = null;
  let settingsVersion = 0;
  let file = null;
  let active = null;
  let job = null;
  let previewPage = 0;

  providerSelect.append(new Option("跟随扩展设置", ""));
  const languageOptions = () => registry.languages.map(language => new Option(language.name));
  sourceSelect.append(new Option(registry.autoSource), ...languageOptions());
  targetSelect.append(new Option("跟随扩展设置", ""), ...languageOptions());
  glossarySelect.append(new Option("跟随扩展设置", ""),
    ...registry.glossaries.map(glossary => new Option(glossary.label, glossary.id)));
  const suffix = selected => /\.[^.]+$/.exec(selected?.name || "")?.[0].toLowerCase() || "";
  const selectedProvider = () => registry.byId(providerSelect.value || config?.provider);
  const selectedTarget = () => targetSelect.value || config?.target || "简体中文";
  const complete = () => Boolean(job?.unique.length && job.translations.size === job.unique.length);

  function status(message, error = false, id = "status") {
    $(id).textContent = message;
    $(id).toggleAttribute("data-error", error);
  }

  function syncControls() {
    const provider = selectedProvider();
    const issue = config ? config.issues.get(provider?.id) || (!provider ? "翻译已关闭" : "") : "";
    const usable = provider && !issue;
    const ai = registry.isChatProvider(provider);
    $("fields").disabled = Boolean(active);
    $("cancel").hidden = !active;
    $("translate").disabled = Boolean(active || !file || !config || !usable);
    $("translate").textContent = complete() ? "重新翻译" : job?.translations.size ? "继续翻译" : "开始翻译";
    $("swap").disabled = sourceSelect.value === registry.autoSource || !registry.languageByName(selectedTarget());
    glossarySelect.disabled = !ai;
    $("glossary-note").hidden = ai;
    for (const id of ["download-bilingual", "download-translated", "copy"]) $(id).disabled = Boolean(active || !complete());
    $("route").textContent = config ? (usable
      ? `文件由 ${config.origin} 处理，待译文字发送给 ${provider.label}。`
      : `${issue}。请选择其他来源，或前往扩展设置配置服务。`) : "";
    $("provider-note").textContent = provider?.note || "";
    $("provider-note").hidden = !provider?.note;
  }

  async function refreshSettings() {
    const version = ++settingsVersion;
    try {
      const [cfg, backends] = await Promise.all([
        chrome.storage.local.get([
          ...registry.profileKeys, "targetLanguage", "translationGlossary",
          ...registry.list.map(provider => registry.profileKey(provider.id)),
        ]),
        globalThis.MAS_backendCandidates(),
      ]);
      if (version !== settingsVersion) return;
      const url = new URL(backends[0]);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("后端地址无效");
      const issues = new Map(registry.list.map(provider => [
        provider.id, registry.configurationIssue(provider, registry.providerSettings(cfg, provider.id)),
      ]));
      config = {
        base: backends[0], origin: url.origin, provider: registry.resolveProviderId(cfg),
        target: cfg.targetLanguage || "简体中文", glossary: cfg.translationGlossary || "general", issues,
      };
      const override = providerSelect.value;
      providerSelect.replaceChildren(new Option("跟随扩展设置", ""));
      registry.appendProviderOptions(providerSelect, {
        include: provider => Boolean(provider.adapter), issues,
      });
      if (override && !issues.get(override)) providerSelect.value = override;
      providerSelect.options[0].textContent = `跟随扩展设置（${registry.byId(config.provider)?.label || "未配置"}）`;
      targetSelect.options[0].textContent = `跟随（${config.target}）`;
      glossarySelect.options[0].textContent = `跟随扩展设置（${registry.glossaryById(config.glossary)?.label || "通用"}）`;
    } catch (error) {
      if (version !== settingsVersion) return;
      config = null;
      status(error.message, true);
    }
    syncControls();
  }

  function previewCell(label, value) {
    const cell = document.createElement("div");
    const heading = document.createElement("span");
    heading.textContent = label;
    const text = document.createElement("p");
    text.textContent = value;
    cell.append(heading, text);
    return cell;
  }

  function renderPreview() {
    const texts = job?.texts || [];
    const list = $("preview-list");
    const pages = Math.ceil(texts.length / pageSize);
    const start = previewPage * pageSize;
    list.replaceChildren();
    for (const [index, text] of texts.slice(start, start + pageSize).entries()) {
      const row = document.createElement("li");
      row.className = "preview-row";
      row.append(previewCell(`原文 ${start + index + 1}`, text),
        previewCell("译文", job.translations.get(text) || "待翻译"));
      list.append(row);
    }
    list.hidden = !texts.length;
    $("preview-empty").hidden = Boolean(texts.length);
    $("pager").hidden = pages < 2;
    $("previous").disabled = previewPage === 0;
    $("next").disabled = previewPage + 1 >= pages;
    $("page-number").textContent = pages ? `${previewPage + 1} / ${pages}` : "";
  }

  function resetResults() {
    job = null;
    previewPage = 0;
    progress.hidden = true;
    status("", false, "result-status");
    renderPreview();
    syncControls();
  }

  function selectFile(selected) {
    if (active) return;
    const extension = suffix(selected);
    if (selected && (!formats.has(extension) || !selected.size || selected.size > maxSize)) {
      status("请选择格式列表中 15 MB 以内的非空文件。", true);
      return;
    }
    file = selected;
    $("file-name").textContent = file?.name || "拖入文档或选择文件";
    $("file-meta").textContent = file
      ? `${extension.slice(1).toUpperCase()} · ${Math.ceil(file.size / 1024).toLocaleString()} KB`
      : "一次一个文件，最大 15 MB";
    $("choose").textContent = file ? "更换文件" : "选择文件";
    $("clear").hidden = !file;
    const note = $("format-note");
    note.textContent = extension === ".pdf" ? "双语 PDF 在原页后附译文页，纯译文 PDF 会重排文字。扫描页需启用 OCR。" :
      legacy.has(extension) ? "旧版格式需要后端安装 LibreOffice。转换可能改变分页或排版。" :
      extension ? "按原格式导出。译文长度变化可能影响换行或版面。" : "";
    note.hidden = !note.textContent;
    resetResults();
    status(file ? "确认翻译设置后点击「开始翻译」。" : "请选择要翻译的文件。");
  }

  async function requestDocument(base, path, selected, signal, fields = {}) {
    const body = new FormData();
    body.append("file", selected);
    for (const [key, value] of Object.entries(fields)) body.append(key, value);
    let response;
    try {
      response = await fetch(`${base}/api/document/${path}`, {
        method: "POST", body, signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]), redirect: "error",
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

  function download(blob, selected, mode) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    const label = mode === "bilingual" ? "双语" : "译文";
    const extension = /\.[^.]+$/.exec(selected.name)[0];
    link.download = `${selected.name.slice(0, -extension.length)}-${label}${extension}`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  async function translate(signal) {
    const provider = selectedProvider();
    const source = sourceSelect.value;
    const target = selectedTarget();
    const glossary = registry.isChatProvider(provider) ? glossarySelect.value || config.glossary : "";
    const base = config.base;
    if (!job) {
      status("正在读取文件…");
      const response = await requestDocument(base, "text", file, signal);
      const { texts } = await response.json();
      signal.throwIfAborted();
      if (!Array.isArray(texts) || !texts.length || texts.some(text => typeof text !== "string" || !text.trim())) {
        throw new Error("没有找到可翻译的文字");
      }
      job = { file, base, texts, unique: [...new Set(texts)], translations: new Map() };
      renderPreview();
    }
    const { unique, translations } = job;
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
        type: "TRANSLATE_TEXT_BLOCKS", texts: batch, source, target, provider: provider.id, glossary,
      });
      signal.throwIfAborted();
      if (!result?.ok) throw new Error(result?.reason || "翻译请求失败");
      const output = result.translations;
      if (!Array.isArray(output) || output.length !== batch.length || output.some(text => typeof text !== "string" || !text.trim())) {
        throw new Error("翻译服务返回的内容不完整，可继续翻译剩余片段");
      }
      batch.forEach((text, index) => translations.set(text, output[index]));
      progress.value = translations.size;
      renderPreview();
    }
    status(`翻译完成，共 ${job.texts.length} 个片段。请选择下载方式。`);
  }

  async function exportDocument(mode, signal) {
    const { base, file: selected, texts, translations } = job;
    status("正在生成导出文件…", false, "result-status");
    const response = await requestDocument(base, "export", selected, signal, {
      texts: JSON.stringify(texts.map(text => translations.get(text))), mode,
    });
    const blob = await response.blob();
    signal.throwIfAborted();
    if (!blob.size || blob.type.includes("application/json")) throw new Error("后端未返回有效的文件");
    download(blob, selected, mode);
    status("已生成下载文件。", false, "result-status");
  }

  async function operate(action, destination) {
    if (active) return;
    active = new AbortController();
    syncControls();
    try { await action(active.signal); }
    catch (error) {
      const { aborted, reason } = active.signal;
      status(aborted ? (typeof reason === "string" ? reason : "已取消。") : error.message, !aborted, destination);
    } finally {
      active = null;
      syncControls();
    }
  }

  $("form").onsubmit = event => {
    event.preventDefault();
    if ($("translate").disabled) return;
    if (complete()) resetTranslations();
    operate(translate, "status");
  };
  $("cancel").onclick = () => active?.abort(job?.translations.size && !complete()
    ? "已取消。可继续翻译剩余片段。" : "已取消。");
  for (const mode of ["bilingual", "translated"]) {
    $(`download-${mode}`).onclick = () => {
      if (complete()) operate(signal => exportDocument(mode, signal), "result-status");
    };
  }
  $("copy").onclick = async () => {
    if (!complete()) return;
    try {
      await navigator.clipboard.writeText(job.texts.map(text => job.translations.get(text)).join("\n\n"));
      status("已复制纯译文。", false, "result-status");
    } catch { status("无法写入剪贴板，可从预览中选择文字。", true, "result-status"); }
  };
  $("previous").onclick = () => { previewPage--; renderPreview(); };
  $("next").onclick = () => { previewPage++; renderPreview(); };

  function resetTranslations() {
    if (!job) return;
    job.translations.clear();
    progress.hidden = true;
    status("", false, "result-status");
    renderPreview();
  }

  function optionsChanged() {
    if (job) status("翻译设置已更新，可重新开始翻译。");
    resetTranslations();
    syncControls();
  }
  for (const control of [providerSelect, sourceSelect, targetSelect, glossarySelect]) control.onchange = optionsChanged;
  $("swap").onclick = () => {
    const source = sourceSelect.value;
    sourceSelect.value = selectedTarget();
    targetSelect.value = source;
    optionsChanged();
  };

  $("choose").onclick = () => fileInput.click();
  $("clear").onclick = () => selectFile(null);
  fileInput.onchange = () => {
    if (fileInput.files[0]) selectFile(fileInput.files[0]);
    fileInput.value = "";
  };
  document.addEventListener("dragover", event => {
    if (!event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    $("drop").toggleAttribute("data-dragging", !active && $("drop").contains(event.target));
  });
  document.addEventListener("dragleave", event => {
    if (!$("drop").contains(event.relatedTarget)) $("drop").removeAttribute("data-dragging");
  });
  document.addEventListener("drop", event => {
    if (!event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    $("drop").removeAttribute("data-dragging");
    if (active || !$("drop").contains(event.target)) return;
    if (event.dataTransfer.files.length === 1) selectFile(event.dataTransfer.files[0]);
    else status("请一次拖入一个文件。", true);
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !Object.keys(changes).some(key => key.startsWith("translation") || key === "backendUrl" || key === "targetLanguage")) return;
    if (active) active.abort("扩展翻译设置已变更，请重新开始。");
    else if (job) status("扩展翻译设置已变更，可重新开始翻译。");
    config = null;
    resetResults();
    refreshSettings();
  });
  refreshSettings();
})();
