// Reproduce the exact user flow: open the popup, click the button, see whether
// the selection overlay appears on the page.
//
// The earlier browser check sent START_SELECT from the service worker, so a bug
// in the popup's own click path would not have been caught.
//
//   node deploy/check-popup-button.mjs

import http from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import puppeteer from "puppeteer";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionDir = resolve(repoRoot, "extension");

const page = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>manga</title>
  <style>body{margin:0;background:#fff}img{display:block;width:700px;margin:20px auto}</style></head>
  <body><img id="manga" src="/manga.png"></body></html>`;

// Any local PNG will do; this only has to be an <img> on a normal page.
import { readFileSync, existsSync } from "node:fs";
const candidates = ["Image from URL 2", "Image from URL"];
const imagePath = candidates.map((name) => resolve(repoRoot, name)).find((path) => existsSync(path));
const image = imagePath ? readFileSync(imagePath) : Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64");

const server = http.createServer((request, response) => {
  if (request.url === "/manga.png") {
    response.writeHead(200, { "Content-Type": "image/png", "Content-Length": image.length });
    response.end(image);
    return;
  }
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(page);
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
  const extensionId = new URL(target.url()).host;
  console.log(`extension id : ${extensionId}`);

  const tab = await browser.newPage();
  const tabErrors = [];
  tab.on("pageerror", (error) => tabErrors.push(String(error)));
  tab.on("console", (message) => {
    if (message.type() === "error") tabErrors.push(`console: ${message.text()}`);
  });
  await tab.goto(pageUrl, { waitUntil: "load" });
  await tab.waitForSelector("#manga");
  const tabId = await (await target.worker()).evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    return tabs.find((candidate) => candidate.url === url)?.id ?? null;
  }, pageUrl);
  console.log(`tab id       : ${tabId}`);

  // Bring the test tab to the front: chrome.tabs.query({active:true}) in the
  // popup resolves against the focused tab, which is the popup's own tab here.
  await tab.bringToFront();

  // A real extension popup panel cannot be opened headlessly, so the popup page
  // is loaded in a tab. That makes it the *active* tab, and
  // chrome.tabs.query({active:true,currentWindow:true}) would then resolve to
  // the popup itself and the click would report "page is restricted" — a test
  // artefact, not a bug. Bringing the manga tab back to the front first puts
  // the query's answer back where it belongs, and clicking through evaluate()
  // still runs the real handler.
  const popup = await browser.newPage();
  const popupErrors = [];
  const popupConsole = [];
  popup.on("pageerror", (error) => popupErrors.push(String(error)));
  popup.on("console", (message) => popupConsole.push(`${message.type()}: ${message.text()}`));
  await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`, { waitUntil: "load" });
  await tab.bringToFront();
  await new Promise((done) => setTimeout(done, 500));

  const popupState = await popup.evaluate(() => ({
    ocr: document.getElementById("ocrStatus")?.textContent,
    translate: document.getElementById("translateStatus")?.textContent,
    hasSelect: Boolean(document.getElementById("select")),
    hasAuto: Boolean(document.getElementById("auto")),
  }));
  console.log(`popup state  : ${JSON.stringify(popupState)}`);

  console.log("\n点击「框选区域并识别」…");
  await popup.evaluate(() => document.getElementById("select").click());
  await new Promise((done) => setTimeout(done, 2500));

  const overlay = await tab.$(".maslingo-selection").then((handle) => Boolean(handle)).catch(() => false);
  const popupAfter = await popup.evaluate(() => ({
    status: document.getElementById("status")?.textContent,
    detailsOpen: document.getElementById("details")?.open,
  })).catch(() => "popup closed");

  console.log(`选择层出现   : ${overlay}`);
  console.log(`popup 之后   : ${JSON.stringify(popupAfter)}`);
  if (tabErrors.length) console.log(`标签页错误   : ${tabErrors.join(" | ")}`);
  const relevant = popupConsole.filter((line) => /error/i.test(line));
  if (relevant.length) console.log(`popup 控制台 : ${relevant.join(" | ")}`);
  if (popupErrors.length) console.log(`popup 异常   : ${popupErrors.join(" | ")}`);

  if (!overlay) failures.push("点击后页面上没有出现选择层");
  if (!popupState.hasSelect) failures.push("弹窗里没有 #select 按钮");
} catch (error) {
  console.error(`FAIL  ${error.message}`);
  failures.push(error.message);
} finally {
  await browser.close();
  server.close();
}

if (failures.length) {
  console.error(`\n${failures.length} 个问题`);
  process.exit(1);
}
console.log("\n弹窗按钮 → 页面上出现选择层，路径正常");
