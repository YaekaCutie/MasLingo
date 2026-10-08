// Screenshot the panel over real artwork.
//
// The behaviour checks run on a synthetic page because it is deterministic, but
// a grey rectangle says nothing about how the glass reads on top of a drawing —
// which is the only place it will ever be seen. This puts it on a real page.
//
//   node deploy/screenshot-panel.mjs [图片路径]

import http from "node:http";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import puppeteer from "puppeteer";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const candidates = [
  process.argv[2],
  "testdata/real/v2-966f6189130307d36ec283af25ef6b27_r.jpg",
  "testdata/real/4b41-a54f6b467963479d1a5552c315c8b31f.jpg",
  "Image from URL 2",
].filter(Boolean).map((path) => resolve(repoRoot, path));
const imagePath = candidates.find((path) => existsSync(path));
if (!imagePath) {
  console.error("需要一张真实漫画页：先跑 tools/fetch_pages.py，或把路径作为参数传进来");
  process.exit(2);
}
const image = readFileSync(imagePath);
console.log(`底图: ${imagePath.split(/[\\/]/).pop()} (${Math.round(image.length / 1024)} KB)`);

const server = http.createServer((request, response) => {
  if (request.url === "/manga.jpg") {
    response.writeHead(200, { "Content-Type": "image/jpeg", "Content-Length": image.length });
    response.end(image);
    return;
  }
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>manga</title>
    <style>body{margin:0;background:#111}img{display:block;height:100vh;margin:0 auto}</style>
    </head><body><img src="/manga.jpg"></body></html>`);
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const pageUrl = `http://127.0.0.1:${server.address().port}/`;

const workDir = mkdtempSync(join(tmpdir(), "omt-shot-panel-"));
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
  // Placed over the drawing rather than in the corner: the whole point of the
  // glass is what shows through it, and against the page's flat background there
  // is nothing to see. This is also where a user would drag it.
  await worker.evaluate(() => chrome.storage.local.set({
    autoTranslate: false, translationProvider: "deepseek", backendUrl: "http://127.0.0.1:8001",
    panelPosition: { left: 300, top: 420 },
  }));

  const outDir = resolve(repoRoot, "deploy", "screenshots");
  mkdirSync(outDir, { recursive: true });

  for (const scheme of ["light", "dark"]) {
    const page = await browser.newPage();
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
    await page.setViewport({ width: 1200, height: 900, deviceScaleFactor: 2 });
    await page.goto(pageUrl, { waitUntil: "load" });
    await new Promise((done) => setTimeout(done, 2500));
    // Show something in the status bar so the bottom line is not just "就绪".
    await page.evaluate(() => globalThis.OMT_panel?.status("正在 OCR……"));
    await new Promise((done) => setTimeout(done, 400));
    await page.screenshot({ path: join(outDir, `panel-on-manga-${scheme}.png`) });
    console.log(`  ${scheme}: panel-on-manga-${scheme}.png`);
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
  rmSync(workDir, { recursive: true, force: true });
}

console.log(`输出目录: ${resolve(repoRoot, "deploy", "screenshots")}`);
