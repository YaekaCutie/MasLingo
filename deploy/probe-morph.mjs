// Does the expand path interpolate as smoothly as the collapse path?
//
// check-material.mjs samples --maslingo-morph while collapsing. Expanding is a
// separate code path — a different class, a longer duration, and a different
// transition-declaration — so it needs its own evidence rather than an assumption
// that the reverse works.
//
//   node deploy/probe-morph.mjs

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import http from "node:http";
import puppeteer from "puppeteer";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const server = http.createServer((request, response) => {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end('<!doctype html><html><body style="margin:0;background:#8a9a8a;height:100vh"></body></html>');
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));

const workDir = mkdtempSync(join(tmpdir(), "mas-morph-"));
const extensionDir = join(workDir, "extension");
cpSync(join(repoRoot, "extension"), extensionDir, { recursive: true });
const mp = join(extensionDir, "manifest.json");
const m = JSON.parse(readFileSync(mp, "utf8"));
m.host_permissions = [...(m.host_permissions || []), "<all_urls>"];
writeFileSync(mp, JSON.stringify(m, null, 2));

const browser = await puppeteer.launch({
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage",
    "--disable-features=DisableLoadExtensionCommandLineSwitch",
    `--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
});

try {
  await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().includes("service-worker.js"), { timeout: 30000 });
  const page = await browser.newPage();
  await page.setViewport({ width: 1000, height: 900 });
  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: "load" });
  await new Promise((r) => setTimeout(r, 2500));

  const sample = (action) => page.evaluate(async (what) => {
    const panel = document.getElementById("maslingo-panel");
    const read = () => ({
      morph: Number.parseFloat(getComputedStyle(panel).getPropertyValue("--maslingo-morph")) || 0,
      width: Math.round(panel.getBoundingClientRect().width),
      radius: getComputedStyle(panel).borderRadius,
    });
    const frames = [];
    document.getElementById(what).click();
    for (let i = 0; i < 22; i += 1) {
      await new Promise((r) => requestAnimationFrame(r));
      frames.push(read());
    }
    await new Promise((r) => setTimeout(r, 900));
    return { frames, final: read() };
  }, action);

  console.log("=== 收起（点 #maslingo-collapse）===");
  const collapse = await sample("maslingo-collapse");
  console.log("  morph : " + collapse.frames.map((f) => f.morph.toFixed(2)).join(" "));
  console.log("  width : " + collapse.frames.map((f) => f.width).join(" "));
  console.log(`  终态  : morph=${collapse.final.morph.toFixed(2)} width=${collapse.final.width} radius=${collapse.final.radius}`);

  await new Promise((r) => setTimeout(r, 1200));

  console.log("\n=== 展开（点 #maslingo-widget）===");
  const expand = await sample("maslingo-widget");
  console.log("  morph : " + expand.frames.map((f) => f.morph.toFixed(2)).join(" "));
  console.log("  width : " + expand.frames.map((f) => f.width).join(" "));
  console.log(`  终态  : morph=${expand.final.morph.toFixed(2)} width=${expand.final.width} radius=${expand.final.radius}`);

  const midCollapse = collapse.frames.filter((f) => f.morph > 0.05 && f.morph < 0.95).length;
  const midExpand = expand.frames.filter((f) => f.morph > 0.05 && f.morph < 0.95).length;
  const widthTracks = expand.frames.every((f, i) => i === 0 || f.width >= expand.frames[i - 1].width - 1);

  console.log("\n=== 判定 ===");
  console.log(`  收起中间帧 ${midCollapse} 个，展开中间帧 ${midExpand} 个`);
  console.log(`  展开时宽度单调不回跳: ${widthTracks ? "是" : "否"}`);
  console.log(`  圆角随形态变化: 收起后 ${collapse.final.radius} / 展开后 ${expand.final.radius}`);

  const ok = midCollapse >= 2 && midExpand >= 2 && widthTracks
    && expand.final.width > 250 && collapse.final.width < 200;
  console.log(`\n${ok ? "两条路径都是连续插值" : "有一侧不是连续插值"}`);
  process.exitCode = ok ? 0 : 1;
} finally {
  await browser.close();
  server.close();
  rmSync(workDir, { recursive: true, force: true });
}
