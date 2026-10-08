// Does renaming the project folder change the extension's identity?
//
// Chrome derives the ID of an *unpacked* extension from the absolute path it was
// loaded from, while a packed .crx derives it from the signing key. That
// distinction decides whether renaming the folder costs the user their settings,
// so it is worth measuring rather than asserting.
//
//   node deploy/probe-extension-id.mjs

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import puppeteer from "puppeteer";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workDir = mkdtempSync(join(tmpdir(), "mas-id-probe-"));

/** Load the extension from a given folder name and report the ID Chrome gives it. */
async function idFromFolder(folderName) {
  const root = join(workDir, folderName);
  const extensionDir = join(root, "extension");
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
    return new URL(target.url()).host;
  } finally {
    await browser.close();
  }
}

try {
  const before = await idFromFolder("OpenMangaTranslator");
  const after = await idFromFolder("MasLingo");
  console.log(`  解压加载 @ ...\\OpenMangaTranslator\\extension  -> ${before}`);
  console.log(`  解压加载 @ ...\\MasLingo\\extension            -> ${after}`);
  console.log(`\n  改文件夹名后 ID ${before === after ? "不变" : "会变"}`);

  // The packed artifact takes its ID from the signing key instead, which is why
  // an installed .crx survives a rename.
  const manifest = JSON.parse(readFileSync(join(repoRoot, "extension", "manifest.json"), "utf8"));
  console.log(`  （打包产物由 extension.pem 决定 ID，与文件夹名无关；清单里的名字是 "${manifest.name}"）`);
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
