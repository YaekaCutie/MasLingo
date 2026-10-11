// The panel's internal spacing, as a rule rather than a screenshot.
//
// Written for a report that buttons and dividers were "out of bounds" and not
// uniform. Nothing actually escaped the panel — `overflow-x: hidden` prevents
// that — the defect was that three different horizontal insets coexisted: text
// at 14px, the header rule edge to edge, the body rules inset 12px. A screenshot
// shows the mismatch; only a measurement can state it.
//
// So this pins down the two rules the panel now follows:
//
//   1. one inset. Every content element sits at the same distance from both
//      edges — no element invents its own padding.
//   2. rules run edge to edge. A separator that stops short of the edge reads as
//      a mistake, so every rule spans the full panel width.
//
//   node deploy/check-panel-layout.mjs

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import puppeteer from "puppeteer";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workDir = mkdtempSync(join(tmpdir(), "maslingo-layout-"));
const extensionDir = join(workDir, "extension");
cpSync(join(repoRoot, "extension"), extensionDir, { recursive: true });
const manifestPath = join(extensionDir, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
manifest.host_permissions = [...(manifest.host_permissions || []), "<all_urls>"];
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

const failures = [];
const check = (name, condition, detail = "") => {
  if (condition) {
    console.log(`  ok    ${name}`);
  } else {
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
    failures.push(name);
  }
};

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
  await browser.waitForTarget(
    (t) => t.type() === "service_worker" && t.url().includes("service-worker.js"),
    { timeout: 30000 },
  );
  const page = await browser.newPage();
  await page.setViewport({ width: 1000, height: 900 });
  await page.goto("https://example.com/", { waitUntil: "domcontentloaded" });
  await new Promise((r) => setTimeout(r, 2500));

  const report = await page.evaluate(() => {
    const panel = document.getElementById("maslingo-panel");
    if (!panel) return { error: "找不到面板" };
    const panelRect = panel.getBoundingClientRect();

    // Only direct children of a band are positioned by the gutter. Anything
    // nested inside them is laid out relative to its own parent — measuring the
    // switch's thumb against the panel edge would prove nothing.
    //
    // `.maslingo-statusbar` used to be in this list and no longer exists: the
    // status line moved out of the panel into its own surface. Because the list
    // was filtered with `Boolean`, the stale selector was dropped in silence and
    // the rules below were measured over fewer bands than intended. The expected
    // count is returned so the caller can fail loudly instead.
    //
    // `.maslingo-widget` is deliberately NOT a measured band: its children are
    // laid out by flex inside it, so they are not gutter-positioned and including
    // it reported a second, meaningless inset.
    const BAND_SELECTORS = [".maslingo-panel-bar", ".maslingo-panel-body"];
    const bands = BAND_SELECTORS
      .map((selector) => panel.querySelector(selector))
      .filter(Boolean);

    const content = [];
    const rules = [];
    for (const band of bands) {
      for (const node of band.children) {
        const rect = node.getBoundingClientRect();
        if (rect.width < 8 || rect.height < 1) continue;
        const left = Math.round(rect.left - panelRect.left);
        const right = Math.round(panelRect.right - rect.right);
        const label = node.id
          ? `#${node.id}`
          : typeof node.className === "string" && node.className.trim()
            ? `.${node.className.trim().split(/\s+/)[0]}`
            : node.tagName.toLowerCase();

        // A rule is a hairline the full width of the panel.
        const isRule = rect.height <= 2 && rect.width > panelRect.width * .9;
        if (isRule) rules.push({ label, left, right });
        // Full-width blocks are containers; the gutter applies inside them.
        else if (rect.width < panelRect.width - 4) content.push({ label, left, right });
      }
    }
    return {
      panel: { width: Math.round(panelRect.width), radius: getComputedStyle(panel).borderRadius },
      // Reported so a missing band is a failure rather than a smaller measurement.
      bandCount: bands.length,
      expectedBands: BAND_SELECTORS.length,
      content,
      rules,
    };
  });

  if (report.error) {
    console.error(report.error);
    process.exit(1);
  }

  console.log(`面板 ${report.panel.width}px  圆角 ${report.panel.radius}\n`);

  // A stale band selector used to be swallowed by filter(Boolean), which made
  // the rules below pass over fewer bands. Now a missing band is the failure.
  check("所有预期的内容带都存在", report.bandCount === report.expectedBands,
    `找到 ${report.bandCount} 个，预期 ${report.expectedBands} 个`);

  console.log("统一内缩");
  const insets = report.content.map((item) => Math.min(item.left, item.right));
  const distinct = [...new Set(insets)].sort((a, b) => a - b);
  console.log(`      各元素距其贴靠边的距离：${distinct.join(", ")}px`);
  report.content.forEach((item) => {
    console.log(`        ${item.label.padEnd(22)} 左 ${String(item.left).padStart(3)}  右 ${String(item.right).padStart(3)}`);
  });
  // An element anchored to the right — the collapse button in the header row —
  // is measured from the right. What must hold for all of them is that the edge
  // they hug is the same distance away.
  check("每个元素距其贴靠边都等于同一个 gutter", distinct.length === 1,
    `出现了 ${distinct.join(", ")}`);

  const negative = report.content.filter((item) => item.left < 0 || item.right < 0);
  check("没有元素越出面板", negative.length === 0,
    negative.map((item) => item.label).join(", "));

  console.log("\n分割线通栏");
  console.log(`      找到 ${report.rules.length} 条：`
    + report.rules.map((rule) => `${rule.label}(左${rule.left}/右${rule.right})`).join("  "));
  check("至少找到两条分割线", report.rules.length >= 2, `只有 ${report.rules.length} 条`);
  const insetRules = report.rules.filter((rule) => rule.left > 1 || rule.right > 1);
  check("每条分割线都通栏到边缘", insetRules.length === 0,
    insetRules.map((rule) => `${rule.label} 左${rule.left} 右${rule.right}`).join("; "));

  // --- position limits are gone; only a fully invisible pane is rescued -----
  //
  // The panel may be placed anywhere, including partly past an edge, and a
  // saved position is applied as saved. The one correction left is for a pane
  // that is *entirely* off screen — a position from a much larger monitor, or
  // a window that shrank around it — which would otherwise be mounted but
  // unreachable, reading as "the panel disappeared".
  console.log("\n自由摆放：部分出界按原样恢复");
  const workerTarget = await browser.waitForTarget(
    (t) => t.type() === "service_worker" && t.url().includes("service-worker.js"),
    { timeout: 30000 },
  );
  const sw = await workerTarget.worker();
  await sw.evaluate(() => chrome.storage.local.set({ panelPosition: { left: 950, top: 800 } }));
  await page.reload({ waitUntil: "domcontentloaded" });
  await new Promise((r) => setTimeout(r, 2500));

  const partlyOff = await page.evaluate(() => {
    const panel = document.getElementById("maslingo-panel");
    if (!panel) return { mounted: false };
    const rect = panel.getBoundingClientRect();
    return { mounted: true, x: Math.round(rect.x), y: Math.round(rect.y) };
  });
  console.log(`      存了 (950,800)，恢复后落在 (${partlyOff.x},${partlyOff.y})`);
  check("部分出界的位置按存档原样恢复（不再被 clamp）",
    partlyOff.mounted && partlyOff.x === 950 && partlyOff.y === 800,
    JSON.stringify(partlyOff));

  console.log("\n完全出界时被拉回可视区（只救这一种情况）");
  await sw.evaluate(() => chrome.storage.local.set({ panelPosition: { left: 4000, top: 3000 } }));
  await page.reload({ waitUntil: "domcontentloaded" });
  await new Promise((r) => setTimeout(r, 2500));

  const restored = await page.evaluate(() => {
    const panel = document.getElementById("maslingo-panel");
    if (!panel) return { mounted: false };
    const rect = panel.getBoundingClientRect();
    return {
      mounted: true,
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      // Something grabbable must be on screen: at least 16px on both axes.
      reachable: (() => {
        const visibleX = Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0);
        const visibleY = Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0);
        return Math.max(visibleX, 0) >= 16 && Math.max(visibleY, 0) >= 16;
      })(),
      viewport: [window.innerWidth, window.innerHeight],
    };
  });
  console.log(`      存了 (4000,3000)，恢复后落在 (${restored.x},${restored.y})，`
    + `视口 ${JSON.stringify(restored.viewport)}`);
  check("完全出界的位置被拉回可视区", restored.mounted && restored.reachable === true,
    JSON.stringify(restored));

  // --- the message text lives inside the panel ------------------------------
  //
  // It used to be an independent surface sharing this corner, then a separate
  // row inside the panel. Everything now shares the panel's one message line.
  console.log("\n消息文字在面板内，没有第二个浮层");
  // The reachability test left the pane at the edge it was rescued to; clear
  // the stored position so the panel returns to its own corner for this part.
  await sw.evaluate(() => chrome.storage.local.remove("panelPosition"));
  await page.reload({ waitUntil: "domcontentloaded" });
  await new Promise((r) => setTimeout(r, 2000));
  await sw.evaluate(() => chrome.storage.local.set({ autoTranslate: true }));
  await new Promise((r) => setTimeout(r, 1500));
  const placement = await page.evaluate(() => {
    const panel = document.getElementById("maslingo-panel");
    const line = document.getElementById("maslingo-line");
    return {
      legacySurfaces: Boolean(
        document.getElementById("maslingo-status")
          || document.getElementById("maslingo-status-line"),
      ),
      lineInPanel: Boolean(panel && line && panel.contains(line)),
      panelBottom: panel ? Math.round(window.innerHeight - panel.getBoundingClientRect().bottom) : -1,
    };
  });
  console.log(`      旧浮层存在：${placement.legacySurfaces}  消息行在面板内：${placement.lineInPanel}`
    + `  面板下沿距底 ${placement.panelBottom}px`);
  check("不再有独立的状态浮层/状态行", placement.legacySurfaces === false);
  check("消息行在面板内部", placement.lineInPanel === true);
  check("面板贴住底部（不再预留状态窗空间）",
    placement.panelBottom >= 8 && placement.panelBottom < 40, String(placement.panelBottom));
} finally {
  await browser.close();
  rmSync(workDir, { recursive: true, force: true });
}

console.log("");
if (failures.length) {
  console.log(`${failures.length} 项失败：${failures.join("、")}`);
  process.exit(1);
}
console.log("面板内部间距符合预期");
