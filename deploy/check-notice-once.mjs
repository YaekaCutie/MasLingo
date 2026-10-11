// The page-level notice must appear exactly once, in the top frame.
//
// Auto translate runs in every frame, and so did the notice: a reader that
// hosts the manga in an iframe produced one banner inside that iframe — clipped
// to it and parked in the middle of the page — on top of the top frame's own.
// Seen live as two "已检测到漫画，正在自动翻译" banners a few pixels apart. The
// fix gates the notice to the top frame; this check drives the real extension
// over a page with an iframe and counts what actually ends up in each document.
//
//   node deploy/check-notice-once.mjs

import http from "node:http";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
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

const server = http.createServer((request, response) => {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  if (request.url === "/frame") {
    response.end("<!doctype html><html><body><p>inner frame</p></body></html>");
    return;
  }
  response.end(`<!doctype html><html><body style="margin:0">
    <iframe src="/frame" style="width:600px;height:420px;border:0"></iframe>
  </body></html>`);
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const pageUrl = `http://127.0.0.1:${server.address().port}/`;

const workDir = mkdtempSync(join(tmpdir(), "maslingo-notice-"));
const extensionDir = join(workDir, "extension");
cpSync(join(repoRoot, "extension"), extensionDir, { recursive: true });

const browser = await puppeteer.launch({
  headless: true,
  args: [
    "--no-sandbox",
    "--disable-dev-shm-usage",
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
  // Turn auto translate on before the page loads, so both frames run start().
  await worker.evaluate(() => chrome.storage.local.set({ autoTranslate: true }));

  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 700 });
  await page.goto(pageUrl, { waitUntil: "load" });
  await new Promise((r) => setTimeout(r, 2500));

  const count = (frame) => frame.evaluate(() => ({
    notices: document.querySelectorAll("#maslingo-notice").length,
    noticeText: document.getElementById("maslingo-notice")?.textContent || "",
    panels: document.querySelectorAll("#maslingo-panel").length,
    statusLines: document.querySelectorAll("#maslingo-line").length,
  }));

  const top = await count(page.mainFrame());
  const inner = page.frames().find((frame) => frame.url().endsWith("/frame"));
  const sub = inner ? await count(inner) : null;

  console.log(`      顶层: ${JSON.stringify(top)}`);
  console.log(`      子帧: ${JSON.stringify(sub)}`);

  check("顶层出现一条提示", top.notices === 1, String(top.notices));
  check("提示文字正确", top.noticeText.includes("已检测到漫画"), top.noticeText);
  check("子帧不再出现提示（位置错乱的那个）", sub !== null && sub.notices === 0, String(sub?.notices));
  check("页面级界面只属于最外层（子帧没有面板）", sub !== null && sub.panels === 0, String(sub?.panels));
  check("页面级界面只属于最外层（子帧没有消息行）", sub !== null && sub.statusLines === 0, String(sub?.statusLines));
} finally {
  await browser.close();
  server.close();
  rmSync(workDir, { recursive: true, force: true });
}

console.log("");
if (failures.length) {
  console.error(`${failures.length} 项不合格`);
  process.exit(1);
}
console.log("页面级提示只出现一次，且在最外层文档");
