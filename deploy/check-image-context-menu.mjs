// Deterministic menu routing + real extension/DOM image translation.
import assert from "node:assert/strict";
import http from "node:http";
import vm from "node:vm";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "extension/manifest.json"), "utf8"));
const menuId = "maslingo-translate-image";
let created, listener, missing = 0, stale = false;
const routed = [], injected = [];
const sandbox = { console, URL, URLSearchParams, TextEncoder, crypto, AbortController, setTimeout, clearTimeout,
  chrome: {
    runtime: { getManifest: () => manifest, onInstalled: { addListener() {} }, onStartup: { addListener() {} },
      onMessage: { addListener() {} }, onConnect: { addListener() {} } },
    contextMenus: { update: async () => { if (!created) throw new Error("not found"); },
      create: (properties, done) => { assert.equal(created, undefined); created = properties; done(); },
      onClicked: { addListener(fn) { listener = fn; } } },
    tabs: { sendMessage: async (id, message, options) => {
      routed.push({ id, message, options });
      if (message.type === "TRANSLATE_CONTEXT_IMAGE" && missing-- > 0) throw new Error("no receiver");
      return { ok: true };
    } },
    scripting: { executeScript: async options => { injected.push(options); return [{ result: stale }]; },
      insertCSS: async options => { injected.push(options); } },
    storage: { local: { get: async () => ({}) } },
  },
};
vm.createContext(sandbox);
sandbox.importScripts = (...names) => names.forEach(name => vm.runInContext(
  readFileSync(resolve(root, "extension/background", name), "utf8"), sandbox));
vm.runInContext(readFileSync(join(root, "extension/background/service-worker.js"), "utf8"), sandbox);
await sandbox.ensureImageMenu();
assert.equal(created.id, menuId);
assert.equal(created.contexts.join(","), "image");
assert.ok(manifest.permissions.includes("contextMenus"));
listener({ menuItemId: menuId, frameId: 7, srcUrl: "https://example.com/image.png" }, { id: 42 });
assert.equal(routed[0].options.frameId, 7);
assert.equal(routed[0].message.srcUrl, "https://example.com/image.png");
missing = 1;
await sandbox.handleImageMenuClick({ menuItemId: menuId, frameId: 7, srcUrl: "https://example.com/image.png" }, { id: 42 });
assert.ok(injected.some(item => item.files?.join() === manifest.content_scripts[0].js.join() && item.target.frameIds[0] === 7));
injected.length = 0;
missing = 1; stale = true;
const outdated = await sandbox.handleImageMenuClick({ menuItemId: menuId, frameId: 7 }, { id: 42 });
assert.equal(outdated.ok, false);
assert.ok(outdated.error.includes("刷新"));
assert.ok(!injected.some(item => item.files), "Never inject a second copy over an orphaned script");
assert.equal(routed.at(-1).options.frameId, 0);
console.log("PASS menu registration, exact frame routing, missing-script repair and stale-script feedback");

let image = Buffer.alloc(0), ocrCalls = 0, translationCalls = 0, failOcr = false;
const server = http.createServer((request, response) => {
  let body = Buffer.alloc(0);
  request.on("data", data => { body = Buffer.concat([body, data]); });
  request.on("end", () => {
    if (request.url.endsWith(".png")) { response.writeHead(200, { "Content-Type": "image/png" }); response.end(image); return; }
    if (request.url === "/health") { response.setHeader("Content-Type", "application/json"); response.end('{"ok":true}'); return; }
    if (request.url === "/api/recognize-page") {
      ocrCalls++;
      if (failOcr) { response.writeHead(503); response.end('{"detail":"OCR test failure"}'); return; }
      const offset = body.indexOf(Buffer.from([137,80,78,71,13,10,26,10]));
      const width = body.readUInt32BE(offset + 16), height = body.readUInt32BE(offset + 20);
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ ok: true, items: [{ text: "こんにちは", confidence: .99, direction: "horizontal",
        bbox: { left: width * .2, top: height * .2, right: width * .6, bottom: height * .4 }, erase: null }] })); return;
    }
    if (request.url === "/translate") {
      translationCalls++;
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ translations: JSON.parse(body).texts.map(() => "你好") })); return;
    }
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(`<!doctype html><meta charset="utf-8"><title>Image menu QA</title>
      <style>body{margin:24px;font:16px system-ui;background:#f4f4f3}img{width:320px;height:320px}iframe{display:block;width:380px;height:280px;border:0}#small{width:120px;height:120px}</style>
      ${request.url === "/frame" ? '<img id="framed" src="/image.png">' : '<h1>Image menu QA</h1><img id="first" src="/image.png"><img id="second" src="/image.png"><img id="small" src="/image.png"><iframe src="/frame"></iframe>'}`);
  });
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const work = mkdtempSync(join(tmpdir(), "maslingo-image-menu-"));
const extensionDir = join(work, "extension");
cpSync(join(root, "extension"), extensionDir, { recursive: true });
const output = resolve(process.env.MAS_SCREENSHOT_DIR || join(tmpdir(), "maslingo-image-menu-qa"));
mkdirSync(output, { recursive: true });
const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage",
  "--disable-features=DisableLoadExtensionCommandLineSwitch", `--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`] });
try {
  const worker = await (await browser.waitForTarget(target => target.type() === "service_worker")).worker();
  await worker.evaluate(async base => {
    await ensureImageMenu();
    await chrome.contextMenus.update(IMAGE_MENU_ID, { enabled: true });
    for (const id of ["deepseek", "google-free"]) {
      const provider = MAS_providers.byId(id);
      provider.adapter = request => ({ url: `${base}/translate`, init: { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ texts: request.texts }) } });
      provider.parse = json => json.translations;
    }
    await chrome.storage.local.set({ backendUrl: base, translationProvider: "deepseek", translationApiKey: "test-key",
      targetLanguage: "简体中文", autoTranslate: false, hoverTranslate: false, selectionTranslate: false });
  }, base);
  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 950 });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  image = Buffer.from(await page.evaluate(() => {
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = 500;
    const context = canvas.getContext("2d"); context.fillStyle = "white"; context.fillRect(0,0,500,500);
    context.fillStyle = "black"; context.font = "36px sans-serif"; context.fillText("Japanese fixture", 80, 140);
    return canvas.toDataURL().split(",")[1];
  }), "base64");
  await page.goto(`${base}/`, { waitUntil: "load" });
  await page.waitForSelector("#maslingo-panel");
  assert.equal(await page.title(), "Image menu QA");
  assert.equal(ocrCalls, 0, "Auto-off never scans any picture");
  const tabId = await worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url).id, `${base}/`);
  const invoke = (frameId = 0) => worker.evaluate(({ tabId, frameId, base }) => handleImageMenuClick(
    { menuItemId: IMAGE_MENU_ID, frameId, srcUrl: `${base}/image.png` }, { id: tabId }), { tabId, frameId, base });
  const rightClick = async (frame, selector) => { await frame.click(selector, { button: "right" }); await page.keyboard.press("Escape"); };
  const waitForIdle = () => page.waitForFunction(() => !document.querySelector(".maslingo-box"));

  await rightClick(page, "#second");
  assert.equal((await invoke()).ok, true);
  await page.waitForSelector(".maslingo-adjacent-translation"); await waitForIdle();
  assert.equal(ocrCalls, 1);
  assert.ok(await page.evaluate(() => {
    const marker = document.querySelector(".maslingo-caption-source").getBoundingClientRect();
    const second = document.getElementById("second").getBoundingClientRect();
    return marker.left >= second.left && marker.right <= second.right;
  }), "Same-URL duplicates still translate the exact right-clicked element");
  await page.screenshot({ path: join(output, "context-image.png") });
  await rightClick(page, "#second"); await invoke();
  await page.waitForFunction(() => document.querySelectorAll(".maslingo-adjacent-translation").length === 1);
  await page.waitForFunction(() => document.getElementById("maslingo-line-text").textContent.includes("翻译完成"));
  assert.equal(ocrCalls, 2, "Explicit retry performs a new recognition");

  const child = page.frames().find(frame => frame.url() === `${base}/frame`);
  await child.waitForSelector("#framed");
  const frames = await worker.evaluate(tabId => chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: () => location.pathname }), tabId);
  const childId = frames.find(frame => frame.result === "/frame").frameId;
  await rightClick(child, "#framed"); assert.equal((await invoke(childId)).ok, true);
  await child.waitForSelector(".maslingo-adjacent-translation");
  assert.equal(await page.$$eval(".maslingo-adjacent-translation", nodes => nodes.length), 1);

  await worker.evaluate(() => chrome.storage.local.set({ translationProvider: "google-free" }));
  await rightClick(page, "#small"); assert.equal((await invoke()).ok, true);
  await page.waitForFunction(() => document.querySelectorAll(".maslingo-adjacent-translation").length === 2);
  await waitForIdle();
  assert.equal((await worker.evaluate(() => chrome.storage.local.get("autoTranslate"))).autoTranslate, false);
  console.log("PASS exact duplicate image, repeat click, iframe, small image, non-AI provider and auto-off state");

  await rightClick(page, "#first");
  await page.$eval("#first", image => { image.src = "/other.png"; });
  const beforeStale = ocrCalls;
  const changed = await invoke();
  assert.equal(changed.ok, false); assert.ok(changed.error.includes("变化"));
  assert.equal(ocrCalls, beforeStale);
  await worker.evaluate(() => chrome.storage.local.set({ translationProvider: "none" }));
  await rightClick(page, "#small");
  assert.equal((await invoke()).ok, false);
  assert.equal(ocrCalls, beforeStale);

  failOcr = true;
  await worker.evaluate(() => chrome.storage.local.set({ translationProvider: "deepseek" }));
  const beforeFailure = ocrCalls;
  await rightClick(page, "#small"); await invoke();
  await page.waitForFunction(() => document.getElementById("maslingo-line-text").textContent.includes("图片翻译失败"));
  assert.equal(ocrCalls, beforeFailure + 2, "A missing backend has bounded retries and visible feedback");
  assert.deepEqual(errors, []);
  console.log("PASS changed image, disabled translation, bounded backend failures and no script errors");
} finally {
  await browser.close(); await new Promise(resolve => server.close(resolve));
  const checked = realpathSync(work), inside = relative(realpathSync(tmpdir()), checked);
  assert.ok(inside && !inside.startsWith("..") && basename(checked).startsWith("maslingo-image-menu-"));
  rmSync(checked, { recursive: true, force: true });
}
