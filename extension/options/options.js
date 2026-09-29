const debugMode = document.getElementById("debugMode");
const result = document.getElementById("result");

async function load() {
  const cfg = await chrome.storage.local.get(["debugMode"]);
  debugMode.checked = cfg.debugMode !== false;
}

debugMode.addEventListener("change", async () => {
  await chrome.storage.local.set({ debugMode: debugMode.checked });
  result.textContent = debugMode.checked ? "调试模式已开启。" : "调试模式已关闭。";
});

document.getElementById("save").onclick = async () => {
  await chrome.storage.local.set({debugMode: debugMode.checked});
  result.textContent="已保存 MangaOCR 设置。";
};

load();