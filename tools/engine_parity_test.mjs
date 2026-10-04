// Verify the shipped on-device OCR engine against the server pipeline.
//
// Node stands in for the browser here: the code under test (extension/ocr/engine.js)
// is exactly what the extension loads, only the ORT runtime (node vs wasm) and
// the image source (raw RGBA dump vs canvas) differ. That makes this the fastest
// honest check of the preprocessing + decode logic.
//
// One-time setup:
//   python tools/fetch_ocr_assets.py
//   npm install --no-save onnxruntime-node
//   python tools/build_vocab.py --model-dir <manga-ocr snapshot> --out extension/ocr/vocab.js
//
// Then, with a work dir containing <name>.png, <name>.rgba, <name>.size.json
// and baseline.json (produced by the PyTorch pipeline; see
// docs/BROWSER_OCR_FEASIBILITY.md):
//
//   node tools/engine_parity_test.mjs --work DIR [--num-beams 1]

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as ort from "onnxruntime-node";

import { createOcrEngine, recognize } from "../extension/ocr/engine.js";

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const work = arg("--work", "");
if (!work) {
  console.error("--work DIR is required (see the header of this file)");
  process.exit(2);
}
const modelDir = arg("--model-dir", join(repoRoot, "extension", "models"));
const numBeams = Number(arg("--num-beams", "1"));

const baseline = JSON.parse(readFileSync(join(work, "baseline.json"), "utf8"));

const engine = await createOcrEngine(ort, {
  encoder: join(modelDir, "encoder.onnx"),
  decoder: join(modelDir, "decoder.onnx"),
});
console.log(`sessions ready (num_beams=${numBeams})\n`);

let exact = 0;
let total = 0;
for (const [name, expected] of Object.entries(baseline)) {
  const raw = readFileSync(join(work, `${name}.rgba`));
  const { width, height } = JSON.parse(readFileSync(join(work, `${name}.size.json`), "utf8"));
  const image = {
    data: new Uint8ClampedArray(raw.buffer, raw.byteOffset, raw.byteLength),
    width,
    height,
  };

  const result = await recognize(engine, image, { numBeams });
  const match = result.text.trim() === expected.text.trim();
  exact += match ? 1 : 0;
  total += 1;
  console.log(`${name}  ${(result.milliseconds / 1000).toFixed(2)}s  match=${match}`);
  console.log(`   on-device : ${result.text}`);
  console.log(`   server    : ${expected.text}`);
}

console.log(`\nexact match: ${exact}/${total}`);
process.exit(exact === total ? 0 : 1);
