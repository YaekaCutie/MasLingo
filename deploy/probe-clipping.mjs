// Find text that is being clipped inside the panel.
//
// "Text is not fully displayed" is a claim about geometry, and at screenshot
// resolution a clipped descender looks the same as a font that just sits low.
// This compares every text-bearing element's scroll box against its client box,
// which is the definition of clipped.
//
//   node deploy/probe-clipping.mjs

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
    "<style>body{margin:0;min-height:300vh}</style></head><body></body></html>");
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));

const workDir = mkdtempSync(join(tmpdir(), "mas-clip-"));
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
  await worker.evaluate(() => chrome.storage.local.set({ panelCollapsed: false }));

  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 900 });
  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: "load" });
  await new Promise((r) => setTimeout(r, 2500));

  const report = await page.evaluate(() => {
    const panel = document.getElementById("maslingo-panel");
    if (!panel) return { error: "panel not mounted" };

    const rows = [];
    for (const node of panel.querySelectorAll("*")) {
      const own = [...node.childNodes]
        .filter((n) => n.nodeType === 3 && n.textContent.trim())
        .map((n) => n.textContent.trim())
        .join(" ");
      const isControl = node.tagName === "SELECT" || node.tagName === "INPUT";
      if (!own && !isControl) continue;

      const style = getComputedStyle(node);
      const clippedY = node.scrollHeight - node.clientHeight;
      const clippedX = node.scrollWidth - node.clientWidth;

      // Where the glyphs actually sit, versus where the box says they may sit.
      const range = document.createRange();
      range.selectNodeContents(node);
      const text = range.getBoundingClientRect();
      const box = node.getBoundingClientRect();

      rows.push({
        tag: node.tagName.toLowerCase(),
        cls: node.className.toString().slice(0, 40),
        text: own.slice(0, 24) || (isControl ? node.value : ""),
        clippedX, clippedY,
        overflow: `${style.overflowX}/${style.overflowY}`,
        // Positive = the glyph box extends past the padding box, i.e. visibly cut.
        spillTop: Math.round(box.top + parseFloat(style.paddingTop) - text.top),
        spillBottom: Math.round(text.bottom - (box.bottom - parseFloat(style.paddingBottom))),
        lineHeight: style.lineHeight,
        fontSize: style.fontSize,
        height: Math.round(box.height),
      });
    }
    return { rows };
  });

  if (report.error) {
    console.log(report.error);
    process.exit(1);
  }

  console.log("元素裁切检查（正数 = 文字超出内边距框，即被切）\n");
  console.log("  上方溢出  下方溢出  横向裁切  元素");
  let problems = 0;
  for (const row of report.rows) {
    const bad = row.clippedY > 0 || row.clippedX > 0 || row.spillTop > 1 || row.spillBottom > 1;
    if (!bad) continue;
    problems += 1;
    console.log(
      `  ${String(row.spillTop).padStart(8)}  ${String(row.spillBottom).padStart(8)}  ` +
      `${String(row.clippedX).padStart(8)}  ${row.tag}.${row.cls} ` +
      `h=${row.height} lh=${row.lineHeight} "${row.text}"`,
    );
  }
  if (!problems) console.log("        （没有元素被裁切）");

  console.log("\n所有文本元素的高度与行高：");
  for (const row of report.rows) {
    console.log(
      `  h=${String(row.height).padStart(3)}  fs=${String(row.fontSize).padStart(6)}  ` +
      `lh=${String(row.lineHeight).padStart(8)}  ${row.tag}.${row.cls} "${row.text}"`,
    );
  }

  process.exitCode = problems ? 1 : 0;
} finally {
  await browser.close();
  server.close();
  rmSync(workDir, { recursive: true, force: true });
}
