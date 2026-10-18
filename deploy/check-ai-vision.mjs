// Enhanced recognition, end to end, without a real model.
//
// A fake provider is registered in the service worker and pointed at a local
// echo server; it answers the vision prompt with one positioned translation.
// The test then drives the real automatic-recognition path on a page with a
// large image and checks that the translation is painted in place — which only
// happens if the worker took the vision branch (the local backend is not
// running here at all) and mapped the model's 0-1000 box onto the page.
//
//   node deploy/check-ai-vision.mjs

import http from "node:http";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import puppeteer from "puppeteer";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const check = (label, condition, detail = "") => {
  console.log(`  ${condition ? "ok  " : "FAIL"}  ${label}${condition || !detail ? "" : ` — ${detail}`}`);
  if (!condition) failures.push(label);
};

// The fake model's reply, in the vision contract (0-1000 boxes).
const REPLY = {
  items: [
    { box: [120, 90, 520, 240], text: "こんにちは", translation: "你好" },
  ],
};
const received = [];
const echo = http.createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => { body += chunk; });
  request.on("end", () => {
    received.push(body);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(REPLY) } }] }));
  });
});
await new Promise((done) => echo.listen(0, "127.0.0.1", done));
const echoUrl = `http://127.0.0.1:${echo.address().port}/v1/chat/completions`;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1200">
  <rect width="800" height="1200" fill="#fff"/>
  <rect x="80" y="80" width="640" height="300" fill="none" stroke="#000" stroke-width="6"/>
  <g fill="#111">
    <rect x="140" y="140" width="60" height="90"/><rect x="230" y="140" width="60" height="90"/>
    <rect x="320" y="140" width="60" height="90"/><rect x="410" y="140" width="60" height="90"/>
  </g>
</svg>`;
const pages = http.createServer((request, response) => {
  if (request.url === "/manga.svg") {
    response.writeHead(200, { "Content-Type": "image/svg+xml" });
    response.end(svg);
    return;
  }
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>vision</title>
    <style>body{margin:0;background:#222}#view{width:720px;margin:0 auto}
    img{display:block;width:720px;height:auto}</style></head>
    <body><div id="view"><img id="manga" src="/manga.svg"></div></body></html>`);
});
await new Promise((done) => pages.listen(0, "127.0.0.1", done));
const pageUrl = `http://127.0.0.1:${pages.address().port}/`;

const workDir = mkdtempSync(join(tmpdir(), "maslingo-vision-"));
const extensionDir = join(workDir, "extension");
cpSync(join(repoRoot, "extension"), extensionDir, { recursive: true });
const manifestPath = join(extensionDir, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
manifest.host_permissions = [...(manifest.host_permissions || []), "<all_urls>"];
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

const browser = await puppeteer.launch({
  headless: true,
  args: [
    "--no-sandbox", "--disable-dev-shm-usage",
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

  // Register a fake AI provider whose *vision* path answers from the recorder.
  // The real provider registry is untouched apart from this test entry; the
  // dispatch functions are wrapped so the rest of the app behaves normally.
  await worker.evaluate((url) => {
    const registry = globalThis.MAS_providers;
    registry.list.push({
      id: "vision-test",
      label: "Vision Test",
      group: "AI 大模型",
      adapter: () => ({ url, init: { method: "POST", body: "{}" } }),
      parse: () => [],
      endpoint: url,
      model: "vision-test-model",
      models: [{ id: "vision-test-model", label: "Vision Test Model" }],
      keyRequired: false,
    });
    const originalVisionFor = registry.visionFor;
    registry.visionFor = (provider) => provider?.id === "vision-test"
      ? {
        family: "fake",
        build: () => ({
          url,
          init: {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ probe: "vision" }),
          },
        }),
      }
      : originalVisionFor(provider);
    const originalParseVision = registry.parseVision;
    registry.parseVision = (json, family, size) => family === "fake"
      ? [{ box: [120, 90, 520, 240], text: "こんにちは", translation: "你好" }]
      : originalParseVision(json, family, size);
  }, echoUrl);

  await worker.evaluate(() => chrome.storage.local.set({
    translationProvider: "vision-test",
    translationMode: "openai-compatible",
    translationStrength: 1,
    aiEnhancedRecognition: true,
    debugMode: true,
  }));

  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 1400 });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(pageUrl, { waitUntil: "load" });
  await page.waitForSelector("#manga");
  await new Promise((done) => setTimeout(done, 1200));

  const tabId = await worker.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    return tabs.find((candidate) => candidate.url === url)?.id ?? null;
  }, pageUrl);
  check("测试页面已打开", Boolean(tabId), String(tabId));

  await worker.evaluate((id) => chrome.tabs.sendMessage(id, { type: "START_AUTO" }), tabId);

  // Wait for the painted translation (or a visible failure).
  const deadline = Date.now() + 60000;
  let state = { canvases: 0, labels: [], toast: null };
  while (Date.now() < deadline) {
    state = await page.evaluate(() => ({
      canvases: document.querySelectorAll("canvas.maslingo-overlay-text-canvas").length,
      labels: [...document.querySelectorAll("canvas.maslingo-overlay-text-canvas")]
        .map((node) => node.getAttribute("aria-label")),
      toast: document.getElementById("maslingo-line-text")?.textContent
        || document.getElementById("maslingo-toast")?.textContent || null,
    })).catch(() => state);
    if (state.canvases > 0) break;
    await new Promise((done) => setTimeout(done, 400));
  }

  check("增强识别把整页发给了 AI（收到一次请求）", received.length === 1,
    `${received.length} 次`);
  check("请求携带的是视觉提示词", (() => {
    try {
      return JSON.parse(received[0] || "{}").probe === "vision";
    } catch {
      return false;
    }
  })(), received[0]?.slice(0, 80));
  check("AI 返回的译文被画到页面上", state.canvases === 1 && state.labels[0] === "你好",
    JSON.stringify(state.labels));
  if (state.canvases === 0) console.log(`      面板消息：${JSON.stringify(state.toast)}`);
  check("页面无脚本错误", errors.length === 0, errors.slice(0, 2).join(" | "));
} finally {
  await browser.close();
  echo.close();
  pages.close();
  rmSync(workDir, { recursive: true, force: true });
}

console.log("");
if (failures.length) {
  console.error(`${failures.length} 项不合格`);
  process.exit(1);
}
console.log("增强识别（整页 → AI → 落框翻译）链路正常");
