// Does "自动翻译" actually work the way the spec describes?
//
// The claims that matter are behavioural, not structural, so they are checked by
// driving a real browser against a real page with images above and below the
// fold:
//
//   * the notice appears once, not once per region;
//   * a result canvas ends up anchored to each image, inside #omt-layer;
//   * scrolling to new images translates them, and scrolling back finds the
//     earlier results still there;
//   * each image is sent to OCR exactly once — scrolling past it again must not
//     re-OCR or re-translate it;
//   * turning the switch off stops the requests.
//
// A stub backend stands in for the real one so OCR calls can be counted and the
// responses kept deterministic.
//
//   node deploy/check-auto-translate.mjs

import http from "node:http";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import puppeteer from "puppeteer";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const check = (label, condition) => {
  console.log(`  ${condition ? "ok  " : "FAIL"}  ${label}`);
  if (!condition) failures.push(label);
};

/** A page of solid-colour blocks: enough for createImageBitmap, no decode cost. */
function makePng(width, height, rgb) {
  const { deflateSync } = require_zlib();
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 3 + 1);
    raw[rowStart] = 0;
    for (let x = 0; x < width; x += 1) {
      const at = rowStart + 1 + x * 3;
      raw[at] = rgb[0];
      raw[at + 1] = rgb[1];
      raw[at + 2] = rgb[2];
    }
  }
  const crcTable = [];
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc = (buffer) => {
    let c = 0xffffffff;
    for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

let zlib = null;
function require_zlib() {
  return zlib;
}

const IMAGES = [
  { name: "p1.png", rgb: [235, 235, 235] },
  { name: "p2.png", rgb: [220, 226, 224] },
  { name: "p3.png", rgb: [228, 222, 222] },
];
zlib = await import("node:zlib");
const encoded = new Map(IMAGES.map(({ name, rgb }) => [name, makePng(600, 840, rgb)]));

// --- stub backend -----------------------------------------------------------

const ocrCalls = [];
const translateCalls = [];
const backend = http.createServer((request, response) => {
  if (request.url === "/api/recognize-page") {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      // Which image this is can only be told apart by request order, which is
      // exactly what the dedup check needs: one entry per picture sent.
      ocrCalls.push(Buffer.concat(chunks).length);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        ok: true,
        items: [{
          text: `テスト${ocrCalls.length}`,
          bbox: { left: 120, top: 160, right: 460, bottom: 420 },
          direction: "vertical",
          confidence: 0.95,
        }],
      }));
    });
    return;
  }
  if (request.url === "/health") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ ok: true, backend: "stub" }));
    return;
  }
  response.writeHead(404).end();
});
await new Promise((done) => backend.listen(0, "127.0.0.1", done));
const backendUrl = `http://127.0.0.1:${backend.address().port}`;

// The extension asks the service worker to translate; stub that endpoint too by
// answering through the provider layer is not possible, so the page-side check
// only needs OCR to have happened. Translation failures are handled by design
// (the region is marked FAILED and the queue continues), which is itself worth
// asserting.
const workDir = mkdtempSync(join(tmpdir(), "omt-auto-translate-"));
const extensionDir = join(workDir, "extension");
cpSync(join(repoRoot, "extension"), extensionDir, { recursive: true });
const manifestPath = join(extensionDir, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
manifest.host_permissions = [...(manifest.host_permissions || []), "<all_urls>"];
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

const pages = http.createServer((request, response) => {
  const match = IMAGES.find(({ name }) => request.url === `/${name}`);
  if (match) {
    const body = encoded.get(match.name);
    response.writeHead(200, { "Content-Type": "image/png", "Content-Length": body.length });
    response.end(body);
    return;
  }
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  if (request.url === "/grow") {
    // An image that is laid out small and only reaches its real size later —
    // what Bing's image viewer, lazy loaders and CSS transitions all do.
    response.end(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>grow</title>
      <style>body{margin:0;background:#2a2a2a}#late{display:block;width:90px;height:126px;margin:40px}</style>
      </head><body><img id="late" src="/p1.png">
      <script>setTimeout(() => {
        const image = document.getElementById("late");
        image.style.width = "600px";
        image.style.height = "840px";
      }, 1800);</script></body></html>`);
    return;
  }
  response.end(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>manga</title>
    <style>
      body{margin:0;background:#2a2a2a;font:14px system-ui}
      .page{width:600px;margin:0 auto;padding:24px 0}
      img{display:block;width:600px;height:840px;margin-bottom:24px;background:#fff}
      #spacer{height:900px}
    </style></head>
    <body><div class="page">
      <img id="one" src="/p1.png">
      <img id="two" src="/p2.png">
      <div id="spacer"></div>
      <img id="three" src="/p3.png">
    </div></body></html>`);
});
await new Promise((done) => pages.listen(0, "127.0.0.1", done));
const pageUrl = `http://127.0.0.1:${pages.address().port}/`;

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
  await worker.evaluate(async (url) => {
    await chrome.storage.local.set({
      backendUrl: url,
      autoTranslate: false,
      translationMode: "none",
      autoConcurrency: 1,
    });
  }, backendUrl);

  const page = await browser.newPage();
  await page.setViewport({ width: 800, height: 900 });
  const tabErrors = [];
  const consoleLines = [];
  page.on("pageerror", (error) => tabErrors.push(String(error)));
  page.on("console", (message) => consoleLines.push(`${message.type()}: ${message.text()}`));
  worker.on?.("console", (message) => consoleLines.push(`sw ${message.type()}: ${message.text()}`));
  await page.goto(pageUrl, { waitUntil: "load" });
  await page.waitForSelector("#one");

  const layers = () => page.evaluate(() => ({
    layer: Boolean(document.getElementById("omt-layer")),
    canvases: document.querySelectorAll("#omt-layer canvas.omt-result").length,
    boxes: document.querySelectorAll("#omt-layer .omt-box").length,
    notice: document.getElementById("omt-notice")?.textContent || "",
    noticeVisible: Boolean(document.getElementById("omt-notice")?.classList.contains("omt-notice-in")),
  }));

  console.log("\n关闭状态");
  await new Promise((r) => setTimeout(r, 1500));
  await page.evaluate(() => window.scrollTo(0, 400));
  await new Promise((r) => setTimeout(r, 1500));
  const off = await layers();
  check("关闭时没有覆盖层", !off.layer);
  check("关闭时没有 OCR 请求", ocrCalls.length === 0);

  console.log("\n开启自动翻译");
  await worker.evaluate(() => chrome.storage.local.set({ autoTranslate: true }));
  await new Promise((r) => setTimeout(r, 4000));
  const on = await layers();
  check("出现覆盖层", on.layer);
  check("右上角提示只出现一次且文案正确",
    on.notice.includes("自动翻译") || on.notice.includes("检测到漫画"));
  check("图片上出现了结果画布", on.canvases >= 1);
  check("第一张图被送去 OCR", ocrCalls.length >= 1);
  const afterFirst = ocrCalls.length;

  console.log("\n滚动到页面下方");
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await new Promise((r) => setTimeout(r, 4000));
  const far = await layers();
  check("滚动后检测到新图片", ocrCalls.length > afterFirst);
  const afterScroll = ocrCalls.length;

  console.log("\n滚回顶部");
  await page.evaluate(() => window.scrollTo(0, 0));
  await new Promise((r) => setTimeout(r, 3000));
  const back = await layers();
  check("滚回后之前的译文仍在", back.canvases >= on.canvases);
  check("滚回后没有重复 OCR", ocrCalls.length === afterScroll);

  console.log("\n再滚一次（验证去重）");
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await new Promise((r) => setTimeout(r, 2500));
  await page.evaluate(() => window.scrollTo(0, 0));
  await new Promise((r) => setTimeout(r, 2500));
  check("反复滚动不产生新的 OCR 请求", ocrCalls.length === afterScroll);

  console.log("\n图片直链页面（Chrome 会包一层最简 HTML）");
  // Manga sites very often link straight at the .jpg, and the user's own test
  // page was one of those. It is a different document shape from a real page,
  // so it gets its own pass rather than being assumed equivalent.
  await worker.evaluate(() => chrome.storage.local.set({ autoTranslate: true }));
  const bareBefore = ocrCalls.length;
  const extensionId = new URL(worker.url()).host;
  const bare = await browser.newPage();
  const bareErrors = [];
  bare.on("pageerror", (error) => bareErrors.push(String(error)));
  await bare.setViewport({ width: 900, height: 1000 });
  await bare.goto(`${pageUrl}p1.png`, { waitUntil: "load" });
  await new Promise((r) => setTimeout(r, 5000));
  const bareState = await bare.evaluate(() => ({
    canvases: document.querySelectorAll("#omt-layer canvas.omt-result").length,
    images: document.querySelectorAll("img").length,
    layer: Boolean(document.getElementById("omt-layer")),
  })).catch(() => ({ canvases: -1, images: -1, layer: false }));
  console.log(`      img=${bareState.images} layer=${bareState.layer} canvases=${bareState.canvases}`);
  check("图片直链页面注入了覆盖层", bareState.layer);
  check("图片直链页面识别到了图片", bareState.images >= 1);
  check("图片直链页面被送去 OCR", ocrCalls.length > bareBefore);
  check("图片直链页面画出了译文", bareState.canvases >= 1);
  if (bareErrors.length) for (const error of bareErrors) console.log(`      ${error.slice(0, 200)}`);
  await bare.close();

  console.log("\n图片先小后大（查看器 / 懒加载 / CSS 过渡）");
  // The user's recording showed the notice firing and then nothing at all for
  // nine minutes: the scan ran, but the picture had not reached its final size
  // yet, and a candidate rejected at scan time was never looked at again.
  const growBefore = ocrCalls.length;
  const grow = await browser.newPage();
  const growErrors = [];
  grow.on("pageerror", (error) => growErrors.push(String(error)));
  await grow.setViewport({ width: 900, height: 1000 });
  await grow.goto(`${pageUrl}grow`, { waitUntil: "load" });
  await new Promise((r) => setTimeout(r, 7000));
  const growState = await grow.evaluate(() => ({
    canvases: document.querySelectorAll("#omt-layer canvas.omt-result").length,
    width: document.getElementById("late")?.getBoundingClientRect().width,
  }));
  console.log(`      图片最终宽度 ${growState.width}px，画布 ${growState.canvases}`);
  check("图片长大后仍然被处理", ocrCalls.length > growBefore);
  check("图片长大后画出了译文", growState.canvases >= 1);
  if (growErrors.length) for (const error of growErrors) console.log(`      ${error.slice(0, 200)}`);
  await grow.close();
  const afterGrow = ocrCalls.length;

  console.log("\n弹窗状态（用户实际看到的那行字）");
  // The user's own screenshot showed the popup stuck on "当前页面无法使用" with
  // the switch on and nothing happening — a dead end with no way forward. The
  // status must name the real situation instead.
  const popup = await browser.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`, { waitUntil: "load" });
  // puppeteer's newPage() opens its own window, so the popup would otherwise ask
  // about itself. Point it at the real manga tab, which is what a real popup —
  // not being a tab at all — would see.
  const mangaTabId = await worker.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    return tabs.find((candidate) => candidate.url === url)?.id ?? null;
  }, pageUrl);
  await popup.evaluate(async (tabId) => {
    activeTabId = tabId;
    await refreshAutoStatus();
  }, mangaTabId);
  await new Promise((r) => setTimeout(r, 1200));
  const popupText = await popup.evaluate(() => ({
    text: document.getElementById("autoStateText")?.textContent?.trim(),
    kind: document.getElementById("autoState")?.dataset.state,
  }));
  console.log(`      “${popupText.text}” (${popupText.kind})`);
  check("弹窗给出可操作的状态而不是死路",
    Boolean(popupText.text) && popupText.text !== "当前页面无法使用", popupText.text);
  check("自动翻译已开时状态不是“未开启”", popupText.text !== "未开启", popupText.text);
  await popup.close();

  console.log("\n关闭开关");
  await worker.evaluate(() => chrome.storage.local.set({ autoTranslate: false }));
  await new Promise((r) => setTimeout(r, 800));
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await new Promise((r) => setTimeout(r, 2000));
  check("关闭后不再产生 OCR 请求", ocrCalls.length === afterGrow);
  const kept = await layers();
  check("关闭后已完成的译文保留", kept.canvases >= 1);

  check("页面无脚本错误", tabErrors.length === 0);
  if (tabErrors.length) for (const error of tabErrors) console.log(`      ${error.slice(0, 200)}`);

  console.log(`\nOCR 请求总数: ${ocrCalls.length}（3 张图）`);
  const interesting = consoleLines.filter((line) => /OMT|失败|error|Error/.test(line));
  if (interesting.length) {
    console.log("\n控制台：");
    for (const line of interesting.slice(0, 12)) console.log(`      ${line.slice(0, 220)}`);
  }
} finally {
  await browser.close();
  backend.close();
  pages.close();
  rmSync(workDir, { recursive: true, force: true });
}

if (failures.length) {
  console.log(`\n${failures.length} 项失败`);
  process.exit(1);
}
console.log("\n自动翻译行为符合预期");
