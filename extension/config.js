// Shared backend configuration for the service worker and the popup.
//
// MAS_BACKEND_URL is the shared backend that every user talks to after
// installing the extension, so nobody has to install Python and torch.
// It is filled in by the deployment step described in deploy/README.md.
//
// Leave it as an empty string to keep the extension local-only: it then talks
// to a backend the user runs on their own machine.

globalThis.MAS_BACKEND_URL = "";

// Tried after the configured and hosted backends. These let anyone run the
// backend locally without touching the extension at all.
globalThis.MAS_LOCAL_BACKENDS = ["http://127.0.0.1:8001", "http://localhost:8001"];

// Returns the ordered, de-duplicated list of backends to try: what the user
// typed in the options page first, then the hosted backend, then localhost.
globalThis.MAS_backendCandidates = async function () {
  let stored = "";
  try {
    stored = (await chrome.storage.local.get(["backendUrl"])).backendUrl || "";
  } catch (error) {
    console.warn("无法读取后端设置：", error.message);
  }
  const configured = String(stored).trim().replace(/\/+$/, "");
  return [configured, globalThis.MAS_BACKEND_URL, ...globalThis.MAS_LOCAL_BACKENDS]
    .map(url => String(url || "").trim().replace(/\/+$/, ""))
    .filter((url, index, all) => url && all.indexOf(url) === index);
};

globalThis.MAS_backendLabel = function () {
  return globalThis.MAS_BACKEND_URL || "";
};
