// Watch a detection box through its whole life.
//
// §12 specifies seven phases: appear immediately at full size, dashed, cross-fade
// to solid over 350–550ms, hold while the translation lands, hold ~500ms more,
// fade out over 350–600ms, then leave the DOM. The stylesheet has the durations
// and marker.css has them as tokens — but nothing has observed the sequence
// actually happening, which is what this does.
//
// Needs the real backend on 127.0.0.1:8001 and a manga page in testdata/real.
//
//   node deploy/probe-marker.mjs

import http from "node:http";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import puppeteer from "puppeteer";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const backendUrl = "http://127.0.0.1:8001";

try {
  await (await fetch(`${backendUrl}/health`)).json();
} catch (error) {
  console.error(`后端没在跑（${backendUrl}）：${error.message}`);
  process.exit(2);
}

const imagePath = [
  "testdata/real/v2-966f6189130307d36ec283af25ef6b27_r.jpg",
  "testdata/real/4b41-a54f6b467963479d1a5552c315c8b31f.jpg",
].map((name) => resolve(repoRoot, name)).find((path) => existsSync(path));
if (!imagePath) {
  console.error("需要一张真实漫画页（testdata/real）");
  process.exit(2);
}
const image = readFileSync(imagePath);

const server = http.createServer((request, response) => {
  if (request.url === "/manga.jpg") {
    response.writeHead(200, { "Content-Type": "image/jpeg", "Content-Length": image.length });
    response.end(image);
    return;
  }
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>manga</title>
    <style>body{margin:0;background:#111}img{display:block;width:760px;margin:0 auto}</style>
    </head><body><img id="page" src="/manga.jpg"></body></html>`);
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));

const workDir = mkdtempSync(join(tmpdir(), "mas-marker-"));
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
  await worker.evaluate((url) => chrome.storage.local.set({
    backendUrl: url, autoTranslate: true, translationMode: "none", translationProvider: "none",
    autoConcurrency: 1, panelCollapsed: false,
  }), backendUrl);

  const page = await browser.newPage();
  await page.setViewport({ width: 1000, height: 1000 });
  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: "load" });

  // Sample every frame from inside the page: a box can be born and die inside a
  // single second, so polling from Node would miss whole phases.
  await page.evaluate(() => {
    globalThis.__markerTrace = [];
    let nextId = 0;
    const tick = () => {
      const boxes = document.querySelectorAll(".maslingo-box");
      for (const box of boxes) {
        // `left,top` is not a stable identity: a released box and a newly created
        // one for the same region share it, and their traces interleave. Tag each
        // node the first time it is seen instead.
        if (!box.dataset.traceId) box.dataset.traceId = String(++nextId);
        const dashed = box.querySelector(".maslingo-box-dashed");
        const solid = box.querySelector(".maslingo-box-solid");
        globalThis.__markerTrace.push({
          t: Math.round(performance.now()),
          key: box.dataset.traceId,
          // Geometry matters as much as opacity: §12 phase 1 says the rectangle
          // appears at its final size, so a box that grows would be the bug.
          w: Math.round(box.getBoundingClientRect().width),
          h: Math.round(box.getBoundingClientRect().height),
          opacity: Number(getComputedStyle(box).opacity),
          dashed: dashed ? Number(getComputedStyle(dashed).opacity) : null,
          solid: solid ? Number(getComputedStyle(solid).opacity) : null,
          declared: solid ? Number.parseFloat(getComputedStyle(solid).transitionDuration) * 1000 : null,
          fading: box.classList.contains("maslingo-box-fading"),
          working: box.classList.contains("maslingo-box-working"),
          solidOn: box.classList.contains("maslingo-box-solid-on"),
          pointer: getComputedStyle(box).pointerEvents,
        });
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  // Wait until at least one box has been seen, faded, and disappeared entirely.
  let trace = [];
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await new Promise((r) => setTimeout(r, 1500));
    trace = await page.evaluate(() => globalThis.__markerTrace);
    const byKey = new Map();
    for (const row of trace) {
      if (!byKey.has(row.key)) byKey.set(row.key, []);
      byKey.get(row.key).push(row);
    }
    const live = new Set([...byKey.keys()]);
    const current = await page.evaluate(() =>
      [...document.querySelectorAll(".maslingo-box")].map((b) => b.dataset.traceId));
    const done = [...byKey.keys()].some((key) =>
      !current.includes(key) && byKey.get(key).some((row) => row.fading));
    if (done) break;
    void live;
  }

  const keys = [...new Set(trace.map((row) => row.key))];
  console.log(`捕获 ${trace.length} 帧，涉及 ${keys.length} 个检测框\n`);

  // Pick the first box that went through a full cycle.
  let picked = null;
  for (const key of keys) {
    const rows = trace.filter((row) => row.key === key);
    if (rows.some((row) => row.fading)) { picked = { key, rows }; break; }
  }
  if (!picked) {
    console.log("没有捕获到完整的检测框生命周期（可能本页没有检出文字）");
    process.exit(1);
  }

  const rows = picked.rows;
  const first = rows[0];
  const last = rows[rows.length - 1];
  const solidOn = rows.find((row) => row.solidOn);
  const fading = rows.find((row) => row.fading);
  const solidFull = rows.find((row) => row.solid >= 0.99);
  const visible = rows.find((row) => row.opacity >= 0.95);

  console.log("阶段时间线：");
  console.log(`  Phase 1-2 满尺寸虚线出现    t=${first.t}  ${first.w}x${first.h}  dashed=${first.dashed}  box-opacity=${first.opacity}`);
  console.log(`  变为可见                    t=${visible ? visible.t : "-"}  opacity=${visible ? visible.opacity : "-"}`);
  console.log(`  Phase 3   开始转实线        t=${solidOn ? solidOn.t : "-"}`);
  console.log(`  Phase 4   实线完全不透明    t=${solidFull ? solidFull.t : "-"}`);
  console.log(`  Phase 6   开始淡出          t=${fading ? fading.t : "-"}`);
  console.log(`  消失      最后一帧          t=${last.t}  opacity=${last.opacity}`);

  // The declared duration is the honest measure of "how long does it take to
  // turn solid". Sampling opacity instead catches the curve rather than the
  // duration: with ase, 0.95 arrives at about two thirds of the way through.
  // The declared duration is the honest measure of how long the edge takes to
  // turn solid. Sampling opacity instead measures the curve: with an ease-out
  // curve, 0.95 arrives about two thirds of the way through the duration.
  const solidifyMs = rows
    .map((row) => row.declared)
    .find((value) => Number.isFinite(value)) ?? null;
  const holdMs = solidFull && fading ? fading.t - solidFull.t : null;
  const life = last.t - first.t;

  console.log("\n判定：");
  console.log(`  检测框存活 ${life}ms`);
  console.log(`  虚线→实线 ${solidifyMs}ms（规格 350–550）`);
  console.log(`  实线保持  ${holdMs}ms（规格 ~500）`);
  console.log(`  入场可见  ${visible ? visible.t - first.t : "-"}ms（规格：立即）`);
  console.log(`  pointer-events: ${first.pointer}`);
  console.log(`  尺寸 首帧 ${first.w}x${first.h} → 末帧 ${last.w}x${last.h}`);

  const sizeStable = rows.every((row) => Math.abs(row.w - first.w) <= 2 && Math.abs(row.h - first.h) <= 2);
  const ok = first.dashed >= 0.95
    && sizeStable
    && first.pointer === "none"
    && visible && visible.t - first.t < 260
    && solidifyMs !== null && solidifyMs >= 350 && solidifyMs <= 550
    && holdMs !== null && holdMs >= 400 && holdMs <= 900
    && last.opacity < 0.2;
  console.log(`\n${ok ? "七阶段时序符合规格" : "时序与规格不符，见上"}`);
  process.exitCode = ok ? 0 : 1;
} finally {
  await browser.close();
  server.close();
  rmSync(workDir, { recursive: true, force: true });
}
