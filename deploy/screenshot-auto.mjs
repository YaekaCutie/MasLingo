// The whole pipeline on a real page with the real backend.
//
// Every end-to-end check so far used a stub backend so the numbers would be
// deterministic. That proves the plumbing but says nothing about what the user
// actually sees. This runs the real OCR backend over a real manga page and
// captures the result.
//
//   node deploy/screenshot-auto.mjs [图片路径]

import http from "node:http";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import puppeteer from "puppeteer";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const backendUrl = "http://127.0.0.1:8001";

try {
  const health = await (await fetch(`${backendUrl}/health`)).json();
  console.log(`后端: ${JSON.stringify(health)}`);
} catch (error) {
  console.error(`后端没在跑（${backendUrl}）：${error.message}`);
  process.exit(2);
}

const imagePath = [
  process.argv[2],
  "testdata/real/v2-966f6189130307d36ec283af25ef6b27_r.jpg",
  "testdata/real/4b41-a54f6b467963479d1a5552c315c8b31f.jpg",
].filter(Boolean).map((path) => resolve(repoRoot, path)).find((path) => existsSync(path));
if (!imagePath) {
  console.error("需要一张真实漫画页");
  process.exit(2);
}
const image = readFileSync(imagePath);
console.log(`底图: ${imagePath.split(/[\\/]/).pop()}`);

const server = http.createServer((request, response) => {
  if (request.url === "/manga.jpg") {
    response.writeHead(200, { "Content-Type": "image/jpeg", "Content-Length": image.length });
    response.end(image);
    return;
  }
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>manga</title>
    <style>body{margin:0;background:#111}img{display:block;width:760px;margin:0 auto}</style>
    </head><body><img id="page" src="/manga.jpg"></body></html>`);
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const pageUrl = `http://127.0.0.1:${server.address().port}/`;

const workDir = mkdtempSync(join(tmpdir(), "maslingo-shot-auto-"));
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
  // Translation off on purpose: what gets painted is then the recognised text
  // itself, which is the one thing a screenshot can be checked against.
  await worker.evaluate((url) => chrome.storage.local.set({
    backendUrl: url, autoTranslate: true, translationMode: "none",
    translationProvider: "none", autoConcurrency: 1, panelPosition: { left: 20, top: 20 },
  }), backendUrl);

  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 1000, deviceScaleFactor: 1.5 });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(pageUrl, { waitUntil: "load" });

  // OCR of a full page takes a while; the boxes appear as soon as regions are
  // known, the text once each region is painted.
  let painted = 0;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((r) => setTimeout(r, 1500));
    painted = await page.evaluate(() =>
      document.querySelectorAll("#maslingo-layer canvas.maslingo-result").length);
    const boxes = await page.evaluate(() =>
      document.querySelectorAll("#maslingo-layer .maslingo-box").length);
    if (painted > 0 && boxes === 0) break;
  }

  const summary = await page.evaluate(() => {
    const status = document.getElementById("maslingo-status");
    const panel = document.getElementById("maslingo-panel");
    return {
      canvases: document.querySelectorAll("#maslingo-layer canvas.maslingo-result").length,
      boxes: document.querySelectorAll("#maslingo-layer .maslingo-box").length,
      status: status?.textContent?.trim() || "",
      panelText: panel?.textContent?.replace(/\s+/g, " ").slice(0, 90) || "",
    };
  });
  console.log(`画布 ${summary.canvases}  检测框 ${summary.boxes}`);
  console.log(`状态栏：「${summary.status}」`);

  const outDir = resolve(repoRoot, "deploy", "screenshots");
  mkdirSync(outDir, { recursive: true });
  await page.screenshot({ path: join(outDir, "auto-result.png") });
  console.log("截图：deploy/screenshots/auto-result.png");
  if (errors.length) console.log(`页面错误：${errors.slice(0, 2).join(" | ")}`);
} finally {
  await browser.close();
  server.close();
  rmSync(workDir, { recursive: true, force: true });
}
