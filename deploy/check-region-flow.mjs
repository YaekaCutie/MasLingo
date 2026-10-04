// End-to-end: drive a real drag on a real page and assert the recognised text
// appears as an overlay.
//
// This is the last link that was only ever checked in pieces (content script
// answers START_SELECT; the engine returns the right text for a given crop).
// Here the two are joined: popup-style message -> content script -> drag ->
// service worker capture -> offscreen OCR -> overlay in the page.
//
// Usage:
//   node deploy/check-region-flow.mjs --fixture tools/fixtures/jp-horizontal.png \
//        --expect "日本語のテストです"
//
// The screenshot comes from chrome.tabs.captureVisibleTab, which normally needs
// a user gesture (activeTab) or <all_urls>; whether this can be driven from a
// test is exactly what this script finds out.

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

const fixturePath = resolve(arg("--fixture", join(repoRoot, "tools", "fixtures", "jp-horizontal.png")));
const expected = arg("--expect", "日本語のテストです");
const fixture = readFileSync(fixturePath);

// chrome.tabs.captureVisibleTab needs <all_urls> in host_permissions or a
// granted activeTab, and activeTab is only granted by a real click on the
// extension action — which a headless driver cannot perform, and which
// content_scripts.matches does NOT provide (verified: the run fails with
// "Either the '<all_urls>' or 'activeTab' permission is required").
//
// So the flow is exercised against a throwaway copy with that one permission
// added. The permission is orthogonal to everything under test here (message
// routing, cropping, on-device OCR, overlay rendering); in the shipped
// extension the user's click supplies it.
const workDir = mkdtempSync(join(tmpdir(), "omt-region-flow-"));
const extensionDir = join(workDir, "extension");
cpSync(join(repoRoot, "extension"), extensionDir, { recursive: true });
const manifestPath = join(extensionDir, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
manifest.host_permissions = [...(manifest.host_permissions || []), "<all_urls>"];
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log("note         : using a temp copy with <all_urls> so captureVisibleTab is allowed");

const server = http.createServer((request, response) => {
  if (request.url === "/fixture.png") {
    response.writeHead(200, { "Content-Type": "image/png", "Content-Length": fixture.length });
    response.end(fixture);
    return;
  }
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>manga</title>
    <style>body{margin:0;background:#fff}#page{width:760px;margin:40px auto}
    img{display:block;width:748px;height:auto;border:1px solid #ddd}</style></head>
    <body><div id="page"><img id="manga" src="/fixture.png"></div></body></html>`);
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
  const extensionId = new URL(target.url()).host;
  console.log(`extension id : ${extensionId}`);

  const page = await browser.newPage();
  await page.setViewport({ width: 1000, height: 700 });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  // The content script reports recognition failures through alert(), so the
  // dialog is the most direct way to see what went wrong.
  page.on("dialog", async (dialog) => {
    console.log(`dialog       : ${dialog.message()}`);
    await dialog.dismiss().catch(() => {});
  });
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      console.log(`page ${message.type()}  : ${message.text()}`);
    }
  });

  // The result canvas is deliberately transient: it exists to draw translated
  // text over the artwork, so with translation disabled the content script
  // removes it again straight away. Observe mutations instead of racing it.
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
    // documentElement does not exist yet at document-start, so observe document.
    new MutationObserver((records) => {
      for (const mutation of records) {
        for (const node of mutation.addedNodes) recordNode(node);
        if (mutation.type === "attributes") recordNode(mutation.target);
      }
    }).observe(document, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-label"],
    });
  });

  await page.goto(pageUrl, { waitUntil: "load" });
  await page.waitForSelector("#manga");

  // Give the content script (run_at: document_idle) a moment to attach.
  const tabId = await worker.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    const match = tabs.find((tab) => tab.url === url);
    return match ? match.id : null;
  }, pageUrl);
  console.log(`tab id       : ${tabId}`);
  if (tabId === null || tabId === undefined) throw new Error("test tab not found");

  // Same call the popup makes when the user clicks "选择漫画区域并识别".
  await worker.evaluate((id) => chrome.tabs.sendMessage(id, { type: "START_SELECT" }), tabId);
  await page.waitForSelector(".mt-selection", { timeout: 10000 });
  console.log("selection overlay shown");

  const box = await page.$eval("#manga", (element) => {
    const rect = element.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });

  const from = { x: box.x + 4, y: box.y + 4 };
  const to = { x: box.x + box.width - 4, y: box.y + box.height - 4 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 5 });
  await page.mouse.move(to.x, to.y, { steps: 5 });
  await page.mouse.up();
  console.log("dragged a selection over the image");

  // Success is observable as an aria-label on a result canvas. It may be gone
  // by the time we look (see the observer above), so read the recorded values.
  const labels = await page
    .waitForFunction(() => globalThis.__omtLabels?.length > 0, { timeout: 60000 })
    .then(() => page.evaluate(() => globalThis.__omtLabels))
    .catch(() => []);

  const ocrStatus = await worker.evaluate(() => globalThis.OMT_ocr?.getOcrStatus?.()).catch(() => null);
  console.log(`ocr status   : ${JSON.stringify(ocrStatus)}`);

  if (labels.length === 0) {
    const notice = await page
      .$eval(".mt-overlay-status", (element) => element.textContent.trim())
      .catch(() => "(no status panel)");
    console.error("FAIL  recognition produced no text");
    console.error(`      page notice: ${notice}`);
    failures.push("no recognised text");
  } else {
    console.log(`overlay text : ${labels[0]}`);
    if (labels.some((label) => label.trim() === expected.trim())) {
      console.log("match        : exact");
    } else {
      console.error(`FAIL  expected: ${expected}`);
      failures.push("text mismatch");
    }
  }

  if (pageErrors.length) {
    console.error(`page errors  : ${pageErrors.join(" | ")}`);
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
console.log("\ndrag-to-text works end to end");
