// Does the collapsed pill actually dock, and does the status surface get out of
// its way?
//
// Both are position claims, so a screenshot of the pill on its own proves
// nothing. This collapses the panel with a real click and reads the geometry.
//
//   node deploy/probe-dock.mjs

import http from "node:http";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import puppeteer from "puppeteer";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const server = http.createServer((request, response) => {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end("<!doctype html><html><head><meta charset='utf-8'><title>t</title>" +
    "<style>body{margin:0;min-height:300vh;background:linear-gradient(160deg,#e8eaee,#c9ced6)}</style>" +
    "</head><body></body></html>");
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));

const workDir = mkdtempSync(join(tmpdir(), "mas-dock-"));
const extensionDir = join(workDir, "extension");
cpSync(join(repoRoot, "extension"), extensionDir, { recursive: true });
const manifestPath = join(extensionDir, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
manifest.host_permissions = [...(manifest.host_permissions || []), "<all_urls>"];
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

const browser = await puppeteer.launch({
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage",
    "--disable-features=DisableLoadExtensionCommandLineSwitch",
    `--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
});

try {
  const target = await browser.waitForTarget(
    (t) => t.type() === "service_worker" && t.url().includes("service-worker.js"),
    { timeout: 30000 },
  );
  const worker = await target.worker();
  // A position from a much larger window: the panel should not honour it while
  // collapsed, and docking must not be defeated by a stored off-screen value.
  await worker.evaluate(() => chrome.storage.local.set({
    panelCollapsed: false,
    panelPosition: { left: 4000, top: 3000 },
  }));

  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 900 });
  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: "load" });
  await new Promise((r) => setTimeout(r, 2500));

  const read = () => page.evaluate(() => {
    const panel = document.getElementById("maslingo-panel");
    const status = document.getElementById("maslingo-status");
    const box = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        left: Math.round(r.left), top: Math.round(r.top),
        right: Math.round(r.right), bottom: Math.round(r.bottom),
        w: Math.round(r.width), h: Math.round(r.height),
      };
    };
    return {
      viewport: { w: innerWidth, h: innerHeight },
      panel: box(panel),
      status: box(status),
      docked: panel ? panel.classList.contains("maslingo-panel-docked") : null,
      lift: getComputedStyle(document.documentElement)
        .getPropertyValue("--maslingo-status-lift").trim() || "0px",
    };
  });

  const expanded = await read();
  console.log("展开态：");
  console.log(`  面板 ${JSON.stringify(expanded.panel)}`);

  // A real click, not .click(): the drag bar's pointerdown used to swallow it.
  const btn = await page.$("#maslingo-collapse");
  const box = await btn.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await new Promise((r) => setTimeout(r, 1200));

  const collapsed = await read();
  console.log("\n收起态：");
  console.log(`  面板     ${JSON.stringify(collapsed.panel)}`);
  console.log(`  docked   ${collapsed.docked}`);
  console.log(`  lift     ${collapsed.lift}`);
  console.log(`  状态窗   ${JSON.stringify(collapsed.status)}`);

  const vp = collapsed.viewport;
  const p = collapsed.panel;
  const s = collapsed.status;

  const checks = [];
  const check = (name, ok, detail) => {
    console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? "  — " + detail : ""}`);
    checks.push(ok);
  };

  console.log("\n判定：");
  check("收起后带停靠类", collapsed.docked === true);
  check("贴住右下角（右/下边距一致且很小）",
    vp.w - p.right === vp.h - p.bottom && vp.w - p.right <= 20,
    `右边距 ${vp.w - p.right}px，下边距 ${vp.h - p.bottom}px`);
  check("完全在视口内",
    p.left >= 0 && p.top >= 0 && p.right <= vp.w && p.bottom <= vp.h);
  check("是收起后的小尺寸", p.w < 200 && p.h < 60, `${p.w}x${p.h}`);
  if (s) {
    // The status surface shares this corner; if the lift did not happen they
    // overlap, which is exactly the 4400px² bug this has to not reintroduce.
    const overlapW = Math.max(0, Math.min(p.right, s.right) - Math.max(p.left, s.left));
    const overlapH = Math.max(0, Math.min(p.bottom, s.bottom) - Math.max(p.top, s.top));
    check("状态窗已让位到胶囊上方（零重叠）", overlapW * overlapH === 0,
      `重叠 ${overlapW * overlapH}px²`);
    check("状态窗与胶囊共用同一条右边", Math.abs(p.right - s.right) <= 2,
      `面板右 ${p.right}，状态窗右 ${s.right}`);
  } else {
    console.log("       （状态窗尚未挂载，跳过重叠检查）");
  }

  process.exitCode = checks.every(Boolean) ? 0 : 1;
} finally {
  await browser.close();
  server.close();
  rmSync(workDir, { recursive: true, force: true });
}
