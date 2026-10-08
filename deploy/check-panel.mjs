// The in-page panel: does it exist, does it behave, and does it stay out of the
// way?
//
// The panel replaced the popup as the primary surface, so what matters is not
// just that the controls are there but that the thing is usable while reading:
// it can be dragged, it can be collapsed, it never covers the status strip, and
// it never blocks clicks on the page underneath.
//
//   node deploy/check-panel.mjs

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

// --- stubs ------------------------------------------------------------------

const ocrCalls = [];
const backend = http.createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ ok: true, backend: "stub" }));
    return;
  }
  if (request.url === "/api/recognize-page") {
    request.on("data", () => {});
    request.on("end", () => {
      ocrCalls.push(1);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        ok: true,
        items: [{
          text: "テスト", bbox: { left: 100, top: 100, right: 400, bottom: 300 },
          direction: "vertical", confidence: 0.95,
        }],
      }));
    });
    return;
  }
  response.writeHead(404).end();
});
await new Promise((done) => backend.listen(0, "127.0.0.1", done));
const backendUrl = `http://127.0.0.1:${backend.address().port}`;

// A deliberately large page, so "does not block the page" has something to test.
const pages = http.createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>panel</title>
    <style>
      body{margin:0;background:#2a2a2a;font:14px system-ui}
      #under{position:fixed;left:12px;bottom:12px;width:120px;height:40px;background:#c0503f;color:#fff}
      #page{width:600px;margin:0 auto;padding:16px 0}
      .block{height:700px;background:#e9e9e9;margin-bottom:12px}
    </style></head>
    <body>
      <div id="page"><div class="block">manga 1</div><div class="block">manga 2</div></div>
      <button id="under">页面自己的按钮</button>
    </body></html>`);
});
await new Promise((done) => pages.listen(0, "127.0.0.1", done));
const pageUrl = `http://127.0.0.1:${pages.address().port}/`;

const workDir = mkdtempSync(join(tmpdir(), "omt-panel-"));
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
  await worker.evaluate((url) => chrome.storage.local.set({
    backendUrl: url, autoTranslate: false, translationMode: "none", autoConcurrency: 1,
  }), backendUrl);

  const page = await browser.newPage();
  await page.setViewport({ width: 1000, height: 800 });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(pageUrl, { waitUntil: "load" });
  await new Promise((r) => setTimeout(r, 2500));

  console.log("\n悬浮窗结构与位置");
  const layout = await page.evaluate(() => {
    const panel = document.getElementById("omt-panel");
    if (!panel) return null;
    const rect = panel.getBoundingClientRect();
    const strip = document.getElementById("omt-status");
    const stripRect = strip?.getBoundingClientRect();
    const panelRect = rect;
    const dots = [...panel.querySelectorAll(".omt-dot")].map((dot) => {
      const box = dot.getBoundingClientRect();
      return { text: dot.querySelector(".omt-dot-text").textContent.trim(), top: box.top, left: box.left };
    });
    return {
      right: window.innerWidth - rect.right,
      bottom: window.innerHeight - rect.bottom,
      width: rect.width,
      glass: getComputedStyle(panel).backdropFilter || getComputedStyle(panel).webkitBackdropFilter,
      position: getComputedStyle(panel).position,
      pointerEvents: getComputedStyle(panel).pointerEvents,
      dots,
      hasAuto: Boolean(panel.querySelector("#omt-auto")),
      hasSelect: Boolean(panel.querySelector("#omt-select")),
      hasProvider: Boolean(panel.querySelector("#omt-provider")),
      hasConnect: Boolean(panel.querySelector("#omt-connect")),
      connectAfterSelect: (() => {
        const select = panel.querySelector("#omt-provider");
        const button = panel.querySelector("#omt-connect");
        return Boolean(select && button && select.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING);
      })(),
      line: panel.querySelector("#omt-line")?.textContent || "",
      hasSettings: Boolean(panel.querySelector("#omt-settings")),
      version: panel.querySelector("#omt-version")?.textContent || "",
      hasTerminal: Boolean(panel.querySelector("pre, .omt-terminal, .omt-log")),
      // The status line now lives inside the panel, so what matters is that it
      // is a child of it and single-line — not where it sits on the page.
      statusInsidePanel: Boolean(panel.querySelector("#omt-status")),
      statusLines: strip ? strip.textContent.split("\n").length : 0,
      statusWhiteSpace: strip ? getComputedStyle(strip).whiteSpace : null,
      statusText: strip?.textContent?.trim() || "",
      floatingSurfaces: [...document.documentElement.children]
        .filter((node) => node.id?.startsWith("omt-"))
        .map((node) => node.id),
    };
  });

  check("悬浮窗已挂载", Boolean(layout), "找不到 #omt-panel");
  // Sitting in the lower right; nothing is reserved below it any more, since the
  // status line moved inside the panel.
  check("停在右下角", layout.right < 40 && layout.bottom < 40,
    JSON.stringify({ right: layout.right, bottom: layout.bottom }));
  check("玻璃质感（backdrop-filter）", /blur/.test(layout.glass || ""), layout.glass);
  check("定位为 fixed", layout.position === "fixed");
  check("两个状态点横向排列", layout.dots.length === 2 && layout.dots[0].top === layout.dots[1].top,
    JSON.stringify(layout.dots));
  check("状态点是后端与翻译", layout.dots[0]?.text.includes("后端") && layout.dots[1]?.text.includes("翻译"),
    JSON.stringify(layout.dots.map((d) => d.text)));
  check("有自动识别开关", layout.hasAuto);
  check("有框选翻译按钮", layout.hasSelect);
  check("有翻译类型选择", layout.hasProvider);
  check("有连通检测按钮", layout.hasConnect);
  check("连通检测在选择框右侧", layout.connectAfterSelect);
  check("有一言区域", layout.line.startsWith("「") && layout.line.endsWith("」"), layout.line);
  check("有设置入口", layout.hasSettings);
  check("显示版本号", /^v\d+\.\d+\.\d+$/.test(layout.version), layout.version);
  check("面板内没有终端", !layout.hasTerminal);

  console.log("\n状态栏在悬浮窗内（不再有角落弹窗）");
  check("状态栏是悬浮窗的一部分", layout.statusInsidePanel);
  check("状态栏只有一行", layout.statusWhiteSpace === "nowrap" && layout.statusLines <= 1,
    `${layout.statusLines} 行 / ${layout.statusWhiteSpace}：「${layout.statusText}」`);
  check("页面上只剩悬浮窗一个浮层", layout.floatingSurfaces.length === 1,
    JSON.stringify(layout.floatingSurfaces));

  console.log("\n不阻塞页面操作");
  const passthrough = await page.evaluate(() => {
    // Away from the panel: the overlay must not blanket the page. Directly under
    // the panel it does of course cover things — that is what a floating panel
    // is, and the user can drag it or collapse it.
    const button = document.getElementById("under").getBoundingClientRect();
    const top = document.elementFromPoint(button.left + button.width / 2, button.top + button.height / 2);
    return {
      buttonReachable: top ? top.id === "under" || top.closest("#under") !== null : false,
      topId: top?.id || top?.className || top?.tagName,
    };
  });
  check("面板之外页面照常可点击", passthrough.buttonReachable, String(passthrough.topId));

  console.log("\n拖动");
  const dragged = await page.evaluate(async () => {
    const panel = document.getElementById("omt-panel");
    const bar = document.getElementById("omt-panel-bar");
    const before = panel.getBoundingClientRect();
    const startX = bar.getBoundingClientRect().left + 40;
    const startY = bar.getBoundingClientRect().top + 8;

    const send = (type, x, y) => window.dispatchEvent(new PointerEvent(type, {
      bubbles: true, clientX: x, clientY: y, button: 0, pointerId: 1,
    }));
    bar.dispatchEvent(new PointerEvent("pointerdown", {
      bubbles: true, clientX: startX, clientY: startY, button: 0, pointerId: 1,
    }));
    send("pointermove", startX - 200, startY - 150);
    send("pointerup", startX - 200, startY - 150);
    await new Promise((r) => requestAnimationFrame(r));
    const after = panel.getBoundingClientRect();
    return { movedX: Math.round(before.left - after.left), movedY: Math.round(before.top - after.top) };
  });
  check("可以拖动", dragged.movedX > 100 && dragged.movedY > 80, JSON.stringify(dragged));

  const clamped = await page.evaluate(async () => {
    const bar = document.getElementById("omt-panel-bar");
    const startX = bar.getBoundingClientRect().left + 10;
    const startY = bar.getBoundingClientRect().top + 8;
    bar.dispatchEvent(new PointerEvent("pointerdown", {
      bubbles: true, clientX: startX, clientY: startY, button: 0, pointerId: 1,
    }));
    for (const [x, y] of [[-500, -500], [5000, 5000]]) {
      window.dispatchEvent(new PointerEvent("pointermove", {
        bubbles: true, clientX: x, clientY: y, button: 0, pointerId: 1,
      }));
    }
    window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: 5000, clientY: 5000, pointerId: 1 }));
    await new Promise((r) => requestAnimationFrame(r));
    const rect = document.getElementById("omt-panel").getBoundingClientRect();
    return {
      left: Math.round(rect.left), top: Math.round(rect.top),
      right: Math.round(rect.right), bottom: Math.round(rect.bottom),
      vw: window.innerWidth, vh: window.innerHeight,
    };
  });
  check("拖不出可视区域",
    clamped.left >= 0 && clamped.top >= 0 && clamped.right <= clamped.vw && clamped.bottom <= clamped.vh,
    JSON.stringify(clamped));

  // Dragging into the corner keeps the whole panel on screen; the status line
  // travels with it, so there is nothing left to collide with.
  const corner = await page.evaluate(() => {
    const rect = document.getElementById("omt-panel").getBoundingClientRect();
    return {
      inside: rect.left >= 0 && rect.top >= 0
        && rect.right <= window.innerWidth && rect.bottom <= window.innerHeight,
      right: Math.round(window.innerWidth - rect.right),
      bottom: Math.round(window.innerHeight - rect.bottom),
    };
  });
  check("拖到角落后整体仍在可视区内", corner.inside, JSON.stringify(corner));

  console.log("\n收起为挂件（真实点击）");
  // A real mouse click, not element.click(). The collapse button sits inside the
  // drag handle, and the drag handler calls preventDefault() on pointerdown —
  // which suppresses the click that follows. element.click() dispatches straight
  // to the listener and sails past that, so the first version of this check
  // passed while the button did nothing for an actual user.
  const collapseBox = await page.evaluate(() => {
    const box = document.getElementById("omt-collapse").getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  });
  await page.mouse.click(collapseBox.x, collapseBox.y);
  await new Promise((r) => setTimeout(r, 400));

  const collapsed = await page.evaluate(() => {
    const panel = document.getElementById("omt-panel");
    const widget = document.getElementById("omt-widget");
    return {
      bodyVisible: getComputedStyle(panel.querySelector(".omt-panel-body")).display !== "none",
      widgetVisible: getComputedStyle(widget).display !== "none",
      text: widget.textContent.trim(),
      width: panel.getBoundingClientRect().width,
    };
  });
  check("点击收起按钮能收起", collapsed.bodyVisible === false,
    `主体仍可见（display 不是 none）`);
  check("收起后显示挂件", collapsed.widgetVisible === true);
  check("挂件只保留核心状态", collapsed.text.includes("自动翻译") && collapsed.width < 200,
    `${collapsed.text} / ${collapsed.width}px`);

  const widgetBox = await page.evaluate(() => {
    const box = document.getElementById("omt-widget").getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  });
  await page.mouse.click(widgetBox.x, widgetBox.y);
  await new Promise((r) => setTimeout(r, 400));
  const expandedAgain = await page.evaluate(() =>
    getComputedStyle(document.getElementById("omt-panel").querySelector(".omt-panel-body")).display !== "none");
  check("点击挂件能再次展开", expandedAgain === true);

  // The drag handle must still drag: the fix for the button cannot cost that.
  const stillDrags = await page.evaluate(async () => {
    const bar = document.getElementById("omt-panel-bar");
    const panel = document.getElementById("omt-panel");
    const before = panel.getBoundingClientRect().left;
    const box = bar.getBoundingClientRect();
    const x = box.left + 20;
    const y = box.top + box.height / 2;
    bar.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: x, clientY: y, button: 0, pointerId: 3 }));
    window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: x - 120, clientY: y, button: 0, pointerId: 3 }));
    window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: x - 120, clientY: y, pointerId: 3 }));
    await new Promise((r) => requestAnimationFrame(r));
    return Math.round(before - panel.getBoundingClientRect().left);
  });
  check("拖拽仍然可用", stillDrags > 60, `只移动了 ${stillDrags}px`);

  console.log("\n状态栏显示自动识别的进度");
  await worker.evaluate(() => chrome.storage.local.set({ autoTranslate: true }));
  // Sampled early and then again later: the line is meant to show progress and
  // then fall back to idle, so both halves of that are worth pinning down. The
  // first version read it once at 4s, exactly when the dwell expires.
  const sample = async () => page.evaluate(() => {
    const strip = document.getElementById("omt-status");
    const panel = document.getElementById("omt-panel");
    return {
      text: strip.textContent.trim(),
      active: strip.classList.contains("omt-statusbar-active"),
      insidePanel: panel.contains(strip),
    };
  });

  let progress = await sample();
  for (let attempt = 0; attempt < 15 && !progress.active; attempt += 1) {
    await new Promise((r) => setTimeout(r, 200));
    progress = await sample();
  }
  const afterToggle = ocrCalls.length;
  console.log(`      状态：「${progress.text}」`);

  await new Promise((r) => setTimeout(r, 5000));
  const settled = await sample();

  check("自动识别产生了状态文字", progress.text.length > 0, progress.text);
  check("状态文字只在一行", !progress.text.includes("\n"));
  check("状态栏仍然属于悬浮窗", progress.insidePanel === true);
  check("有进度时状态栏高亮", progress.active === true, `读到「${progress.text}」`);
  check("进度结束后回到就绪", settled.active === false && settled.text === "就绪",
    `停在「${settled.text}」`);

  console.log("\n状态点反映真实连通性");
  // The backend is reachable only through the service worker: a content script
  // is bound by the page's origin and cannot reach another host, so this also
  // guards against the check silently failing for everyone.
  await new Promise((r) => setTimeout(r, 2000));
  const dots = await page.evaluate(() => {
    const read = (id) => {
      const node = document.getElementById(id);
      return { state: node.dataset.state, text: node.querySelector(".omt-dot-text").textContent.trim() };
    };
    return { backend: read("omt-dot-backend"), translation: read("omt-dot-translation") };
  });
  console.log(`      后端：${dots.backend.text}（${dots.backend.state}）  翻译：${dots.translation.text}（${dots.translation.state}）`);
  check("后端检测为正常", dots.backend.state === "ok", JSON.stringify(dots.backend));
  check("未选翻译来源时报告失败", dots.translation.state === "bad", JSON.stringify(dots.translation));

  console.log("\n页面无脚本错误");
  check("页面无脚本错误", errors.length === 0, errors.slice(0, 2).join(" | "));
  if (afterToggle === 0) console.log("      （本页没有可识别的图片，OCR 未触发，属正常）");

  // A picture of it, so the glass and the layout can be looked at rather than
  // inferred from computed styles.
  try {
    const shotDir = resolve(repoRoot, "deploy", "screenshots");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(shotDir, { recursive: true });
    await page.screenshot({ path: join(shotDir, "panel.png") });
    console.log(`      截图：deploy/screenshots/panel.png`);
  } catch (error) {
    console.log(`      截图失败：${error.message}`);
  }
} finally {
  await browser.close();
  backend.close();
  pages.close();
  rmSync(workDir, { recursive: true, force: true });
}

if (failures.length) {
  console.log(`\n${failures.length} 项失败`);
  process.exit(1);
}
console.log("\n悬浮窗行为符合预期");
