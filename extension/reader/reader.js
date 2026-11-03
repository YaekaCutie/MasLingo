(() => {
  const $ = (id) => document.getElementById(id),
    registry = globalThis.MAS_providers;
  let tabId = null,
    windowId = null,
    port = null,
    version = 0,
    lastState = null;
  const controls = [
    "webAutoTranslate",
    "hoverTranslate",
    "autoTranslate",
    "selectionTranslate",
  ];
  function report(text) {
    $("activity").textContent = text;
  }
  function action(row, action, extra = {}) {
    port?.postMessage({ type: "action", key: row.key, action, ...extra });
  }
  function treeNode(data, row) {
    if (typeof data.text === "string")
      return document.createTextNode(data.text);
    const allowed = [
      "div",
      "p",
      "span",
      "strong",
      "b",
      "em",
      "i",
      "small",
      "br",
      "button",
      "select",
      "option",
      "ol",
      "ul",
      "li",
    ];
    const node = document.createElement(
      allowed.includes(data.tag) ? data.tag : "div",
    );
    node.className = typeof data.class === "string" ? data.class : "";
    if (data.control) node.dataset.control = data.control;
    if (data.state) node.dataset.state = data.state;
    if (data.label) node.setAttribute("aria-label", data.label);
    if (data.disabled) node.disabled = true;
    if (data.tag === "option") node.value = String(data.value || "");
    for (const child of data.children || []) node.append(treeNode(child, row));
    if (data.tag === "select") {
      node.value = data.value;
      node.addEventListener("change", () =>
        action(row, "control", { control: data.control, value: node.value }),
      );
    }
    if (data.tag === "button") {
      node.type = "button";
      node.addEventListener("click", () =>
        action(row, "control", { control: data.control }),
      );
    }
    return node;
  }
  function button(label, fn) {
    const b = document.createElement("button");
    b.textContent = label;
    b.type = "button";
    b.onclick = fn;
    return b;
  }
  function render(state) {
    if (state.tabId !== tabId) return;
    lastState = state;
    const root = $("results"),
      keys = new Set(state.rows.map((r) => r.key));
    for (const child of [...root.children])
      if (!keys.has(child.dataset.key)) child.remove();
    for (const row of [...state.rows].reverse()) {
      let card = [...root.children].find((e) => e.dataset.key === row.key);
      const signature = JSON.stringify(row);
      if (card?.dataset.signature === signature) continue;
      const focused = card?.contains(document.activeElement)
        ? document.activeElement
        : null;
      const control = focused?.dataset.control;
      const focusLabel = focused?.textContent;
      const sourceOpen = card?.querySelector("details")?.open;
      const next = document.createElement("article");
      next.className = "result";
      next.dataset.key = row.key;
      next.dataset.signature = signature;
      const head = document.createElement("div");
      head.className = "result-bar";
      const label = document.createElement("span");
      label.className = "result-kind";
      label.textContent = row.kind;
      const close = button("关闭", () => action(row, "dismiss"));
      close.className = "link";
      head.append(label, close);
      next.append(head);
      if (row.source) {
        const d = document.createElement("details"),
          s = document.createElement("summary"),
          p = document.createElement("p");
        s.textContent = "查看原文";
        p.textContent = row.source;
        d.open = !!sourceOpen;
        d.append(s, p);
        next.append(d);
      }
      const content = document.createElement("div");
      content.className = "result-content";
      for (const item of row.tree) content.append(treeNode(item, row));
      next.append(content);
      const actions = document.createElement("div");
      actions.className = "result-actions";
      actions.append(
        button("定位原文", () => action(row, "focus")),
        button("复制", async () => {
          try {
            await navigator.clipboard.writeText(
              [...content.querySelectorAll(".text,.translation,.meaning")]
                .map((e) => e.textContent)
                .join("\n") || content.textContent,
            );
            report("译文已复制");
          } catch {
            report("复制失败，请选中译文手动复制");
          }
        }),
      );
      next.append(actions);
      if (card) card.replaceWith(next);
      else root.append(next);
      if (focused) {
        const restore = [
          ...next.querySelectorAll("button,select,summary"),
        ].find((e) =>
          control
            ? e.dataset.control === control
            : e.textContent === focusLabel,
        );
        restore?.focus({ preventScroll: true });
      }
    }
    // Show the newest source first without moving a control under the keyboard.
    if (!root.contains(document.activeElement))
      for (const row of [...state.rows].reverse()) {
        const card = [...root.children].find((e) => e.dataset.key === row.key);
        if (card) root.append(card);
      }
    $("empty").hidden = state.rows.length > 0;
    $("clear").hidden = !state.rows.length;
    if (state.status) report(state.status);
  }
  $("results").addEventListener("focusout", () =>
    setTimeout(() => {
      if (lastState) render(lastState);
    }, 50),
  );
  document.addEventListener("keydown", (event) => {
    const card = event.target.closest?.(".result");
    if (event.key !== "Escape" || !card || event.target.tagName === "SELECT")
      return;
    const row = lastState?.rows.find((row) => row.key === card.dataset.key);
    if (row) {
      action(row, "dismiss");
      $("read-tab").focus();
    }
  });
  async function active() {
    const id = ++version;
    const tabs = await chrome.tabs.query({ active: true, windowId });
    if (id !== version) return;
    tabId = tabs[0]?.id ?? null;
    $("results").replaceChildren();
    $("empty").hidden = false;
    $("clear").hidden = true;
    report("准备就绪");
    lastState = null;
    if (tabId !== null) port?.postMessage({ type: "subscribe", tabId });
  }
  function connect() {
    port = chrome.runtime.connect({ name: "maslingo-reader" });
    port.onMessage.addListener(render);
    port.onDisconnect.addListener(() => {
      port = null;
      setTimeout(connect, 1000);
    });
    if (windowId !== null) active().catch(() => {});
  }
  async function load() {
    const cfg = await chrome.storage.local.get([
      ...controls,
      "webDisplayMode",
      "translationProvider",
      "translationMode",
      "targetLanguage",
      "translationGlossary",
    ]);
    for (const key of controls)
      $(key).checked =
        key === "selectionTranslate" ? cfg[key] !== false : !!cfg[key];
    $("webDisplayMode").value = globalThis.MAS_webDisplayMode(
      cfg.webDisplayMode,
    );
    const provider = registry.byId(registry.resolveProviderId(cfg));
    $("translationProvider").value = provider?.id || "none";
    $("targetLanguage").value = cfg.targetLanguage || "简体中文";
    $("translationGlossary").value = cfg.translationGlossary || "general";
    $("selectionTranslate").disabled = !registry.isChatProvider(provider);
    $("selectionTranslate").title = registry.isChatProvider(provider)
      ? "选词查释义，选句看译文"
      : "划词词典需要 AI 翻译来源";
    $("translationGlossary").disabled = !registry.isChatProvider(provider);
    $("provider-label").textContent =
      `${provider?.label || "请选择翻译来源"} · ${cfg.targetLanguage || "简体中文"}`;
    $("provider-hint").textContent =
      provider?.id === "none"
        ? "先在设置中选择翻译来源。"
        : "悬停和划词结果显示在此侧栏。";
  }
  for (const p of registry.list)
    $("translationProvider").append(new Option(p.label, p.id));
  for (const l of registry.languages)
    $("targetLanguage").append(new Option(l.name, l.name));
  for (const g of registry.glossaries)
    $("translationGlossary").append(new Option(g.label, g.id));
  for (const key of [
    ...controls,
    "webDisplayMode",
    "translationProvider",
    "targetLanguage",
    "translationGlossary",
  ])
    $(key).addEventListener("change", async () => {
      try {
        const value = controls.includes(key) ? $(key).checked : $(key).value;
        const update = { [key]: value };
        if (key === "translationProvider")
          update.translationMode =
            value === "none"
              ? "none"
              : ["backend", "google-free"].includes(value)
                ? "free-translate"
                : "openai-compatible";
        await chrome.storage.local.set(update);
        report("偏好已保存");
      } catch {
        report("保存失败，请重试");
      }
    });
  for (const name of ["read", "setup"])
    $(name + "-tab").onclick = () => {
      for (const key of ["read", "setup"]) {
        $(key + "-tab").setAttribute("aria-pressed", String(key === name));
        $(key + "-view").hidden = key !== name;
      }
    };
  $("settings").onclick = () => chrome.runtime.openOptionsPage();
  $("select").onclick = async () => {
    try {
      await chrome.tabs.sendMessage(
        tabId,
        { type: "START_SELECT" },
        { frameId: 0 },
      );
      report("请在网页中拖出要翻译的区域，Esc 取消");
    } catch {
      report("此页面不可框选；更新扩展后请刷新网页");
    }
  };
  $("video").onclick = async () => {
    try {
      const r = await chrome.tabs.sendMessage(
        tabId,
        { type: "READER_VIDEO" },
        { frameId: 0 },
      );
      report(r?.ok ? "已定位视频，下方可开启字幕翻译" : "当前页面未发现视频");
    } catch {
      report("请刷新网页后重试");
    }
  };
  $("clear").onclick = () => port?.postMessage({ type: "clear" });
  $("health").onclick = async () => {
    report("正在检查识别服务…");
    try {
      const r = await chrome.runtime.sendMessage({ type: "CHECK_BACKEND" });
      report(
        r?.ok ? "识别服务已连接" : r?.reason || r?.error || "识别服务未连接",
      );
    } catch (e) {
      report(e.message);
    }
  };
  chrome.storage.onChanged.addListener((_changes, area) => {
    if (area === "local") load().catch(() => {});
  });
  chrome.tabs.onActivated.addListener((info) => {
    if (info.windowId === windowId) active().catch(() => {});
  });
  chrome.windows.getCurrent().then((w) => {
    windowId = w.id;
    connect();
  });
  load().catch(() => report("无法读取设置，请重新打开侧栏"));
})();
