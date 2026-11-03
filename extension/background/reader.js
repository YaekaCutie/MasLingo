// Bounded, transient per-tab results. Never persist selected page text to disk.
(() => {
  const tabs = new Map();
  const ports = new Set();
  const trusted = (sender) =>
    !sender.tab && sender.url?.startsWith(chrome.runtime.getURL(""));
  const stateFor = (id) => {
    if (!tabs.has(id)) {
      if (tabs.size >= 20) tabs.delete(tabs.keys().next().value);
      tabs.set(id, { frames: new Map(), rows: new Map(), status: "" });
    }
    return tabs.get(id);
  };
  const snapshot = (id) => {
    const state = tabs.get(id);
    return {
      type: "READER_STATE",
      tabId: id,
      rows: state ? [...state.rows.values()] : [],
      status: state?.status || "",
    };
  };
  const notify = (id) => {
    const reading = [...ports].some((port) => port.tabId === id);
    const count = tabs.get(id)?.rows.size || 0;
    chrome.action
      ?.setBadgeText({
        tabId: id,
        text: reading || !count ? "" : String(count),
      })
      ?.catch(() => {});
    chrome.action
      ?.setBadgeBackgroundColor({ tabId: id, color: "#285de5" })
      ?.catch(() => {});
    for (const port of ports)
      if (port.tabId === id)
        try {
          port.postMessage(snapshot(id));
        } catch {}
  };
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (!message?.type?.startsWith("READER_") || sender.tab?.id === undefined)
      return;
    const tabId = sender.tab.id,
      frameId = sender.frameId || 0,
      state = stateFor(tabId);
    if (message.type === "READER_REGISTER") {
      const prior = state.frames.get(frameId);
      state.frames.set(frameId, message.document);
      if (prior !== message.document)
        for (const [key, row] of state.rows)
          if (row.frameId === frameId) state.rows.delete(key);
    } else if (state.frames.get(frameId) !== message.document) {
      reply({ ok: false });
      return;
    }
    const key = `${frameId}:${message.id}`;
    if (
      message.type === "READER_RESULT" &&
      Array.isArray(message.tree) &&
      JSON.stringify(message.tree).length < 100000
    ) {
      state.rows.set(key, {
        key,
        id: message.id,
        frameId,
        document: message.document,
        kind: String(message.kind).slice(0, 60),
        source: String(message.source || "").slice(0, 12000),
        tree: message.tree,
      });
      while (state.rows.size > 30)
        state.rows.delete(state.rows.keys().next().value);
    }
    if (message.type === "READER_REMOVE") state.rows.delete(key);
    if (message.type === "READER_STATUS")
      state.status = String(message.text || "").slice(0, 1000);
    notify(tabId);
    reply({ ok: true });
  });
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== "maslingo-reader" || !trusted(port.sender)) return;
    ports.add(port);
    port.onDisconnect.addListener(() => {
      ports.delete(port);
      if (Number.isInteger(port.tabId)) notify(port.tabId);
    });
    port.onMessage.addListener(async (message) => {
      if (message.type === "subscribe" && Number.isInteger(message.tabId)) {
        const subscription = (port.subscription = (port.subscription || 0) + 1);
        try {
          await chrome.tabs.get(message.tabId);
        } catch {
          return;
        }
        if (subscription !== port.subscription) return;
        port.tabId = message.tabId;
        notify(port.tabId);
        chrome.tabs
          .sendMessage(port.tabId, { type: "READER_REFRESH" })
          .catch(() => {});
      } else if (message.type === "action") {
        const row = tabs.get(port.tabId)?.rows.get(message.key);
        if (!row) return;
        try {
          await chrome.tabs.sendMessage(
            port.tabId,
            {
              type: "READER_ACTION",
              document: row.document,
              id: row.id,
              action: message.action,
              control: message.control,
              value: message.value,
            },
            { frameId: row.frameId },
          );
        } catch {
          tabs.get(port.tabId)?.rows.delete(message.key);
          notify(port.tabId);
        }
      } else if (message.type === "clear") {
        const state = tabs.get(port.tabId);
        if (!state) return;
        for (const row of state.rows.values())
          chrome.tabs
            .sendMessage(
              port.tabId,
              {
                type: "READER_ACTION",
                document: row.document,
                id: row.id,
                action: "dismiss",
              },
              { frameId: row.frameId },
            )
            .catch(() => {});
        state.rows.clear();
        notify(port.tabId);
      }
    });
  });
  chrome.tabs.onRemoved.addListener((id) => tabs.delete(id));
  chrome.tabs.onUpdated.addListener((id, change) => {
    if (change.status === "loading") {
      tabs.delete(id);
      notify(id);
    }
  });
})();
