// Capture the popup and settings pages, so a UI change can be looked at rather
// than inferred from assertions.
//
//   node deploy/screenshot-ui.mjs [输出目录]

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import puppeteer from "puppeteer";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(process.argv[2] || join(repoRoot, "deploy", "screenshots"));
mkdirSync(outDir, { recursive: true });

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
  const extensionId = new URL(worker.url()).host;
  await worker.evaluate(() => chrome.storage.local.set({
    translationProvider: "deepseek", autoTranslate: true,
    translationApiKey: "sk-demo", backendUrl: "http://127.0.0.1:8001",
  }));

  for (const scheme of ["light", "dark"]) {
    const page = await browser.newPage();
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);

    await page.setViewport({ width: 320, height: 420, deviceScaleFactor: 2 });
    await page.goto(`chrome-extension://${extensionId}/popup/popup.html`, { waitUntil: "load" });
    await new Promise((done) => setTimeout(done, 700));
    await page.screenshot({ path: join(outDir, `popup-${scheme}.png`) });

    await page.setViewport({ width: 760, height: 1100, deviceScaleFactor: 2 });
    await page.goto(`chrome-extension://${extensionId}/options/options.html`, { waitUntil: "load" });
    await new Promise((done) => setTimeout(done, 700));
    await page.screenshot({ path: join(outDir, `options-${scheme}.png`), fullPage: true });

    await page.close();
    console.log(`${scheme}: popup-${scheme}.png, options-${scheme}.png`);
  }
} finally {
  await browser.close();
  rmSync(workDir, { recursive: true, force: true });
}

console.log(`输出目录: ${outDir}`);
