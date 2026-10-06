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
      #under{position:fixed;right:12px;bottom:12px;width:120px;height:40px;background:#c0503f;color:#fff}
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
    const strip = document.getElementById("omt-status");
    if (!panel) return null;
    const rect = panel.getBoundingClientRect();
    const stripRect = strip?.getBoundingClientRect();
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
      stripBottom: stripRect ? window.innerHeight - stripRect.bottom : null,
      stripLines: strip ? strip.textContent.split("\n").length : 0,
      stripWhiteSpace: strip ? getComputedStyle(strip).whiteSpace : null,
    };
  });

  check("悬浮窗已挂载", Boolean(layout), "找不到 #omt-panel");
  check("位于右下角偏上", layout.right < 40 && layout.bottom > 40, JSON.stringify({ right: layout.right, bottom: layout.bottom }));
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
  check("面板不与状态弹窗重叠", layout.bottom > layout.stripBottom + 8,
    JSON.stringify({ panelBottom: layout.bottom, stripBottom: layout.stripBottom }));

  console.log("\n状态弹窗");
  check("状态弹窗存在且只有一行", layout.stripWhiteSpace === "nowrap" && layout.stripLines <= 1,
    `${layout.stripLines} 行 / ${layout.stripWhiteSpace}`);
  check("状态弹窗在最底部", layout.stripBottom !== null && layout.stripBottom < 40, String(layout.stripBottom));

  console.log("\n不阻塞页面操作");
  const passthrough = await page.evaluate(() => {
    const panel = document.getElementById("omt-panel");
    const strip = document.getElementById("omt-status");
    // What is actually on top at the page button's centre?
    const button = document.getElementById("under").getBoundingClientRect();
    const top = document.elementFromPoint(button.left + button.width / 2, button.top + button.height / 2);
    return {
      stripPointerEvents: getComputedStyle(strip).pointerEvents,
      buttonReachable: top ? top.id === "under" || top.closest("#under") !== null : false,
      topId: top?.id || top?.className || top?.tagName,
    };
  });
  check("状态弹窗不拦截鼠标", passthrough.stripPointerEvents === "none", passthrough.stripPointerEvents);
  check("页面自己的按钮仍可点击", passthrough.buttonReachable, String(passthrough.topId));

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

  // Dragging into the corner must not park the panel over the status strip.
  const stripClear = await page.evaluate(() => {
    const panel = document.getElementById("omt-panel").getBoundingClientRect();
    const strip = document.getElementById("omt-status").getBoundingClientRect();
    return { gap: Math.round(strip.top - panel.bottom), panelBottom: Math.round(panel.bottom), stripTop: Math.round(strip.top) };
  });
  check("拖到角落也不遮住状态弹窗", stripClear.gap >= 8, JSON.stringify(stripClear));

  console.log("\n收起为挂件");
  const collapsed = await page.evaluate(async () => {
    const panel = document.getElementById("omt-panel");
    document.getElementById("omt-collapse").click();
    await new Promise((r) => setTimeout(r, 350));
    const widget = document.getElementById("omt-widget");
    const bodyVisible = getComputedStyle(panel.querySelector(".omt-panel-body")).display !== "none";
    const widgetVisible = getComputedStyle(widget).display !== "none";
    const text = widget.textContent.trim();
    const width = panel.getBoundingClientRect().width;
    document.getElementById("omt-widget").click();
    await new Promise((r) => setTimeout(r, 350));
    const expandedAgain = getComputedStyle(panel.querySelector(".omt-panel-body")).display !== "none";
    return { bodyVisible, widgetVisible, text, width, expandedAgain };
  });
  check("收起后主体隐藏", collapsed.bodyVisible === false);
  check("收起后显示挂件", collapsed.widgetVisible === true);
  check("挂件只保留核心状态", collapsed.text.includes("自动翻译") && collapsed.width < 200,
    `${collapsed.text} / ${collapsed.width}px`);
  check("可以再次展开", collapsed.expandedAgain === true);

  console.log("\n状态弹窗驱动自动识别的进度");
  await worker.evaluate(() => chrome.storage.local.set({ autoTranslate: true }));
  await new Promise((r) => setTimeout(r, 4000));
  const progress = await page.evaluate(() => {
    const strip = document.getElementById("omt-status");
    return { text: strip.textContent.trim(), visible: strip.classList.contains("omt-status-in") };
  });
  const afterToggle = ocrCalls.length;
  console.log(`      状态：「${progress.text}」`);
  check("自动识别产生了状态文字", progress.text.length > 0, progress.text);
  check("状态文字只在一行", !progress.text.includes("\n"));

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
