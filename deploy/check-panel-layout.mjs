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
const workDir = mkdtempSync(join(tmpdir(), "mas-layout-"));
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
    const panel = document.getElementById("mas-panel");
    if (!panel) return { error: "找不到面板" };
    const panelRect = panel.getBoundingClientRect();

    // Only direct children of a band are positioned by the gutter. Anything
    // nested inside them is laid out relative to its own parent — measuring the
    // switch's thumb against the panel edge would prove nothing.
    const bands = [
      panel.querySelector(".mas-panel-bar"),
      panel.querySelector(".mas-panel-body"),
      panel.querySelector(".mas-statusbar"),
    ].filter(Boolean);

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
      content,
      rules,
    };
  });

  if (report.error) {
    console.error(report.error);
    process.exit(1);
  }

  console.log(`面板 ${report.panel.width}px  圆角 ${report.panel.radius}\n`);

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
