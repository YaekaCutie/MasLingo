// Why has the panel gone?
//
// Loads the extension exactly as the user's browser does, then reports what the
// page actually contains: the stored settings that decide whether the panel is
// collapsed or parked off-screen, and the panel's own box if it is there.
//
//   node deploy/diagnose-panel.mjs [页面地址]

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import puppeteer from "puppeteer";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const url = process.argv[2] || "https://example.com/";

const workDir = mkdtempSync(join(tmpdir(), "mas-diag-"));
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

  console.log("=== 扩展存储（决定面板形态）===");
  const stored = await worker.evaluate(() => chrome.storage.local.get(null));
  for (const [key, value] of Object.entries(stored)) {
    const shown = typeof value === "string" && value.length > 24 ? `${value.slice(0, 6)}…` : value;
    console.log(`  ${key}: ${JSON.stringify(shown)}`);
  }

  const page = await browser.newPage();
  await page.setViewport({ width: 1000, height: 800 });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await new Promise((r) => setTimeout(r, 3000));

  console.log("\n=== 页面上的扩展节点 ===");
  const nodes = await page.evaluate(() => {
    const out = [];
    for (const node of document.documentElement.children) {
      if (!node.id?.startsWith("maslingo-")) continue;
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      out.push({
        id: node.id,
        cls: node.className.slice(0, 70),
        box: `${Math.round(rect.width)}x${Math.round(rect.height)} @(${Math.round(rect.x)},${Math.round(rect.y)})`,
        display: style.display,
        visibility: style.visibility,
        opacity: style.opacity,
        zIndex: style.zIndex,
        morph: style.getPropertyValue("--maslingo-morph").trim(),
        widthVar: style.width,
      });
    }
    return out;
  });
  if (!nodes.length) console.log("  （页面上没有任何 maslingo- 节点）");
  for (const node of nodes) console.log(`  ${JSON.stringify(node, null, 1)}`);

  console.log("\n=== 视口与面板是否在可视区内 ===");
  const visible = await page.evaluate(() => {
    const panel = document.getElementById("maslingo-panel");
    if (!panel) return { mounted: false };
    const rect = panel.getBoundingClientRect();
    return {
      mounted: true,
      inViewport: rect.right > 0 && rect.bottom > 0
        && rect.left < window.innerWidth && rect.top < window.innerHeight,
      rect: [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)],
      viewport: [window.innerWidth, window.innerHeight],
      inlineStyle: panel.getAttribute("style"),
      hasContent: Boolean(panel.querySelector(".maslingo-glass__content")),
      contentBox: (() => {
        const content = panel.querySelector(".maslingo-glass__content");
        if (!content) return null;
        const box = content.getBoundingClientRect();
        return [Math.round(box.width), Math.round(box.height)];
      })(),
    };
  });
  console.log(`  ${JSON.stringify(visible, null, 1)}`);

  // The status surface shares the corner with the panel, so this measures
  // whether one covers the other while a message is on screen.
  console.log("\n=== 状态窗与面板是否重叠 ===");
  await worker.evaluate(() => chrome.storage.local.set({ autoTranslate: true }));
  await new Promise((r) => setTimeout(r, 4000));
  const overlap = await page.evaluate(() => {
    const panel = document.getElementById("maslingo-panel");
    const status = document.getElementById("maslingo-status");
    if (!panel || !status) return { status: Boolean(status), panel: Boolean(panel) };
    const a = panel.getBoundingClientRect();
    const b = status.getBoundingClientRect();
    const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    return {
      panel: [Math.round(a.x), Math.round(a.y), Math.round(a.width), Math.round(a.height)],
      status: [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)],
      overlapArea: width > 0 && height > 0 ? Math.round(width * height) : 0,
      panelBottom: Math.round(window.innerHeight - a.bottom),
      statusBottom: Math.round(window.innerHeight - b.bottom),
    };
  });
  console.log(`  ${JSON.stringify(overlap, null, 1)}`);
  if (overlap.overlapArea > 0) {
    console.log(`  ⚠ 状态窗与面板重叠 ${overlap.overlapArea}px²，面板下半部分会被盖住`);
  }

  console.log(`\n页面错误: ${errors.length ? errors.slice(0, 4).join(" | ") : "无"}`);
} finally {
  await browser.close();
  rmSync(workDir, { recursive: true, force: true });
}
