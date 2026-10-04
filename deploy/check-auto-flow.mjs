// What actually happens when the user clicks "自动识别整页气泡"?
//
// That button takes a different path from box-selection: the content script
// finds the page's main image, asks the service worker to capture and detect
// the whole page, and the service worker refuses if it cannot identify a
// plausible manga image. This drives that path on a real manga page and reports
// everything the user would see — busy indicator, toast, or nothing at all.
//
//   node deploy/check-auto-flow.mjs

import http from "node:http";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import puppeteer from "puppeteer";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const imagePath = ["Image from URL 2", "Image from URL"]
  .map((name) => resolve(repoRoot, name))
  .find((path) => existsSync(path));
if (!imagePath) {
  console.error("需要一张真实漫画页（Image from URL / Image from URL 2）放在仓库根目录");
  process.exit(2);
}
const image = readFileSync(imagePath);
console.log(`测试图: ${imagePath.split(/[\\/]/).pop()} (${Math.round(image.length / 1024)} KB)`);

// See deploy/check-region-flow.mjs: captureVisibleTab needs <all_urls> in
// host_permissions or a granted activeTab, and a headless driver cannot click
// the extension action. The permission is unrelated to what is under test.
const workDir = mkdtempSync(join(tmpdir(), "omt-auto-flow-"));
const extensionDir = join(workDir, "extension");
cpSync(join(repoRoot, "extension"), extensionDir, { recursive: true });
const manifestPath = join(extensionDir, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
manifest.host_permissions = [...(manifest.host_permissions || []), "<all_urls>"];
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

const server = http.createServer((request, response) => {
  if (request.url === "/manga.png") {
    response.writeHead(200, { "Content-Type": "image/png", "Content-Length": image.length });
    response.end(image);
    return;
  }
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>manga</title>
    <style>body{margin:0;background:#222}#view{width:760px;margin:0 auto}
    img{display:block;width:760px;height:auto}</style></head>
    <body><div id="view"><img id="manga" src="/manga.png"></div></body></html>`);
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const pageUrl = `http://127.0.0.1:${server.address().port}/`;

const browser = await puppeteer.launch({
  headless: true,
  args: [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-features=DisableLoadExtensionCommandLineSwitch",
    `--disable-extensions-except=${extensionDir}`,
    `--load-extension=${extensionDir}`,
  ],
});

try {
  const target = await browser.waitForTarget(
    (t) => t.type() === "service_worker" && t.url().includes("service-worker.js"),
    { timeout: 30000 },
  );
  const worker = await target.worker();

  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 900 });
  const tabErrors = [];
  page.on("pageerror", (error) => tabErrors.push(String(error)));
  await page.goto(pageUrl, { waitUntil: "load" });
  await page.waitForSelector("#manga");

  const tabId = await worker.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    return tabs.find((candidate) => candidate.url === url)?.id ?? null;
  }, pageUrl);
  console.log(`tab id : ${tabId}`);

  // What the content script thinks the main image is — this is the input to the
  // service worker's "is this really a manga page?" test. The content script
  // runs in an isolated world, so its own function is not reachable from here;
  // this mirrors findPrimaryMediaRect's filters exactly.
  const media = await page.evaluate(() => {
    const viewportArea = window.innerWidth * window.innerHeight;
    const minimumArea = viewportArea * 0.08;
    const candidates = [];
    const consider = (element, isMediaElement) => {
      const bounds = element.getBoundingClientRect();
      const left = Math.max(0, bounds.left);
      const top = Math.max(0, bounds.top);
      const right = Math.min(window.innerWidth, bounds.right);
      const bottom = Math.min(window.innerHeight, bounds.bottom);
      const width = Math.max(0, right - left);
      const height = Math.max(0, bottom - top);
      if (width < 180 || height < 180) return;
      if (width * height < minimumArea) return;
      // Mirrors the extension: no upper bound, because a full-size manga page
      // filling the viewport is the normal case.
      candidates.push({ width, height, isMediaElement });
    };
    for (const element of document.querySelectorAll("img, canvas, video, svg image, [role='img']")) {
      consider(element, true);
    }
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      best: candidates[0] || null,
      naturalSize: (() => {
        const img = document.getElementById("manga");
        return img ? { width: img.naturalWidth, height: img.naturalHeight,
          rendered: Math.round(img.getBoundingClientRect().height) } : null;
      })(),
    };
  });
  const viewportArea = media.viewport.width * media.viewport.height;
  console.log(`视口     : ${media.viewport.width}x${media.viewport.height}`);
  if (media.naturalSize) {
    console.log(`原图     : ${media.naturalSize.width}x${media.naturalSize.height}（渲染高 ${media.naturalSize.rendered}px）`);
  }
  if (media.best) {
    const ratio = (media.best.width * media.best.height) / viewportArea;
    console.log(`主图区域 : ${Math.round(media.best.width)}x${Math.round(media.best.height)} = 视口的 ${(ratio * 100).toFixed(1)}%`);
  } else {
    console.log("主图区域 : 未找到（后端要求占视口 8%~80%，且每边 ≥180px）");
  }

  console.log("\n发送 START_AUTO …");
  await worker.evaluate((id) => chrome.tabs.sendMessage(id, { type: "START_AUTO" }), tabId);

  // Watch for every kind of feedback the user could get.
  const seen = { busy: false, toast: null, canvases: 0, notice: null };
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const state = await page.evaluate(() => ({
      busy: Boolean(document.querySelector(".mt-overlay")),
      toast: document.getElementById("mt-toast")?.textContent || null,
      canvases: document.querySelectorAll("canvas.mt-overlay-text-canvas").length,
    })).catch(() => null);
    if (state) {
      if (state.busy) seen.busy = true;
      if (state.toast) seen.toast = state.toast;
      if (state.canvases) seen.canvases = state.canvases;
      if (state.canvases > 0) break;
    }
    await new Promise((done) => setTimeout(done, 400));
  }

  console.log(`\n出现过加载提示 : ${seen.busy}`);
  console.log(`提示文字       : ${JSON.stringify(seen.toast)}`);
  console.log(`生成的覆盖画布 : ${seen.canvases}`);
  if (tabErrors.length) console.log(`页面错误       : ${tabErrors.join(" | ")}`);

  if (!seen.busy && !seen.toast && !seen.canvases) {
    console.log("\n结论：点击后用户看不到任何反馈。");
  }
} finally {
  await browser.close();
  server.close();
  rmSync(workDir, { recursive: true, force: true });
}
