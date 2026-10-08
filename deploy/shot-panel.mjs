// Tight, high-DPI screenshots of the panel for layout inspection.
//
// The behaviour checks measure numbers; they cannot show that one divider runs
// edge to edge while the next is inset, which is exactly the kind of thing a
// person notices immediately. This renders the panel on a neutral backdrop at 3x
// and crops to it, so alignment is judged by eye at a usable scale.
//
//   node deploy/shot-panel.mjs [label]
//
// Writes deploy/screenshots/panel-<label>.png (default label: layout).

import http from "node:http";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import puppeteer from "puppeteer";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const label = process.argv[2] || "layout";

// A served page, not a data: URL — content scripts never inject into data: URLs,
// so the panel simply would not mount there.
const server = http.createServer((request, response) => {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>bg</title>
    <style>
      html,body{margin:0;height:100%}
      body{background:linear-gradient(135deg,#2b3a4a,#7a8b7c 45%,#c9b48a)}
      .stripes{position:fixed;inset:0;background-image:repeating-linear-gradient(45deg,rgba(255,255,255,.16) 0 18px,transparent 18px 36px)}
    </style></head>
    <body><div class="stripes"></div></body></html>`);
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const pageUrl = `http://127.0.0.1:${server.address().port}/`;

const workDir = mkdtempSync(join(tmpdir(), "maslingo-shot-"));
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
  await worker.evaluate(() => chrome.storage.local.set({
    autoTranslate: true, translationProvider: "deepseek", backendUrl: "http://127.0.0.1:8001",
    panelPosition: { left: 60, top: 40 },
  }));

  const outDir = resolve(repoRoot, "deploy", "screenshots");
  mkdirSync(outDir, { recursive: true });

  for (const scheme of ["light", "dark"]) {
    // Collapse is persisted, so without this reset the second scheme would be
    // photographed already collapsed — which is exactly what happened.
    await worker.evaluate(() => chrome.storage.local.set({ panelCollapsed: false }));
    const page = await browser.newPage();
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
    await page.setViewport({ width: 900, height: 800, deviceScaleFactor: 3 });
    await page.goto(pageUrl, { waitUntil: "load" });
    await new Promise((r) => setTimeout(r, 2500));
    await page.evaluate(() => globalThis.MAS_panel?.status("正在 OCR……"));

    const box = await page.evaluate(() => {
      const panel = document.getElementById("maslingo-panel");
      if (!panel) return null;
      const rect = panel.getBoundingClientRect();
      return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
    });
    if (!box) {
      console.error("面板未挂载");
      process.exit(1);
    }
    console.log(`      面板 (${Math.round(box.x)}, ${Math.round(box.y)}) ${Math.round(box.width)}x${Math.round(box.height)}`);

    // Element screenshot: clipped to the panel exactly, so no crop arithmetic
    // can drift and silently slice the left edge off.
    const handle = await page.$("#maslingo-panel");
    await handle.screenshot({ path: join(outDir, `panel-${label}-${scheme}.png`) });

    // And one with the page showing through, for judging the glass itself.
    await page.screenshot({
      path: join(outDir, `panel-${label}-${scheme}-context.png`),
      clip: {
        x: Math.max(0, Math.min(900 - box.width - 48, box.x - 24)),
        y: Math.max(0, Math.min(800 - box.height - 48, box.y - 24)),
        width: Math.min(900, box.width + 48),
        height: Math.min(800, box.height + 48),
      },
    });
    console.log(`  ${scheme}: panel-${label}-${scheme}.png  (${Math.round(box.width)}x${Math.round(box.height)} @3x)`);

    // The collapsed end state. Captured after the transition settles, so this is
    // the shape the animation arrives at rather than a frame of it.
    await page.evaluate(() => document.getElementById("maslingo-collapse").click());
    await new Promise((r) => setTimeout(r, 900));
    const collapsed = await page.$("#maslingo-panel");
    await collapsed.screenshot({ path: join(outDir, `panel-${label}-${scheme}-collapsed.png`) });
    const collapsedBox = await page.evaluate(() => {
      const rect = document.getElementById("maslingo-panel").getBoundingClientRect();
      return { width: Math.round(rect.width), height: Math.round(rect.height) };
    });
    console.log(`      收起态: ${collapsedBox.width}x${collapsedBox.height}`);
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
  rmSync(workDir, { recursive: true, force: true });
}
