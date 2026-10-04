// Box-for-box parity check: the JavaScript region detector against the Python
// original it was ported from.
//
// Run the Python side first (tools/detect_regions_reference.py) and pass both
// files here; the images themselves never enter the repository.
//
//   node tools/regions_parity_test.mjs --rgba work/page.rgba \
//        --size work/page.size.json --reference work/page.regions.json

import { readFileSync } from "node:fs";

import { detectTextRegions } from "../extension/ocr/regions.js";

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const rgbaPath = arg("--rgba", "");
const sizePath = arg("--size", "");
const referencePath = arg("--reference", "");
if (!rgbaPath || !sizePath || !referencePath) {
  console.error("--rgba, --size and --reference are required (see the header of this file)");
  process.exit(2);
}

const raw = readFileSync(rgbaPath);
const size = JSON.parse(readFileSync(sizePath, "utf8"));
const reference = JSON.parse(readFileSync(referencePath, "utf8"));

const image = {
  data: new Uint8ClampedArray(raw.buffer, raw.byteOffset, raw.byteLength),
  width: size.width,
  height: size.height,
};

const started = Date.now();
const actual = detectTextRegions(image, 24);
const elapsed = Date.now() - started;

const expected = reference.regions;
console.log(`image      : ${size.width}x${size.height}`);
console.log(`reference  : ${expected.length} regions (python)`);
console.log(`actual     : ${actual.length} regions (js, ${elapsed} ms)`);

const areaOf = (box) => (box.right - box.left) * (box.bottom - box.top);
const intersection = (a, b) => {
  const width = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
  const height = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  return width * height;
};
const iou = (a, b) => {
  const overlap = intersection(a, b);
  return overlap / (areaOf(a) + areaOf(b) - overlap);
};

const usedActual = new Set();
let matched = 0;
const misses = [];
for (const want of expected) {
  let best = -1;
  let bestIou = 0;
  actual.forEach((got, index) => {
    if (usedActual.has(index)) return;
    const score = iou(want, got);
    if (score > bestIou) {
      bestIou = score;
      best = index;
    }
  });
  if (best >= 0 && bestIou >= 0.6) {
    matched += 1;
    usedActual.add(best);
  } else {
    misses.push({ want, bestIou: Number(bestIou.toFixed(3)) });
  }
}

const extras = actual.filter((_, index) => !usedActual.has(index));

console.log(`\nmatched    : ${matched}/${expected.length} (IoU >= 0.6)`);
if (misses.length) {
  console.log("missing/unmatched reference regions:");
  for (const miss of misses) {
    const { want } = miss;
    console.log(`  [${want.left},${want.top},${want.right},${want.bottom}] bestIoU=${miss.bestIou}`);
  }
}
if (extras.length) {
  console.log("extra regions the port produced:");
  for (const box of extras) {
    console.log(`  [${box.left},${box.top},${box.right},${box.bottom}]`);
  }
}

const perfect = misses.length === 0 && extras.length === 0;
console.log(perfect ? "\nparity: exact" : "\nparity: differences above");
process.exit(perfect ? 0 : 1);
