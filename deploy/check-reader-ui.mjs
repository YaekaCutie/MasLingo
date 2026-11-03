// Production UI and bridge in Chromium, with deterministic Chrome API transport.
// Native sidePanel.open and installation are covered by check-extension-browser.
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, join, extname } from "node:path";
import http from "node:http";
import vm from "node:vm";
import puppeteer from "puppeteer";
const root = resolve("extension"),
  out = process.env.MAS_SCREENSHOT_DIR;
if (out) mkdirSync(out, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const event = () => ({
  listeners: [],
  addListener(fn) {
    this.listeners.push(fn);
  },
  emit(...args) {
    return this.listeners.map((fn) => fn(...args));
  },
});
const article = `<!doctype html><meta charset="utf-8"><style>
body{font:18px/1.7 system-ui;margin:40px;max-width:700px}p{margin:24px 0}
#player-wrapper{position:relative;width:600px;max-width:100%;height:300px;overflow:hidden}
#movie_player{position:absolute;inset:0}video{display:block;width:100%;height:100%;background:#18212f}
.ytp-caption-window-container{position:absolute;bottom:0;color:white}input{font:inherit;width:500px}
</style><article><h1>Reading with MasLingo</h1><p id="source">Proteins perform diverse functions in living organisms.</p><p id="word">The protein structure reveals how molecules interact.</p><input id="input" value="Hello world"><div id="player-wrapper"><div id="movie_player"><video></video><div class="ytp-caption-window-container">Hello everyone.</div></div></div><p id="after-video">This paragraph must remain below the video controls.</p></article>`;
const server = http.createServer((req, res) => {
  if (req.url === "/article") {
    res.setHeader("Content-Type", "text/html;charset=utf-8");
    res.end(article);
    return;
  }
  const file = join(root, decodeURIComponent(req.url.split("?")[0]));
  if (!file.startsWith(root) || !existsSync(file)) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.setHeader(
    "Content-Type",
    {
      ".html": "text/html;charset=utf-8",
      ".css": "text/css",
      ".js": "text/javascript",
    }[extname(file)] || "text/plain",
  );
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/`;
const browser = await puppeteer.launch({
  headless: true,
  executablePath: process.env.CHROME_BIN || undefined,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const errors = [],
  pages = [],
  ports = new Map(),
  calls = [],
  opened = [];
let source, reader;
let failTranslation = false;
const cfg = {
  translationProvider: "deepseek",
  translationMode: "openai-compatible",
  translationApiKey: "fixture-saved-key",
  targetLanguage: "简体中文",
  translationGlossary: "general",
  hoverTranslate: true,
  selectionTranslate: true,
  inputAutoReplace: true,
  autoTranslate: false,
  webAutoTranslate: false,
  videoDisplayMode: "bilingual",
};
const bg = {
  runtime: {
    getURL: (path) => base + path,
    onMessage: event(),
    onConnect: event(),
  },
  tabs: {
    get: async (id) => ({ id }),
    sendMessage: async (id, message) => {
      if (id !== 1) throw Error("No tab");
      return source.evaluate((message) => {
        let result;
        for (const fn of messageListeners)
          fn(message, {}, (value) => {
            result = value;
          });
        return result;
      }, message);
    },
    onRemoved: event(),
    onUpdated: event(),
  },
};
vm.runInNewContext(readFileSync(join(root, "background/reader.js"), "utf8"), {
  chrome: bg,
  console,
});
async function createPage(kind) {
  console.log("Open", kind);
  const page = await browser.newPage();
  pages.push(page);
  const waitForFunction = page.waitForFunction.bind(page);
  page.waitForFunction = (fn, options = {}, ...args) =>
    waitForFunction(fn, { polling: 100, ...options }, ...args);
  for (const method of ["click", "hover", "select"]) {
    const original = page[method].bind(page);
    page[method] = async (...args) => {
      await page.bringToFront();
      return original(...args);
    };
  }
  page.on("pageerror", (e) => {
    errors.push(`${kind}: ${e.message}`);
    console.error(errors.at(-1));
  });
  await page.exposeFunction("__readConfig", () => ({ ...cfg }));
  await page.exposeFunction("__saveConfig", async (update) => {
    const changes = Object.fromEntries(
      Object.entries(update).map(([k, v]) => [
        k,
        { oldValue: cfg[k], newValue: v },
      ]),
    );
    Object.assign(cfg, update);
    await Promise.all(
      pages
        .filter((p) => !p.isClosed())
        .map((p) =>
          p.evaluate(
            (changes) => storageListeners.forEach((fn) => fn(changes, "local")),
            changes,
          ),
        ),
    );
  });
  await page.exposeFunction("__message", async (message) => {
    calls.push(message);
    if (message.type.startsWith("READER_")) {
      let response;
      bg.runtime.onMessage.emit(
        message,
        { tab: { id: 1 }, frameId: 0, url: base + "article" },
        (value) => (response = value),
      );
      return response;
    }
    if (message.type === "TRANSLATE_TEXT_BLOCKS" && failTranslation)
      return { ok: false, reason: "fixture network failure" };
    if (message.type === "TRANSLATE_TEXT_BLOCKS")
      return {
        ok: true,
        translations: message.texts.map(
          (t) =>
            ({
              "Proteins perform diverse functions in living organisms.":
                "蛋白质在生物体中承担多种功能。",
              protein: "蛋白质",
              Hello: "你好",
              "Hello everyone.": "大家好。",
              "A failed translation can be retried.": "失败的翻译可以重试。",
            })[t] || t,
        ),
        skipped: message.texts.map(() => false),
      };
    if (message.type === "LOOKUP_WORD")
      return message.word
        ? {
            ok: true,
            kind: "dictionary",
            target: message.target,
            entry: {
              word: message.text,
              reading: "protein",
              senses: [
                { pos: "名词", meaning: "食物中的蛋白质", example: "Eggs contain protein." },
                {
                  pos: "名词",
                  meaning: "蛋白质",
                  example: "A protein structure.",
                  exampleTranslation: "蛋白质结构。",
                },
              ],
              contextSense: 2,
            },
          }
        : { ok: true, kind: "text", translation: "这是选中句子的译文。" };
    if (message.type === "CHECK_BACKEND") return { ok: true };
    if (message.type === "TEST_TRANSLATION")
      return { ok: true, text: "早上好", translation: "早上好" };
    return { ok: true, enabled: false };
  });
  await page.exposeFunction("__tabMessage", (_id, message) =>
    bg.tabs.sendMessage(1, message),
  );
  await page.exposeFunction("__portConnect", () => {
    const port = {
      name: "maslingo-reader",
      sender: { url: base + "reader/reader.html" },
      onMessage: event(),
      onDisconnect: event(),
      postMessage: (message) => {
        page
          .evaluate(
            (message) => portListeners.forEach((fn) => fn(message)),
            message,
          )
          .catch(() => {});
      },
    };
    ports.set(page, port);
    bg.runtime.onConnect.emit(port);
  });
  await page.exposeFunction("__portSend", async (message) => {
    await Promise.all(ports.get(page).onMessage.emit(message));
  });
  await page.exposeFunction("__open", (options) => opened.push(options));
  await page.evaluateOnNewDocument(() => {
    globalThis.storageListeners = [];
    globalThis.messageListeners = [];
    globalThis.portListeners = [];
    globalThis.chrome = {
      runtime: {
        getURL: (path) => location.origin + "/" + path,
        getManifest: () => ({ version: "1.1.8" }),
        openOptionsPage: async () => {},
        sendMessage: __message,
        onMessage: { addListener: (fn) => messageListeners.push(fn) },
        connect: () => {
          const ready = __portConnect();
          return {
            onMessage: { addListener: (fn) => portListeners.push(fn) },
            onDisconnect: { addListener() {} },
            postMessage: (m) => ready.then(() => __portSend(m)),
          };
        },
      },
      storage: {
        local: { get: __readConfig, set: __saveConfig },
        onChanged: { addListener: (fn) => storageListeners.push(fn) },
      },
      tabs: {
        query: async () => [{ id: 1, url: location.origin + "/article" }],
        sendMessage: __tabMessage,
        onActivated: { addListener() {} },
      },
      windows: { getCurrent: async () => ({ id: 1 }) },
      sidePanel: { open: __open },
      permissions: { contains: async () => true, request: async () => true },
    };
  });
  return page;
}
const screenshot = async (page, name) => {
  if (out) {
    await page.bringToFront();
    await wait(250);
    await page.screenshot({ path: join(out, name), fullPage: true });
  }
};
try {
  source = await createPage("source");
  await source.setViewport({ width: 960, height: 900 });
  await source.goto(base + "article");
  console.log("Load source scripts");
  for (const file of [
    "config.js",
    "translation/providers.js",
    "content/reader-bridge.js",
    "content/quick-toolbar.js",
    "content/text-translate.js",
    "content/selection-translate.js",
    "content/video-translate.js",
  ]) {
    console.log("Script", file);
    await source.addScriptTag({ url: base + file });
  }
  reader = await createPage("reader");
  await reader.setViewport({ width: 360, height: 1000 });
  await reader.goto(base + "reader/reader.html");
  await reader.waitForFunction(
    () => document.querySelector("#translationProvider").value === "deepseek",
  );
  assert.equal(
    await reader.$eval("#targetLanguage", (e) => e.value),
    "简体中文",
  );
  await source.hover("#source");
  await reader.waitForFunction(() =>
    document.querySelector("#results").textContent.includes("蛋白质在生物体"),
  );
  assert.equal(await reader.$eval("#current-results", (panel) => panel.open), false,
    "incoming results do not expand the initially collapsed history");
  assert.equal(await reader.$eval("#result-count", (badge) => badge.textContent), "1");
  await reader.click("#current-results > summary");
  assert.equal(
    await source.$eval(
      "#source + [data-maslingo-textbox]",
      (e) => getComputedStyle(e).display,
    ),
    "block",
  );
  await source.mouse.move(1, 1);
  await wait(600);
  assert.equal(
    await source.$eval("#source + [data-maslingo-textbox]", (host) => getComputedStyle(host).display),
    "block",
    "inline result persists when leaving source",
  );
  assert.ok(
    await reader.$eval("#results", (e) =>
      e.textContent.includes("蛋白质在生物体"),
    ),
    "result persists when leaving source",
  );
  await screenshot(reader, "reader-paragraph.png");
  await screenshot(source, "article.png");
  await reader.click(".result-actions button");
  await wait(100);
  // A stale document action cannot reach a new frame's source controls.
  await new Promise((done) => {
    const p = ports.get(reader);
    const save = p.postMessage;
    p.postMessage = (m) => {
      save(m);
      done();
    };
    p.onMessage.emit({ type: "subscribe", tabId: 1 });
  });
  let stale;
  bg.runtime.onMessage.emit(
    { type: "READER_RESULT", document: "stale", id: "x", tree: [] },
    { tab: { id: 1 }, frameId: 0 },
    (r) => (stale = r),
  );
  assert.equal(stale.ok, false);
  // Dismiss then hover the same source remounts cleanly.
  await reader.click(".result-bar button");
  await reader.waitForFunction(() => !document.querySelector(".result"));
  await source.hover("#source");
  await reader.waitForSelector(".result");
  await source.evaluate(() => {
    const n = document.querySelector("#word").firstChild,
      r = document.createRange();
    r.setStart(n, 4);
    r.setEnd(n, 11);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
  await reader.waitForFunction(() =>
    document.querySelector("#results").textContent.includes("蛋白质"),
  );
  await source.bringToFront();
  await source.waitForFunction(() => {
    const popup = document.querySelector("#maslingo-selection-popup");
    const root = popup?.shadowRoot;
    return popup && getComputedStyle(popup).visibility === "visible" &&
      root.querySelectorAll(".sense .pos").length === 2 &&
      root.querySelector(".sense.is-context .num")?.textContent === "2" &&
      root.querySelector(".sense.is-context .example");
  });
  assert.ok(await source.$eval("#maslingo-selection-popup", (popup) => {
    const bounds = popup.getBoundingClientRect();
    const selection = getSelection().getRangeAt(0).getBoundingClientRect();
    return bounds.left >= 0 && bounds.right <= innerWidth && bounds.top >= 0 &&
      bounds.bottom <= innerHeight && (bounds.top >= selection.bottom || bounds.bottom <= selection.top);
  }), "dictionary popup fits the viewport and avoids the selected word");
  await screenshot(source, "selection-dictionary-popup.png");
  await source.setViewport({ width: 390, height: 844 });
  await source.waitForFunction(() => {
    const popup = document.querySelector("#maslingo-selection-popup");
    const bounds = popup.getBoundingClientRect();
    return getComputedStyle(popup).visibility === "visible" && bounds.right <= innerWidth &&
      bounds.top >= 0 && bounds.bottom <= innerHeight;
  });
  await source.setViewport({ width: 960, height: 900 });
  await screenshot(reader, "reader-dictionary.png");
  await source.bringToFront();
  // Context controls default to a small, out-of-flow trigger.
  assert.equal(
    await source.$eval("[data-maslingo-quick]", (e) => e.dataset.expanded),
    "false",
  );
  assert.ok(
    await source.$eval(
      "[data-maslingo-quick]",
      (e) => e.getBoundingClientRect().height <= 24,
    ),
  );
  await source.waitForFunction(() => {
      const r = document.createRange();
      r.selectNodeContents(document.querySelector("#word"));
      const text = [...r.getClientRects()].at(-1),
        button = document
          .querySelector("[data-maslingo-quick]")
          .getBoundingClientRect();
      return button.left >= text.right || button.right <= text.left;
  });
  await screenshot(source, "selection-collapsed.png");
  const expandQuick = async () => {
    await source.bringToFront();
    if (
      await source.$eval(
        "[data-maslingo-quick]",
        (e) => e.dataset.expanded === "false",
      )
    ) {
      const handle = await source.evaluateHandle(() =>
        document
          .querySelector("[data-maslingo-quick]")
          .shadowRoot.querySelector(".mini"),
      );
      await handle.asElement().click();
    }
  };
  const openParagraphQuick = async (selector) => {
    await source.bringToFront();
    const button = await source.waitForFunction((selector) => {
      const text = document.querySelector(selector).textContent.trim().slice(0, 40);
      const label = `展开「${text}」的翻译操作`;
      for (const host of document.querySelectorAll("[data-maslingo-quick-badge]")) {
        const button = host.shadowRoot.querySelector(".mini");
        if (button.getAttribute("aria-label") === label && getComputedStyle(host).visibility === "visible") return button;
      }
      return null;
    }, {}, selector);
    await button.asElement().click();
  };
  // Context controls work on the saved selection, without opening settings.
  const quickSelect = async (selector, value) => {
    await expandQuick();
    await source.evaluate(
      ({ selector, value }) => {
        const e = document
          .querySelector("[data-maslingo-quick]")
          .shadowRoot.querySelector(selector);
        e.value = value;
        e.dispatchEvent(new Event("change", { bubbles: true }));
      },
      { selector, value },
    );
  };
  const quickClick = async (selector) => {
    await expandQuick();
    const h = await source.evaluateHandle(
      (selector) =>
        document
          .querySelector("[data-maslingo-quick]")
          .shadowRoot.querySelector(selector),
      selector,
    );
    await h.asElement().click();
  };
  await source.waitForSelector("[data-maslingo-quick]");
  const originalWord = await source.$eval("#word", (e) => e.innerHTML);
  await quickClick(".cover");
  await source.waitForFunction(
    () =>
      document.querySelector("#word [data-maslingo-cover]")?.textContent ===
      "蛋白质",
  );
  await source.evaluate(() => MAS_quick.hide());
  await source.hover("#word [data-maslingo-cover]");
  await source.waitForSelector("[data-maslingo-quick]");
  await quickClick(".cover");
  assert.equal(
    await source.$eval("#word", (e) => e.innerHTML),
    originalWord,
    "selection restore preserves exact source markup",
  );
  await quickSelect(".lang", "English");
  await reader.waitForFunction(() =>
    document.querySelector("#results .meta")?.textContent.includes("English"),
  );
  assert.ok(
    calls.some((c) => c.type === "LOOKUP_WORD" && c.target === "English"),
    "selection target reaches the worker",
  );
  await quickSelect(".src", "日本語");
  await wait(150);
  assert.ok(
    calls.some((c) => c.type === "LOOKUP_WORD" && c.source === "日本語"),
    "selection source reaches the worker",
  );
  await quickSelect(".provider", "google-free");
  await reader.waitForFunction(() =>
    document.querySelector("#results").textContent.includes("蛋白质"),
  );
  assert.ok(
    calls.some(
      (c) => c.type === "TRANSLATE_TEXT_BLOCKS" && c.provider === "google-free",
    ),
    "selection switches to a non-dictionary provider",
  );
  await screenshot(source, "selection-context-toolbar.png");
  await source.evaluate(() => {
    MAS_selection.close();
    getSelection().removeAllRanges();
  });
  await source.mouse.move(1, 1);
  await openParagraphQuick("#source");
  await quickClick(".cover");
  await source.waitForFunction(() =>
    document.querySelector("#source [data-maslingo-cover]"),
  );
  await quickClick(".cover");
  assert.equal(
    await source.$eval("#source", (e) => e.textContent),
    "Proteins perform diverse functions in living organisms.",
  );
  await quickSelect(".lang", "日本語");
  await wait(150);
  assert.ok(
    calls.some(
      (c) => c.type === "TRANSLATE_TEXT_BLOCKS" && c.target === "日本語",
    ),
    "paragraph target applies immediately",
  );
  await screenshot(source, "paragraph-context-toolbar.png");
  assert.ok(
    await source.evaluate(
      () =>
        !document
          .querySelector("[data-maslingo-quick]")
          .shadowRoot.querySelector(".preview")
          .textContent.startsWith("译文："),
    ),
  );
  const nextTop = await source.$eval(
    "#word",
    (e) => e.getBoundingClientRect().top,
  );
  await quickClick(".close");
  assert.equal(await source.$("[data-maslingo-quick]"), null);
  assert.ok(
    (await source.$eval("#word", (e) => e.getBoundingClientRect().top)) <
      nextTop,
    "collapsed trigger reserves no row",
  );
  await screenshot(source, "paragraph-collapsed.png");
  await openParagraphQuick("#source");
  await source.setViewport({ width: 390, height: 844 });
  await screenshot(source, "context-toolbar-narrow.png");
  await quickClick(".close");
  await screenshot(source, "collapsed-narrow.png");
  await openParagraphQuick("#source");
  assert.ok(
    await source.evaluate(
      () =>
        document.querySelector("[data-maslingo-quick]").getBoundingClientRect()
          .right <= innerWidth,
    ),
    "toolbar fits narrow viewport",
  );
  await source.setViewport({ width: 960, height: 900 });
  await quickSelect(".lang", "简体中文");
  // A native retry remains usable and receives its result while focused.
  await source.evaluate(() => getSelection().removeAllRanges());
  failTranslation = true;
  await source.$eval(
    "#source",
    (e) => (e.textContent = "A failed translation can be retried."),
  );
  await source.bringToFront();
  await source.mouse.move(1, 1);
  await source.hover("#source");
  await reader.waitForFunction(() =>
    document
      .querySelector("#results")
      .textContent.includes("fixture network failure"),
  );
  failTranslation = false;
  await reader.evaluate(() =>
    [...document.querySelectorAll("#results .retry")]
      .find((e) => e.offsetParent)
      .focus(),
  );
  await reader.evaluate(() =>
    [...document.querySelectorAll("#results .retry")]
      .find((e) => e.offsetParent)
      .click(),
  );
  await reader.waitForFunction(() =>
    document
      .querySelector("#results")
      .textContent.includes("失败的翻译可以重试。"),
  );
  // Input auto replacement and remote undo still operate on the actual control.
  await source.$eval("#input", (e) => {
    e.focus();
    e.setSelectionRange(0, 5);
    e.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
  await source.waitForFunction(() =>
    document.querySelector("#input").value.startsWith("你好"),
  );
  await reader.waitForFunction(() =>
    [...document.querySelectorAll("#results button")].some((b) =>
      b.textContent.includes("撤销"),
    ),
  );
  await reader.evaluate(() =>
    [...document.querySelectorAll("#results button")]
      .find((b) => b.textContent.includes("撤销"))
      .click(),
  );
  await source.waitForFunction(
    () => document.querySelector("#input").value === "Hello world",
  );
  // A second tab has an independent transient history.
  await reader.evaluate(() =>
    portListeners.forEach((fn) =>
      fn({ type: "READER_STATE", tabId: 2, rows: [], status: "other tab" }),
    ),
  );
  assert.ok(await reader.$(".result"), "another tab snapshot is ignored");
  await reader.click("#clear");
  await reader.waitForFunction(() => !document.querySelector(".result"));
  await reader.click("#setup-tab");
  await reader.select("#translationGlossary", "medical");
  assert.equal(cfg.translationGlossary, "medical");
  await reader.select("#translationProvider", "google-free");
  await reader.waitForFunction(
    () => document.querySelector("#selectionTranslate").disabled,
  );
  await reader.select("#translationProvider", "deepseek");
  await reader.click("#read-tab");
  await reader.setViewport({ width: 280, height: 780 });
  assert.ok(
    await reader.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    "reader fits 280px",
  );
  await screenshot(reader, "reader-narrow.png");
  await reader.emulateMediaFeatures([
    { name: "prefers-reduced-motion", value: "reduce" },
  ]);
  assert.equal(
    await reader.$eval(
      ".video-section",
      (e) => getComputedStyle(e).animationName,
    ),
    "none",
  );
  await reader.setViewport({ width: 360, height: 1000 });
  await reader.emulateMediaFeatures([]);
  // Video controls reserve their own space; starting still needs an explicit click.
  await source.waitForSelector("[data-maslingo-video]");
  await wait(200);
  assert.ok(await source.$eval("[data-maslingo-video]", (panel) => {
    const wrapper = document.querySelector("#player-wrapper");
    return panel.previousElementSibling === wrapper &&
      panel.getBoundingClientRect().top >= wrapper.getBoundingClientRect().bottom;
  }), "subtitle controls are outside the clipped player and below its picture");
  assert.ok(
    await source.evaluate(
      () =>
        document.querySelector("#after-video").getBoundingClientRect().top >=
        document.querySelector("[data-maslingo-video]").getBoundingClientRect()
          .bottom,
    ),
  );
  const count = calls.filter((c) => c.type === "TRANSLATE_TEXT_BLOCKS").length;
  await wait(200);
  assert.equal(
    calls.filter((c) => c.type === "TRANSLATE_TEXT_BLOCKS").length,
    count,
    "video makes no requests before start",
  );
  await source.evaluate(() =>
    document
      .querySelector("[data-maslingo-video]")
      .shadowRoot.querySelector(".start")
      .click(),
  );
  await source.waitForFunction(() =>
    document
      .querySelector("[data-maslingo-video]")
      .shadowRoot.querySelector(".caption")
      .textContent.includes("大家好。"),
  );
  await screenshot(source, "video-below-picture.png");
  await source.evaluate(() =>
    document
      .querySelector("[data-maslingo-video]")
      .shadowRoot.querySelector(".start")
      .click(),
  );
  assert.equal(
    await source.$eval(
      ".ytp-caption-window-container",
      (e) => e.style.visibility,
    ),
    "",
    "stopping restores source captions",
  );
  // Automatic reading exposes contextual controls even with hover disabled.
  await source.bringToFront();
  failTranslation = true;
  await source.evaluate(() =>
    chrome.storage.local.set({ hoverTranslate: false, webAutoTranslate: true }),
  );
  await source.waitForFunction(() =>
    document.querySelector('#source + [data-maslingo-textbox][data-mode="auto"]')
      ?.shadowRoot.querySelector(".text").dataset.state === "error",
  );
  assert.ok(
    await source.$eval('#source + [data-maslingo-textbox]', (host) =>
      [".head", ".foot"].every(
        (selector) => getComputedStyle(host.shadowRoot.querySelector(selector)).display === "none",
      ),
    ),
    "automatic results show no legacy controls even after a translation failure",
  );
  await source.mouse.move(1, 1);
  await source.waitForFunction(() =>
    [...document.querySelectorAll("[data-maslingo-quick-badge]")].filter(
      (badge) => getComputedStyle(badge).visibility === "visible",
    ).length >= 2,
  );
  await openParagraphQuick("#word");
  await source.mouse.click(1, 1);
  assert.equal(await source.$("[data-maslingo-quick]"), null, "outside click closes only the open toolbar");
  await openParagraphQuick("#source");
  assert.ok(
    await source.evaluate(
      () =>
        !!document
          .querySelector("[data-maslingo-quick]")
          .shadowRoot.querySelector(".cover"),
    ),
    "auto-only reading has local cover control",
  );
  await expandQuick();
  await quickClick(".close");
  await openParagraphQuick("#source");
  assert.ok(
    await source.$eval("[data-maslingo-quick]", (host) => {
      const root = host.shadowRoot;
      return host.dataset.expanded === "true" &&
        root.querySelector('[role="toolbar"] .provider') !== null &&
        !root.querySelector(".retry").hidden;
    }),
    "reopening 译 restores the shared toolbar with the current retry action",
  );
  await screenshot(source, "auto-toolbar-reopened.png");
  failTranslation = false;
  await quickClick(".retry");
  await source.waitForFunction(() =>
    [...document.querySelectorAll('[data-maslingo-textbox][data-mode="auto"]')].some(
      (host) => host.shadowRoot.querySelector(".text").textContent === "失败的翻译可以重试。",
    ),
  );
  await source.evaluate(() =>
    chrome.storage.local.set({ hoverTranslate: true, webAutoTranslate: false }),
  );
  const options = await createPage("options");
  await options.setViewport({ width: 1100, height: 1000 });
  await options.goto(base + "options/options.html");
  await options.waitForFunction(
    () => document.querySelector("#translationProvider").value === "deepseek",
  );
  assert.equal(
    await options.$eval("#translationApiKey", (e) => e.value),
    "",
    "saved key is not painted in settings",
  );
  await screenshot(options, "settings-desktop.png");
  await options.click('a[href="#providers"]');
  await options.select("#translationStrength", "2");
  await reader.click("#inputAutoReplace");
  await options.waitForFunction(() => !document.querySelector("#inputAutoReplace").checked);
  assert.equal(await options.$eval("#translationStrength", (control) => control.value), "2",
    "sidebar updates leave unrelated options drafts intact");
  await reader.click("#setup-tab");
  await reader.select("#targetLanguage", "English");
  await options.waitForFunction(() => document.querySelector("#targetLanguage").value === "English");
  await screenshot(options, "settings-providers.png");
  await options.click("#save");
  await wait(250);
  assert.equal(
    cfg.translationApiKey,
    "fixture-saved-key",
    "saving layout settings preserves credentials",
  );
  assert.equal(cfg.translationStrength, 2);
  assert.equal(cfg.inputAutoReplace, false, "saving a draft does not overwrite the sidebar switch");
  assert.equal(cfg.targetLanguage, "English", "saving a draft does not overwrite the sidebar language");
  await options.click('a[href="#reading"]');
  await options.click("#inputAutoReplace");
  await options.click("#save");
  await reader.waitForFunction(() => document.querySelector("#inputAutoReplace").checked);
  await reader.click("#read-tab");
  await reader.click("#current-results > summary");
  assert.equal(await reader.$eval("#current-results", (panel) => panel.open), false);
  await screenshot(reader, "reader-collapsed-results.png");
  await options.setViewport({ width: 390, height: 844 });
  assert.ok(
    await options.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    "settings fit mobile width",
  );
  await screenshot(options, "settings-narrow.png");
  const popup = await createPage("popup");
  await popup.setViewport({ width: 330, height: 800 });
  await popup.goto(base + "popup/popup.html");
  await popup.waitForFunction(
    () => !document.querySelector("#openReader").disabled,
  );
  await screenshot(popup, "popup.png");
  await popup.click("#openReader");
  assert.deepEqual(
    opened.at(-1),
    { tabId: 1 },
    "popup opens the native side panel for the active tab",
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: sidebar source routing, dismissal/remount, dictionary, remote undo, tab isolation, preferences, key preservation, video flow, narrow layouts, reduced motion, popup entry",
  );
} finally {
  await browser.close();
  server.close();
}
