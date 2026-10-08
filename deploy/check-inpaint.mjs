// Content-script rendering checks.
//
// Three things are verified here:
//  1. the cover is flat white exactly over the recognised box, and nothing
//     outside that box is touched — the user asked for a plain white block
//     rather than a reconstructed background, so that is what gets asserted;
//  2. the writing direction comes from the recogniser, not from the box's shape;
//  3. the translation never appears in a window of its own — it is painted over
//     the original text, and the only chrome the script adds is a small
//     self-dismissing status line.
//
//   node deploy/check-inpaint.mjs

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import puppeteer from "puppeteer";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Loaded in the same order as the manifest's content_scripts, because the files
// depend on each other at load time. Loading content.js alone leaves MAS_auto and
// MAS_panel undefined.
const contentScripts = [
  "extension/config.js", "extension/translation/providers.js",
  "extension/content/glass.js", "extension/content/overlay.js",
  "extension/content/auto.js", "extension/content/panel.js",
  "extension/content/content.js",
].map((name) => readFileSync(join(repoRoot, name), "utf8"));
// The stylesheets have to come along too, otherwise class-based assertions test
// nothing: an earlier run of this check passed the element into existence and
// then found it had no positioning at all. Same list and same order as the
// manifest, since window.css reads tokens defined in glass.css.
const contentStyles = [
  "glass", "window", "status", "marker", "page",
].map((name) => readFileSync(join(repoRoot, "extension", "content", "styles", `${name}.css`), "utf8")).join("\n");

const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const failures = [];
const check = (name, condition, detail = "") => {
  if (condition) {
    console.log(`  ok    ${name}`);
  } else {
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
    failures.push(name);
  }
};

try {
  const page = await browser.newPage();
  page.on("pageerror", (error) => failures.push(`page error: ${error.message}`));

  await page.setContent("<!doctype html><html><body></body></html>");
  await page.evaluate(() => {
    // Enough of the extension API for the content scripts to load and for the
    // panel to mount. Status text lives in the panel's strip now, so the panel
    // has to exist for the status assertions below to mean anything.
    globalThis.chrome = {
      runtime: {
        onMessage: { addListener() {} },
        getManifest: () => ({ version: "0.0.0-test" }),
        sendMessage: async () => ({ ok: false }),
      },
      storage: {
        local: { get: async () => ({}), set: async () => {} },
        onChanged: { addListener() {} },
      },
    };
  });
  await page.addStyleTag({ content: contentStyles });
  await page.addScriptTag({ content: contentScripts.join("\n;\n") });
  await page.evaluate(() => globalThis.MAS_panel.mount());
  await new Promise((r) => setTimeout(r, 400));

  // --- the cover ------------------------------------------------------------
  console.log("纯白覆盖");
  const cover = await page.evaluate(() => {
    const WIDTH = 240;
    const HEIGHT = 140;
    const canvas = document.createElement("canvas");
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    // Start from something unmistakably not white, so a stale canvas would show.
    context.fillStyle = "#3366cc";
    context.fillRect(0, 0, WIDTH, HEIGHT);

    const CORE = { left: 24, top: 16, right: 216, bottom: 124 };
    MAS_render.drawTranslatedPatch({
      canvas,
      context,
      patch: {
        core: {
          left: CORE.left / WIDTH,
          top: CORE.top / HEIGHT,
          width: (CORE.right - CORE.left) / WIDTH,
          height: (CORE.bottom - CORE.top) / HEIGHT,
        },
        rect: { width: WIDTH, height: HEIGHT },
      },
      direction: "horizontal",
    }, "测试译文覆盖");

    const pixels = context.getImageData(0, 0, WIDTH, HEIGHT).data;
    let whiteInside = 0;
    let artworkLeft = 0;
    let opaqueBeyond = 0;
    let darkInk = 0;
    let beyondBounds = null;
    for (let y = 0; y < HEIGHT; y += 1) {
      for (let x = 0; x < WIDTH; x += 1) {
        const offset = (y * WIDTH + x) * 4;
        const [r, g, b, a] = [pixels[offset], pixels[offset + 1], pixels[offset + 2], pixels[offset + 3]];
        const inside = x >= CORE.left && x < CORE.right && y >= CORE.top && y < CORE.bottom;
        if (inside) {
          if (a === 0) continue;
          if (r >= 240 && g >= 240 && b >= 240) whiteInside += 1;
          else if (r < 90 && g < 90 && b < 90) darkInk += 1;
          // Anti-aliased glyph edges are mid-grey and perfectly fine; what must
          // not survive is the artwork that was underneath.
          if (r === 51 && g === 102 && b === 204) artworkLeft += 1;
        } else if (a !== 0) {
          // Clipping happens on the box boundary, so a single row or column of
          // partially covered pixels is expected there. Anything further out is
          // a real leak onto the drawing.
          const beyond = (
            x < CORE.left - 1 || x > CORE.right || y < CORE.top - 1 || y > CORE.bottom
          );
          if (beyond) {
            opaqueBeyond += 1;
            beyondBounds = beyondBounds || [x, y, x, y];
            beyondBounds[0] = Math.min(beyondBounds[0], x);
            beyondBounds[1] = Math.min(beyondBounds[1], y);
            beyondBounds[2] = Math.max(beyondBounds[2], x);
            beyondBounds[3] = Math.max(beyondBounds[3], y);
          }
        }
      }
    }
    return { whiteInside, artworkLeft, opaqueBeyond, darkInk, beyondBounds };
  });

  // Everything inside the box is white, except the glyphs drawn on top of it.
  check("原图文字被完全盖住", cover.artworkLeft === 0, `${cover.artworkLeft} 个像素还是原图`);
  check("框内确实填了白", cover.whiteInside > 10000, `只有 ${cover.whiteInside} 个白像素`);
  check("译文画在了白底上", cover.darkInk > 100, `只有 ${cover.darkInk} 个深色像素`);
  // Nothing beyond: the artwork around the text must show through untouched.
  check("框外没有改动原图", cover.opaqueBeyond === 0,
    `${cover.opaqueBeyond} 个像素越界，范围 ${JSON.stringify(cover.beyondBounds)}`);

  // --- direction ------------------------------------------------------------
  console.log("\n横竖判定（后端优先）");
  const direction = await page.evaluate(() => ({
    backendSaysHorizontalOnTallBox: resolveTextDirection("horizontal", 120, 320),
    backendSaysVerticalOnWideBox: resolveTextDirection("vertical", 320, 120),
    fallbackTallBox: resolveTextDirection(null, 120, 320),
    fallbackWideBox: resolveTextDirection(null, 320, 120),
    fallbackUndefined: resolveTextDirection(undefined, 120, 320),
  }));
  check("后端说横排时，即使框很高也横排", direction.backendSaysHorizontalOnTallBox === false);
  check("后端说竖排时，即使框很宽也竖排", direction.backendSaysVerticalOnWideBox === true);
  check("后端没意见时才退回长宽比（高框→竖排）", direction.fallbackTallBox === true);
  check("后端没意见时才退回长宽比（宽框→横排）", direction.fallbackWideBox === false);
  check("字段缺失时也走退路", direction.fallbackUndefined === true);

  // --- the overlay must never become its own window -------------------------
  console.log("\n译文呈现方式");
  const overlay = await page.evaluate(() => {
    const out = {};
    out.noticeFunctionRemoved = typeof showTranslationNotice === "undefined";

    // Status goes to the panel's own bottom line; there is no second toast and
    // no floating strip any more, so that is what must behave.
    out.noToastElement = document.getElementById("mas-toast") === null;
    showToast("测试提示", "info");
    const panel = document.getElementById("mas-panel");
    const strip = document.getElementById("mas-status");
    // The message lives on the inner line element; the band around it is a
    // container and its textContent carries the markup's whitespace.
    const line = strip?.querySelector(".mas-status-text");
    out.stripCreated = Boolean(strip);
    out.stripText = line ? line.textContent : null;
    out.stripInsidePanel = Boolean(panel && strip && panel.contains(strip));
    out.stripSingleLine = line ? getComputedStyle(line).whiteSpace === "nowrap" : false;
    out.floatingSurfaces = [...document.documentElement.children]
      .filter((node) => node.id?.startsWith("mas-")).map((node) => node.id);

    activeRequestId = "check-1";
    showTranslationResult({ requestId: "check-1", mode: "none", result: {} });
    out.panelsAfterNone = document.querySelectorAll(".mas-overlay, .mas-overlay-status").length;
    out.canvasesAfterNone = document.querySelectorAll("canvas.mas-overlay-text-canvas").length;

    hideToast();
    return out;
  });

  check("旧的居中结果面板函数已移除", overlay.noticeFunctionRemoved);
  check("不再存在第二个提示元素", overlay.noToastElement);
  check("状态提示写在悬浮窗状态栏上", overlay.stripCreated && overlay.stripText === "测试提示",
    JSON.stringify({ text: overlay.stripText }));
  check("状态栏属于悬浮窗", overlay.stripInsidePanel);
  check("状态栏只有一行", overlay.stripSingleLine);
  check("页面上只有一个浮层", overlay.floatingSurfaces.length === 1,
    JSON.stringify(overlay.floatingSurfaces));
  check("关闭翻译时不留下任何面板", overlay.panelsAfterNone === 0, `还有 ${overlay.panelsAfterNone} 个`);
  check("关闭翻译时不留下覆盖画布", overlay.canvasesAfterNone === 0, `还有 ${overlay.canvasesAfterNone} 个`);
} finally {
  await browser.close();
}

if (failures.length) {
  console.error(`\n${failures.length} 项不合格：`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log("\n覆盖方式合格：文字区域是纯白，框外像素零改动");
