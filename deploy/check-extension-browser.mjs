#!/usr/bin/env node
// Load the extension into a real Chrome and exercise it.
//
// deploy/check-extension.mjs proves the package is internally consistent, but
// it cannot prove Chrome agrees. The gap that matters most: config.js is pulled
// in with importScripts() from a Manifest V3 service worker, and if Chrome
// refuses that, every backend lookup is undefined and the extension silently
// does nothing. Only a real browser settles it.
//
// Usage:
//   node deploy/check-extension-browser.mjs [--extension DIR] [--backend URL]
//
// With --backend it also drives the popup's "check backend" button against a
// live server, proving extension -> fetch -> API -> DOM works end to end.

import http from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import puppeteer from "puppeteer";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const extensionDir = resolve(arg("--extension", join(root, "extension")));
const backendUrl = arg("--backend", "");
const expectedRole = arg("--expect-role", "");
// A fresh install has no backendUrl in storage: it must fall through to the
// hosted default. Use --no-storage to reproduce that exact case.
const writeStorage = !process.argv.includes("--no-storage");

const failures = [];
const fail = (message) => {
  failures.push(message);
  console.error(`FAIL  ${message}`);
};
const pass = (message) => console.log(`ok    ${message}`);

// Chrome 137 disabled --load-extension on the command line; this restores it.
// Without the flag the extension never appears and every check below fails.
const LAUNCH_ARGS = [
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "--disable-features=DisableLoadExtensionCommandLineSwitch",
  `--disable-extensions-except=${extensionDir}`,
  `--load-extension=${extensionDir}`,
];

async function launchWithServiceWorker() {
  // New headless (headless: true as of Puppeteer 22) supports extensions;
  // fall back to a real window, which CI wraps in xvfb-run, if the worker
  // never shows up.
  for (const headless of [true, false]) {
    let browser;
    try {
      browser = await puppeteer.launch({ headless, args: LAUNCH_ARGS });
      const target = await browser.waitForTarget(
        (candidate) =>
          candidate.type() === "service_worker" &&
          candidate.url().includes("background/service-worker.js"),
        { timeout: headless === true ? 15000 : 30000 },
      );
      console.log(`      (chrome launched with headless=${headless})`);
      return { browser, target };
    } catch (error) {
      if (browser) await browser.close();
      console.log(`      headless=${headless} did not expose the service worker (${error.message})`);
    }
  }
  throw new Error("the extension service worker never registered in any mode");
}

// --- a page for the content script to attach to -----------------------------

const server = http.createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><html lang="ja"><head><meta charset="utf-8">
    <title>manga page</title></head><body>
    <h1>テスト</h1><div style="width:300px;height:400px;background:#eee">panel</div>
    </body></html>`);
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const pageUrl = `http://127.0.0.1:${server.address().port}/`;

let browser;
try {
  ({ browser } = await launchWithServiceWorker().catch((error) => {
    fail(error.message);
    return {};
  }));

  if (browser) {
    // Re-find the target now that we know the browser is up.
    const target = await browser.waitForTarget(
      (candidate) =>
        candidate.type() === "service_worker" &&
        candidate.url().includes("background/service-worker.js"),
      { timeout: 30000 },
    );
    const worker = await target.worker();
    const extensionId = new URL(target.url()).host;
    pass(`service worker registered (extension id ${extensionId})`);

    // --- importScripts actually worked ------------------------------------
    const resolverType = await worker.evaluate(() => typeof self.OMT_backendCandidates);
    if (resolverType === "function") {
      pass("config.js was loaded into the service worker via importScripts()");
    } else {
      fail(`self.OMT_backendCandidates is ${resolverType}, expected function`);
    }

    const candidates = await worker.evaluate(() => self.OMT_backendCandidates());
    if (Array.isArray(candidates) && candidates.length > 0) {
      pass(`backend candidates resolve to ${JSON.stringify(candidates)}`);
    } else {
      fail(`backend candidates look wrong: ${JSON.stringify(candidates)}`);
    }

    // --- content script path ----------------------------------------------
    const page = await browser.newPage();
    await page.goto(pageUrl, { waitUntil: "domcontentloaded" });
    const tabId = await worker.evaluate(async (url) => {
      const tabs = await chrome.tabs.query({});
      const match = tabs.find((tab) => tab.url === url);
      return match ? match.id : null;
    }, pageUrl);

    if (tabId === null || tabId === undefined) {
      fail("could not find the test tab (chrome.tabs.query returned no url)");
    } else {
      const answered = await worker
        .evaluate(async (id) => {
          for (let attempt = 0; attempt < 50; attempt += 1) {
            try {
              await chrome.tabs.sendMessage(id, { type: "PING" });
              return true;
            } catch {
              await new Promise((done) => setTimeout(done, 200));
            }
          }
          return false;
        }, tabId)
        .catch((error) => `error: ${error.message}`);

      if (answered === true) {
        pass("the <all_urls> content script is present on an http page");

        await worker.evaluate((id) => chrome.tabs.sendMessage(id, { type: "START_SELECT" }), tabId);
        const overlay = await page
          .waitForSelector(".mt-selection", { timeout: 10000 })
          .then(() => true)
          .catch(() => false);
        if (overlay) {
          pass("START_SELECT produced the selection overlay in the page");
        } else {
          fail("START_SELECT did not create .mt-selection");
        }
      } else {
        fail(`content script never answered PING (${answered})`);
      }
    }

    // --- popup + options pages --------------------------------------------
    if (backendUrl && writeStorage) {
      await worker.evaluate((url) => chrome.storage.local.set({ backendUrl: url }), backendUrl);
    }

    const popupErrors = [];
    const popup = await browser.newPage();
    popup.on("pageerror", (error) => popupErrors.push(String(error)));
    popup.on("console", (message) => {
      if (message.type() === "error") popupErrors.push(message.text());
    });
    await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`, { waitUntil: "load" });

    const role = await popup
      .waitForFunction(() => document.getElementById("backendRole")?.textContent !== "检测中…", {
        timeout: 20000,
      })
      .then(() => popup.$eval("#backendRole", (element) => element.textContent))
      .catch(() => null);

    if (role) {
      pass(`popup resolved its backend: "${role}"`);
      if (expectedRole && role !== expectedRole) {
        fail(`popup reported "${role}", expected "${expectedRole}"`);
      }
    } else {
      fail("popup never resolved #backendRole (refreshConfig did not finish)");
    }

    if (backendUrl) {
      await popup.click("#health");
      const status = await popup
        .waitForFunction(
          () => !document.getElementById("status").textContent.includes("准备就绪"),
          { timeout: 30000 },
        )
        .then(() => popup.$eval("#status", (element) => element.textContent))
        .catch(() => null);
      if (status && status.includes("mangaocr")) {
        pass(`popup reached the live backend: ${status.split("\n")[0]}`);
      } else {
        fail(`popup could not reach the backend; status was: ${JSON.stringify(status)}`);
      }
    }

    if (popupErrors.length === 0) {
      pass("popup page produced no console or page errors");
    } else {
      fail(`popup errors: ${popupErrors.join(" | ")}`);
    }

    const optionsErrors = [];
    const options = await browser.newPage();
    options.on("pageerror", (error) => optionsErrors.push(String(error)));
    await options.goto(`chrome-extension://${extensionId}/options/options.html`, { waitUntil: "load" });
    const hint = await options
      .waitForFunction(() => document.getElementById("backendHint")?.textContent.trim().length > 0, {
        timeout: 15000,
      })
      .then(() => options.$eval("#backendHint", (element) => element.textContent.trim()))
      .catch(() => null);
    if (hint) {
      pass(`options page rendered its backend hint: "${hint}"`);
    } else {
      fail("options page never filled #backendHint");
    }
    if (optionsErrors.length) fail(`options errors: ${optionsErrors.join(" | ")}`);
  }
} finally {
  if (browser) await browser.close();
  server.close();
}

if (failures.length) {
  console.error(`\n${failures.length} browser check(s) failed`);
  process.exit(1);
}
console.log("\nextension runs correctly in a real Chrome");
