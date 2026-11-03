// Presentation bridge: source nodes and callbacks stay in their document.
(() => {
  if (globalThis.MAS_reader) return;
  const token = Array.from(crypto.getRandomValues(new Uint32Array(4)), (n) =>
    n.toString(16),
  ).join("-");
  const entries = new Map();
  let sequence = 0;
  const send = (message) =>
    chrome.runtime.sendMessage({ ...message, document: token }).catch(() => {});
  let ready = send({ type: "READER_REGISTER" });
  const post = (message) => ready.then(() => send(message));
  function focus(element) {
    if (!element?.isConnected) return;
    element.scrollIntoView({
      block: "center",
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "instant"
        : "smooth",
    });
    if (!matchMedia("(prefers-reduced-motion: reduce)").matches)
      element.animate?.(
        [
          { outline: "2px solid #285de5", outlineOffset: "3px" },
          { outline: "2px solid transparent", outlineOffset: "3px" },
        ],
        { duration: 1200 },
      );
  }
  function remove(id) {
    const entry = entries.get(id);
    if (!entry) return;
    delete entry.host.dataset.readerId;
    entry.observer?.disconnect();
    clearTimeout(entry.timer);
    entries.delete(id);
    post({ type: "READER_REMOVE", id });
  }
  function mount(host, options = {}) {
    if (host.dataset.readerId) return host.dataset.readerId;
    const id = `result-${++sequence}`;
    host.dataset.readerId = id;
    if (options.hideHost !== false) host.style.setProperty("display", "none", "important");
    const entry = {
      host,
      options,
      controls: new Map(),
      ids: new WeakMap(),
      count: 0,
    };
    entries.set(id, entry);
    const snapshot = () => {
      let budget = 1600;
      entry.controls.clear();
      function walk(node) {
        if (--budget < 0) return null;
        if (node.nodeType === Node.TEXT_NODE)
          return { text: node.textContent.slice(0, 12000) };
        if (
          !(node instanceof Element) ||
          node.hidden ||
          node.matches(
            "style,script,svg,canvas,.min,.mini,.pin,.toggle[aria-expanded],.cover,.origin",
          )
        )
          return null;
        const allowed = [
          "DIV",
          "P",
          "SPAN",
          "STRONG",
          "B",
          "EM",
          "I",
          "SMALL",
          "BR",
          "BUTTON",
          "SELECT",
          "OPTION",
          "OL",
          "UL",
          "LI",
        ];
        const data = {
          tag: allowed.includes(node.tagName)
            ? node.tagName.toLowerCase()
            : "div",
          class: node.className,
          state: node.dataset.state,
          children: [...node.childNodes].map(walk).filter(Boolean),
        };
        if (node.matches("button,select")) {
          let control = entry.ids.get(node);
          if (!control) {
            control = String(++entry.count);
            entry.ids.set(node, control);
          }
          entry.controls.set(control, node);
          data.control = control;
          data.disabled = node.disabled;
          data.label = node.getAttribute("aria-label") || node.title;
          if (node.tagName === "SELECT") data.value = node.value;
        }
        if (node.tagName === "OPTION") data.value = node.value;
        return data;
      }
      return [...(host.shadowRoot || host).childNodes]
        .map(walk)
        .filter(Boolean);
    };
    entry.publish = () => {
      if (!host.isConnected) {
        remove(id);
        return;
      }
      const tree = snapshot();
      const payload = {
        type: "READER_RESULT",
        id,
        kind: options.kind || "网页段落",
        source: String(
          typeof options.source === "function"
            ? options.source()
            : options.source || "",
        ).slice(0, 12000),
        tree,
      };
      if (JSON.stringify(payload).length < 100000) post(payload);
    };
    entry.observer = new MutationObserver(() => {
      clearTimeout(entry.timer);
      entry.timer = setTimeout(entry.publish, 90);
    });
    entry.observer.observe(host.shadowRoot || host, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });
    entry.publish();
    return id;
  }
  chrome.runtime.onMessage.addListener((message, _sender, reply) => {
    if (message.type === "READER_REFRESH") {
      ready = send({ type: "READER_REGISTER" });
      for (const e of entries.values()) e.publish();
      reply({ ok: true });
    }
    if (message.type !== "READER_ACTION" || message.document !== token) return;
    const entry = entries.get(message.id);
    if (!entry) {
      reply({ ok: false });
      return;
    }
    if (message.action === "focus")
      (entry.options.focus || (() => focus(entry.options.element)))();
    else if (message.action === "dismiss") {
      entry.options.dismiss?.();
      remove(message.id);
    } else if (message.action === "control") {
      const node = entry.controls.get(message.control);
      if (
        node &&
        !node.disabled &&
        (entry.host.shadowRoot || entry.host).contains(node)
      ) {
        if (
          node.tagName === "SELECT" &&
          [...node.options].some((o) => o.value === message.value)
        ) {
          node.value = message.value;
          node.dispatchEvent(new Event("change", { bubbles: true }));
        } else if (node.tagName === "BUTTON") {
          node.click();
          if (node.classList.contains("close")) remove(message.id);
        }
      }
    }
    if (entries.has(message.id)) entry.publish();
    reply({ ok: true });
  });
  window.addEventListener("pagehide", () => {
    for (const id of [...entries.keys()]) remove(id);
  });
  globalThis.MAS_reader = {
    mount,
    remove,
    focus,
    refresh(id) {
      entries.get(id)?.publish();
    },
    status(text, kind = "info") {
      post({ type: "READER_STATUS", text: String(text).slice(0, 1000), kind });
    },
  };
})();
