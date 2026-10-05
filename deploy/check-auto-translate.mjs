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
const consoleLines = [];
const check = (label, condition) => {
  console.log(`  ${condition ? "ok  " : "FAIL"}  ${label}`);
  if (!condition) failures.push(label);
};

/** Collect console output and errors from every page the test opens. */
function watch(page, label) {
  page.on("pageerror", (error) => consoleLines.push(`${label} pageerror: ${error}`));
  page.on("console", (message) => consoleLines.push(`${label} ${message.type()}: ${message.text()}`));
  return page;
}

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
  if (request.url === "/v1/chat/completions") {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      let asked = [];
      let source = [];
      try {
        asked = JSON.parse(Buffer.concat(chunks).toString("utf8")).messages || [];
        const content = asked.at(-1)?.content || "";
        // chatPrompt puts the source texts after "输入：" as a JSON array, and
        // the provider layer rejects a reply whose length differs from the
        // request, so the stub has to mirror it exactly.
        const marker = content.indexOf("输入：");
        if (marker !== -1) source = JSON.parse(content.slice(marker + 3).trim());
      } catch { /* not a request we can mirror */ }
      translateCalls.push(source.length);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        choices: [{ message: { content: JSON.stringify(source.map((t) => `译:${t}`)) } }],
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

// A third origin that serves the picture to the page but refuses the extension.
// That is what a hotlink-protecting CDN looks like from inside an extension, and
// it is the case only the screenshot route can handle: the picture is on screen,
// so its pixels can be captured even though they cannot be fetched.
const guarded = http.createServer((request, response) => {
  const match = IMAGES.find(({ name }) => request.url === `/${name}`);
  if (!match) {
    response.writeHead(404).end();
    return;
  }
  const fromExtension = Boolean(request.headers.origin?.startsWith("chrome-extension://"))
    || request.headers["sec-fetch-site"] === "cross-site";
  if (fromExtension) {
    response.writeHead(403).end("no");
    return;
  }
  const body = encoded.get(match.name);
  response.writeHead(200, { "Content-Type": "image/png", "Content-Length": body.length });
  response.end(body);
});
await new Promise((done) => guarded.listen(0, "127.0.0.1", done));
const guardedUrl = `http://127.0.0.1:${guarded.address().port}`;

// A second origin for the pictures. A content script cannot use the extension's
// host permissions to fetch cross-origin (MV3), so this reproduces the user's
// "图片读取失败 403": the direct fetch fails and only the service worker relay
// can get the bytes. Same-origin pages cannot catch this.
const cdn = http.createServer((request, response) => {
  const match = IMAGES.find(({ name }) => request.url === `/${name}`);
  if (!match) {
    response.writeHead(404).end();
    return;
  }
  const body = encoded.get(match.name);
  // Deliberately no Access-Control-Allow-Origin.
  response.writeHead(200, { "Content-Type": "image/png", "Content-Length": body.length });
  response.end(body);
});
await new Promise((done) => cdn.listen(0, "127.0.0.1", done));
const cdnUrl = `http://127.0.0.1:${cdn.address().port}`;

const pages = http.createServer((request, response) => {
  const match = IMAGES.find(({ name }) => request.url === `/${name}`);
  if (match) {
    const body = encoded.get(match.name);
    response.writeHead(200, { "Content-Type": "image/png", "Content-Length": body.length });
    response.end(body);
    return;
  }
  if (request.url === "/broken") {
    response.end(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>broken</title>
      <style>body{margin:0;background:#2a2a2a}img{display:block;width:600px;height:840px;margin:24px auto}</style>
      </head><body>
      <img id="ghost" src="/missing-thumbnail.png">
      <img id="real" src="/p1.png"></body></html>`);
    return;
  }
  if (request.url === "/guarded") {
    response.end(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>guarded</title>
      <style>body{margin:0;background:#2a2a2a}img{display:block;width:600px;height:840px;margin:8px auto}</style>
      </head><body><img id="locked" src="${guardedUrl}/p1.png"></body></html>`);
    return;
  }
  if (request.url === "/crossorigin") {
    response.end(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>cdn</title>
      <style>body{margin:0;background:#2a2a2a}img{display:block;width:600px;height:840px;margin:24px auto}</style>
      </head><body><img id="remote" src="${cdnUrl}/p1.png"></body></html>`);
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
  watch(page, "main");
  await page.setViewport({ width: 800, height: 900 });
  const tabErrors = [];
  page.on("pageerror", (error) => tabErrors.push(String(error)));
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
  // Watch the animation while it happens. The box is meant to answer "which
  // pieces of text did it find?", so a box the size of the whole picture is
  // exactly the wrong answer — that was the earlier mistake.
  const boxSamples = await page.evaluate(() => new Promise((resolve) => {
    const seen = [];
    const timer = setInterval(() => {
      for (const box of document.querySelectorAll("#omt-layer .omt-box")) {
        const rect = box.getBoundingClientRect();
        if (rect.width > 1 && rect.height > 1) {
          seen.push({ w: Math.round(rect.width), h: Math.round(rect.height) });
        }
      }
    }, 80);
    setTimeout(() => { clearInterval(timer); resolve(seen); }, 9000);
  }));
  const on = await layers();
  const biggest = boxSamples.reduce((best, b) => (b.w * b.h > best.w * best.h ? b : best), { w: 0, h: 0 });
  console.log(`      采样到 ${boxSamples.length} 个框，最大 ${biggest.w}x${biggest.h}（整图 600x840）`);
  check("检测框出现在画面上", boxSamples.length > 0);
  check("检测框框的是文字区域而不是整张图", biggest.w < 580 || biggest.h < 820,
    `${biggest.w}x${biggest.h}`);
  // And it has to actually reach that size. Sampling only the start-up dot is
  // what a box that never grows looks like from the outside.
  check("检测框确实长到了文字区域大小", biggest.w > 60 && biggest.h > 40,
    `最大只有 ${biggest.w}x${biggest.h}`);
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
  watch(bare, "bare");
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
  watch(grow, "grow");
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

  /**
   * Read what the content script is reporting for a tab.
   *
   * The content script lives in the extension's isolated world, so page
   * .evaluate() cannot see OMT_auto. An extension page can, which is also the
   * only way to test the status line the user actually reads.
   */
  const probePage = await browser.newPage();
  watch(probePage, "probe");
  await probePage.goto(`chrome-extension://${extensionId}/popup/popup.html`, { waitUntil: "load" });
  async function readStatus(pageToRead) {
    const tabId = await worker.evaluate(async (target) => {
      const tabs = await chrome.tabs.query({});
      return tabs.find((candidate) => candidate.url === target)?.id ?? null;
    }, pageToRead.url());
    return probePage.evaluate(async (id) => {
      const stats = await chrome.tabs.sendMessage(id, { type: "AUTO_STATUS" });
      return { stats, text: document.getElementById("autoStateText")?.textContent?.trim() };
    }, tabId);
  }

  console.log("\n页面上有读不出来的图片");
  // Search-results pages are full of pictures the browser will not hand over.
  // One of those must not be reported as a backend problem — the user's own
  // report ("1 处识别失败，请检查后端") came from exactly this, while the backend
  // had answered 200 with eighteen regions.
  const brokenBefore = ocrCalls.length;
  const broken = await browser.newPage();
  watch(broken, "broken");
  await broken.setViewport({ width: 900, height: 1000 });
  await broken.goto(`${pageUrl}broken`, { waitUntil: "load" });
  await new Promise((r) => setTimeout(r, 6000));
  const brokenState = await broken.evaluate(() => ({
    canvases: document.querySelectorAll("#omt-layer canvas.omt-result").length,
  }));
  const brokenProbe = await readStatus(broken);
  const brokenStats = brokenProbe.stats || { imageFailures: {} };
  await probePage.evaluate(async (id) => {
    const tabs = await chrome.tabs.query({});
    const target = tabs.find((candidate) => candidate.url && candidate.url.endsWith("/broken"));
    if (target) { activeTabId = target.id; await refreshAutoStatus(); await refreshDiagnostics(); }
  });
  const brokenText = await probePage.evaluate(() =>
    document.getElementById("autoStateText")?.textContent?.trim());
  console.log(`      画布 ${brokenState.canvases}，图片失败 ${JSON.stringify(brokenStats.imageFailures)}`);
  console.log(`      状态行 “${brokenText}”`);
  check("坏图片不影响同页的好图片", brokenState.canvases >= 1);
  check("坏图片被单独归类为 unreadable", brokenStats.imageFailures.unreadable >= 1);
  check("坏图片没有被算成识别失败", brokenStats.imageFailures.ocr === 0);
  check("状态行说的不是后端有问题", !/请检查后端/.test(brokenText || ""), brokenText);
  await broken.close();
  const afterBroken = ocrCalls.length;

  console.log("\n配置翻译来源后，坏图片不该被说成后端问题");
  await worker.evaluate(async (url) => {
    await chrome.storage.local.set({
      translationProvider: "custom",
      translationMode: "openai-compatible",
      translationEndpoint: `${url}/v1/chat/completions`,
      translationModel: "stub",
      translationApiKey: "stub-key",
      targetLanguage: "简体中文",
    });
  }, backendUrl);
  const translated = await browser.newPage();
  watch(translated, "translated");
  await translated.setViewport({ width: 900, height: 1000 });
  await translated.goto(`${pageUrl}broken`, { waitUntil: "load" });
  await new Promise((r) => setTimeout(r, 8000));
  const translatedStats = await readStatus(translated);
  await probePage.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    const target = tabs.find((candidate) => candidate.url?.endsWith("/broken"));
    if (target) { activeTabId = target.id; await refreshAutoStatus(); await refreshDiagnostics(); }
  });
  const translatedText = await probePage.evaluate(() =>
    document.getElementById("autoStateText")?.textContent?.trim());
  const translatedMode = translatedStats.stats?.translationMode;
  console.log(`      翻译模式 ${translatedMode}，翻译请求 ${translateCalls.length} 次`);
  console.log(`      状态行 “${translatedText}”`);
  check("翻译链路走通", translateCalls.length >= 1);
  check("状态不再是“翻译来源未设置”", !/翻译来源未设置/.test(translatedText || ""), translatedText);
  // One good region translated, one picture the browser would not hand over.
  // The user's complaint was this being reported as a backend failure; a plain
  // success with the unreadable picture left incidental is the right answer.
  check("翻译成功时不被读不出的图片带偏", /完成/.test(translatedText || ""), translatedText);
  check("状态行仍然不提后端", !/请检查后端/.test(translatedText || ""), translatedText);

  // "Nothing happened" has to be answerable without guessing, so the popup
  // reports the content script's own counters.
  const diagText = await probePage.evaluate(() => document.getElementById("autoDiag").textContent);
  const collected = Number(/扫描到的图片元素：(\d+)/.exec(diagText)?.[1] ?? -1);
  console.log(`      诊断：${diagText.split("\n")[1]}`);
  check("诊断给出了扫描计数", collected >= 1, diagText.slice(0, 120));
  check("诊断说明了符合尺寸的数量", /其中符合漫画尺寸：\d+/.test(diagText));
  check("诊断列出了图片失败分类", /图片失败：/.test(diagText));
  await translated.close();
  const afterTranslated = ocrCalls.length;

  console.log("\n图片在另一个源上（内容脚本取不到，必须走后台）");
  await worker.evaluate(() => chrome.storage.local.set({ autoTranslate: true }));
  const crossBefore = ocrCalls.length;
  const cross = await browser.newPage();
  watch(cross, "cross");
  await cross.setViewport({ width: 900, height: 1000 });
  await cross.goto(`${pageUrl}crossorigin`, { waitUntil: "load" });
  await new Promise((r) => setTimeout(r, 8000));
  const crossState = await cross.evaluate(() => ({
    canvases: document.querySelectorAll("#omt-layer canvas.omt-result").length,
  }));
  const crossProbe = await readStatus(cross);
  console.log(`      画布 ${crossState.canvases}，图片失败 ${JSON.stringify(crossProbe.stats?.imageFailures)}`);
  check("跨域图片仍然被读到", ocrCalls.length > crossBefore);
  check("跨域图片画出了译文", crossState.canvases >= 1);
  check("跨域图片没有被记为失败", (crossProbe.stats?.imageFailures?.unreadable || 0) === 0);
  await cross.close();
  const afterCross = ocrCalls.length;

  console.log("\nCDN 拒绝扩展取图（只剩截图一条路）");
  const lockedBefore = ocrCalls.length;
  const locked = await browser.newPage();
  watch(locked, "locked");
  await locked.setViewport({ width: 900, height: 1000 });
  await locked.goto(`${pageUrl}guarded`, { waitUntil: "load" });
  await new Promise((r) => setTimeout(r, 9000));
  const lockedState = await locked.evaluate(() => ({
    canvases: document.querySelectorAll("#omt-layer canvas.omt-result").length,
  }));
  const lockedProbe = await readStatus(locked);
  console.log(`      画布 ${lockedState.canvases}，图片失败 ${JSON.stringify(lockedProbe.stats?.imageFailures)}`);
  check("拒绝扩展取图时仍然读到", ocrCalls.length > lockedBefore);
  check("拒绝扩展取图时画出了译文", lockedState.canvases >= 1);
  check("截图兜底没有被记为失败", (lockedProbe.stats?.imageFailures?.unreadable || 0) === 0);
  await locked.close();
  const afterLocked = ocrCalls.length;

  console.log("\n弹窗状态（用户实际看到的那行字）");
  // The user's own screenshot showed the popup stuck on "当前页面无法使用" with
  // the switch on and nothing happening — a dead end with no way forward. The
  // status must name the real situation instead.
  const popup = await browser.newPage();
  watch(popup, "popup");
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
  check("关闭后不再产生 OCR 请求", ocrCalls.length === afterLocked);
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
  cdn.close();
  guarded.close();
  rmSync(workDir, { recursive: true, force: true });
}

if (failures.length) {
  console.log(`\n${failures.length} 项失败`);
  process.exit(1);
}
console.log("\n自动翻译行为符合预期");
