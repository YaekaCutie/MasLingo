// Run the on-device OCR engine inside a real Chrome, with real WASM.
//
// Node timings (tools/engine_parity_test.mjs) come from onnxruntime-node's
// native build; the extension ships the WASM runtime, which is meaningfully
// slower. This is the measurement that decides whether on-device OCR is
// actually usable, so it has to happen in the browser.
//
// Prerequisites:
//   python tools/fetch_ocr_assets.py     # wasm runtime + int8 model
//   npm install --no-save puppeteer
//
// Usage:
//   node deploy/check-ondevice-ocr.mjs --crop models/test-crop.png \
//        --expect "アサちゃんはチェンソーマン好き？"
//
// The crop is passed in rather than committed: the probe images are from a
// commercial manga page and do not belong in the repository.

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import puppeteer from "puppeteer";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionDir = join(repoRoot, "extension");

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const crop = arg("--crop", "");
const expected = arg("--expect", "");
if (!crop) {
  console.error("--crop <path relative to extension/> is required");
  process.exit(2);
}
if (!existsSync(join(extensionDir, crop))) {
  console.error(`crop not found: extension/${crop}`);
  process.exit(2);
}
for (const required of ["vendor/ort/ort.wasm.min.js", "vendor/ort/ort-wasm-simd-threaded.wasm", "models/encoder.onnx", "models/decoder.onnx"]) {
  if (!existsSync(join(extensionDir, required))) {
    console.error(`missing ${required} — run: python tools/fetch_ocr_assets.py`);
    process.exit(2);
  }
}

const LAUNCH_ARGS = [
  "--no-sandbox",
  "--disable-dev-shm-usage",
  // Chrome 137 disabled --load-extension on the command line.
  "--disable-features=DisableLoadExtensionCommandLineSwitch",
  `--disable-extensions-except=${extensionDir}`,
  `--load-extension=${extensionDir}`,
];

const browser = await puppeteer.launch({ headless: true, args: LAUNCH_ARGS });
const failures = [];
try {
  const target = await browser.waitForTarget(
    (candidate) => candidate.type() === "service_worker" && candidate.url().includes("service-worker.js"),
    { timeout: 30000 },
  );
  const extensionId = new URL(target.url()).host;
  console.log(`extension id : ${extensionId}`);

  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") pageErrors.push(message.text());
  });

  await page.goto(`chrome-extension://${extensionId}/ocr/ocr.html`, { waitUntil: "load" });
  console.log("page loaded, waiting for the model to come up…");

  // Loading ~111 MB of weights and building two wasm sessions is slow; give it
  // room, but surface the failure message rather than timing out blindly.
  const readyError = await page.evaluate(
    () =>
      new Promise((done) => {
        const timer = setTimeout(() => done("timeout after 180s"), 180000);
        globalThis.OMT_OCR.ready.then(
          () => {
            clearTimeout(timer);
            done(null);
          },
          (error) => {
            clearTimeout(timer);
            done(String(error && error.message ? error.message : error));
          },
        );
      }),
  );
  if (readyError) {
    console.error(`FAIL  engine did not become ready: ${readyError}`);
    failures.push("engine init");
  } else {
    const setup = await page.evaluate(() => globalThis.OMT_OCR.timings);
    console.log(`weights      : ${(setup.modelBytes / 1e6).toFixed(1)} MB in ${setup.loadMs} ms`);
    console.log(`sessions     : ${setup.sessionMs} ms`);
  }

  if (!failures.length) {
    const result = await page.evaluate(
      (path) => globalThis.OMT_OCR.recognizePath(path).then((r) => ({ text: r.text, ms: r.milliseconds, tokens: r.ids.length })),
      crop,
    );
    console.log(`\ntext         : ${result.text}`);
    console.log(`inference    : ${result.ms} ms (${result.tokens} tokens, wasm)`);
    if (expected) {
      if (result.text.trim() === expected.trim()) {
        console.log("\nmatch        : exact");
      } else {
        console.error(`\nFAIL  expected: ${expected}`);
        failures.push("text mismatch");
      }
    }
  }

  if (pageErrors.length) {
    console.error(`\nFAIL  page errors: ${pageErrors.join(" | ")}`);
    failures.push("page errors");
  }
} finally {
  await browser.close();
}

if (failures.length) {
  console.error(`\n${failures.length} problem(s)`);
  process.exit(1);
}
console.log("\non-device OCR works in Chrome");
