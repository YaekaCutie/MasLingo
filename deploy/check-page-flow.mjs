// Whole-page auto-detect, on-device: no backend involved at all.
//
// This is the last feature that used to require a server. The page image is
// captured by the service worker, text regions are detected by the JavaScript
// port of backend/ocr/bubble_detector.py, and each region is OCR'd on-device.
//
//   node deploy/check-page-flow.mjs --fixture tools/fixtures/jp-page.png

import http from "node:http";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import puppeteer from "puppeteer";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const fixturePath = resolve(arg("--fixture", join(repoRoot, "tools", "fixtures", "jp-page.png")));
const fixture = readFileSync(fixturePath);

// See deploy/check-region-flow.mjs: captureVisibleTab needs <all_urls> in
// host_permissions or a granted activeTab, and a headless driver cannot click
// the extension action. The permission is unrelated to what is under test.
const workDir = mkdtempSync(join(tmpdir(), "omt-page-flow-"));
const extensionDir = join(workDir, "extension");
cpSync(join(repoRoot, "extension"), extensionDir, { recursive: true });
const manifestPath = join(extensionDir, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
manifest.host_permissions = [...(manifest.host_permissions || []), "<all_urls>"];
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

const server = http.createServer((request, response) => {
  if (request.url === "/page.png") {
    response.writeHead(200, { "Content-Type": "image/png", "Content-Length": fixture.length });
    response.end(fixture);
    return;
  }
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>manga page</title>
    <style>body{margin:0;background:#fff}#page{width:640px;margin:0 auto}
    img{display:block;width:640px;height:auto}</style></head>
    <body><div id="page"><img id="manga" src="/page.png"></div></body></html>`);
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const pageUrl = `http://127.0.0.1:${server.address().port}/`;

const failures = [];
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
  await page.setViewport({ width: 900, height: 820 });
  page.on("dialog", async (dialog) => {
    console.log(`dialog       : ${dialog.message()}`);
    await dialog.dismiss().catch(() => {});
  });
  await page.evaluateOnNewDocument(() => {
    globalThis.__omtLabels = [];
    const recordNode = (node) => {
      if (node.nodeType !== 1) return;
      if (node.classList?.contains("mt-overlay-text-canvas")) {
        const label = node.getAttribute("aria-label");
        if (label) globalThis.__omtLabels.push(label);
      }
      for (const child of node.querySelectorAll?.(".mt-overlay-text-canvas") || []) {
        const label = child.getAttribute("aria-label");
        if (label) globalThis.__omtLabels.push(label);
      }
    };
    new MutationObserver((records) => {
      for (const mutation of records) {
        for (const node of mutation.addedNodes) recordNode(node);
        if (mutation.type === "attributes") recordNode(mutation.target);
      }
    }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-label"] });
  });

  await page.goto(pageUrl, { waitUntil: "load" });
  await page.waitForSelector("#manga");

  const tabId = await worker.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    const match = tabs.find((tab) => tab.url === url);
    return match ? match.id : null;
  }, pageUrl);
  if (tabId === null || tabId === undefined) throw new Error("test tab not found");

  const started = Date.now();
  await worker.evaluate((id) => chrome.tabs.sendMessage(id, { type: "START_AUTO" }), tabId);

  const labels = await page
    .waitForFunction(() => globalThis.__omtLabels?.length >= 3, { timeout: 180000 })
    .then(() => page.evaluate(() => globalThis.__omtLabels))
    .catch(() => page.evaluate(() => globalThis.__omtLabels || []));
  const elapsed = Date.now() - started;

  const status = await worker.evaluate(() => globalThis.OMT_ocr?.getOcrStatus?.()).catch(() => null);
  console.log(`ocr status   : ${JSON.stringify(status)}`);
  console.log(`recognised   : ${labels.length} regions in ${elapsed} ms`);
  for (const label of labels) console.log(`   ${JSON.stringify(label)}`);

  if (labels.length < 3) {    const notice = await page
      .$eval(".mt-overlay-status", (element) => element.textContent.trim())
      .catch(() => "(no status panel)");
    console.error(`FAIL  expected at least 3 detected regions, got ${labels.length}`);
    console.error(`      page notice: ${notice}`);
    failures.push("too few regions");
  } else {
    const normalised = labels.map((label) => label.replace(/\s+/g, ""));
    const expected = ["こんにちは", "漫画の翻訳", "ありがとう"];
    const found = expected.filter((phrase) => normalised.includes(phrase));
    console.log(`\nexact matches: ${found.length}/${expected.length}`);
    for (const phrase of expected) {
      console.log(`   ${found.includes(phrase) ? "OK     " : "MISSING"} ${phrase}`);
    }
    if (found.length < expected.length) failures.push("missing phrases");
  }
} catch (error) {
  console.error(`FAIL  ${error.message}`);
  failures.push(error.message);
} finally {
  await browser.close();
  server.close();
  rmSync(workDir, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`\n${failures.length} problem(s)`);
  process.exit(1);
}
console.log("\nwhole-page auto-detect works on-device");
