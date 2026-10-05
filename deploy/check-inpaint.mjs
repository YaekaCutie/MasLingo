// Content-script rendering checks.
//
// Two things are verified here:
//  1. "完善翻译后背景" — the background reconstruction is scored against a
//     synthetic patch whose true background is known, old algorithm vs new.
//     A quality claim gets a number rather than an opinion.
//  2. "不要新建窗口显示翻译结果" — the translation result must never appear in a
//     panel of its own; it is painted over the original text, and the only
//     chrome the script adds is a small self-dismissing status line.
//
// The old algorithm is reproduced verbatim below as the baseline.
//
//   node deploy/check-inpaint.mjs

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import puppeteer from "puppeteer";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const contentScript = readFileSync(join(repoRoot, "extension", "content", "content.js"), "utf8");
// The stylesheet has to come along too, otherwise class-based assertions test
// nothing: the first run of this check passed the element into existence and
// then found it had no positioning at all.
const contentStyles = readFileSync(join(repoRoot, "extension", "content", "styles.css"), "utf8");

const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const failures = [];
const check = (name, condition, detail = "") => {
  if (condition) {
    console.log(`  ok    ${name}`);
  } else {
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
    failures.push(name);
  }
};
try {
  const page = await browser.newPage();
  page.on("pageerror", (error) => failures.push(`page error: ${error.message}`));

  // A blank page whose only content is the real content script, with just
  // enough of the chrome API stubbed for it to load.
  await page.setContent("<!doctype html><html><body></body></html>");
  await page.evaluate(() => {
    globalThis.chrome = { runtime: { onMessage: { addListener() {} } } };
  });
  await page.addStyleTag({ content: contentStyles });
  await page.addScriptTag({ content: contentScript });

  const result = await page.evaluate(() => {
    const WIDTH = 240;
    const HEIGHT = 140;

    // Deterministic noise so runs are comparable.
    let seed = 12345;
    const random = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };

    // Scenarios are chosen to be the cases a four-point blend cannot handle.
    // A plain linear gradient is included as a control: bilinear reproduces
    // that exactly, so it must not regress there.
    const scenarios = {
      // The real manga case: flat balloon paper with black lettering. The result
      // has to be clean uniform paper — anything left of the original shows up
      // as a grey speck on white, which is exactly what "看起来像糊了" means.
      balloon: { truth: () => 236, soft: false, contaminated: false, texture: 0, tint: [0, 0, 0] },
      balloonCream: { truth: () => 231, soft: false, contaminated: false, texture: 0, tint: [5, 4, -9] },
      linear: { truth: (x, y) => 238 - 34 * (x / WIDTH) - 22 * (y / HEIGHT), soft: false, contaminated: false, texture: 0 },
      vignette: {
        // Curved falloff: no four corner-ish samples can follow this.
        truth: (x, y) => {
          const dx = (x - WIDTH / 2) / (WIDTH / 2);
          const dy = (y - HEIGHT / 2) / (HEIGHT / 2);
          return 244 - 52 * Math.min(1, Math.sqrt(dx * dx + dy * dy));
        },
        soft: false, contaminated: false, texture: 0,
      },
      softGlyphs: { truth: (x, y) => 238 - 34 * (x / WIDTH), soft: true, contaminated: false, texture: 0 },
      contaminatedEdge: { truth: (x, y) => 238 - 20 * (y / HEIGHT), soft: false, contaminated: true, texture: 0 },
      textured: { truth: (x, y) => 236 - 26 * (x / WIDTH), soft: false, contaminated: false, texture: 9 },
    };

    const glyphBoxes = [];
    for (let row = 0; row < 3; row += 1) {
      for (let col = 0; col < 6; col += 1) {
        const x = 34 + col * 30;
        const y = 26 + row * 36;
        if ((row + col) % 3 === 0) glyphBoxes.push([x, y, x + 20, y + 3]);
        else glyphBoxes.push([x, y, x + 17, y + 19]);
      }
    }

    // A dark band that crosses the box border, like a panel edge — the case
    // that makes a single-pixel edge sample fetch pure ink.
    const contamination = { left: 0, top: 60, right: 26, bottom: 84 };

    const buildPatch = (scenario) => {
      const tint = scenario.tint || [0, 0, 0];
      const data = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
      for (let y = 0; y < HEIGHT; y += 1) {
        for (let x = 0; x < WIDTH; x += 1) {
          let value = scenario.truth(x, y);
          if (scenario.texture) value += (random() - 0.5) * scenario.texture * 2;
          value = Math.max(0, Math.min(255, value));
          const offset = (y * WIDTH + x) * 4;
          data[offset] = value + tint[0];
          data[offset + 1] = value + tint[1];
          data[offset + 2] = value + tint[2];
          data[offset + 3] = 255;
        }
      }
      if (scenario.contaminated) {
        for (let y = contamination.top; y < contamination.bottom; y += 1) {
          for (let x = contamination.left; x < contamination.right; x += 1) {
            const offset = (y * WIDTH + x) * 4;
            data[offset] = 16; data[offset + 1] = 16; data[offset + 2] = 18;
          }
        }
      }
      for (const [left, top, right, bottom] of glyphBoxes) {
        for (let y = top; y < bottom; y += 1) {
          for (let x = left; x < right; x += 1) {
            const offset = (y * WIDTH + x) * 4;
            // Soft glyphs ramp from paper to ink over two pixels — the
            // antialiased fringe that a hard threshold leaves behind.
            let ink = 1;
            if (scenario.soft) {
              const edge = Math.min(x - left, y - top, right - 1 - x, bottom - 1 - y);
              ink = Math.min(1, Math.max(0, (edge + 1) / 2));
            }
            const paper = data[offset];
            const value = paper * (1 - ink) + 18 * ink;
            data[offset] = value; data[offset + 1] = value; data[offset + 2] = value + ink * 2;
          }
        }
      }
      return data;
    };

    // --- the algorithm as it was, kept as the baseline ----------------------
    const oldAlgorithm = (data, box) => {
      const { left, top, right, bottom } = box;
      const sample = (x, y, channel) => data[(y * WIDTH + x) * 4 + channel];
      const horizontalMargin = Math.max(1, Math.round(WIDTH * 0.004));
      const verticalMargin = Math.max(1, Math.round(HEIGHT * 0.004));
      for (let y = top; y < bottom; y += 1) {
        const sampleTop = Math.max(0, top - verticalMargin);
        const sampleBottom = Math.min(HEIGHT - 1, bottom + verticalMargin);
        const verticalPosition = (y - sampleTop) / Math.max(1, sampleBottom - sampleTop);
        for (let x = left; x < right; x += 1) {
          const sampleLeft = Math.max(0, left - horizontalMargin);
          const sampleRight = Math.min(WIDTH - 1, right + horizontalMargin);
          const horizontalPosition = (x - sampleLeft) / Math.max(1, sampleRight - sampleLeft);
          let difference = 0;
          const background = [];
          for (let channel = 0; channel < 3; channel += 1) {
            const horizontal = sample(sampleLeft, y, channel) * (1 - horizontalPosition) +
              sample(sampleRight, y, channel) * horizontalPosition;
            const vertical = sample(x, sampleTop, channel) * (1 - verticalPosition) +
              sample(x, sampleBottom, channel) * verticalPosition;
            background[channel] = (horizontal + vertical) / 2;
            difference = Math.max(difference, Math.abs(sample(x, y, channel) - background[channel]));
          }
          if (difference > 28) {
            const offset = (y * WIDTH + x) * 4;
            data[offset] = background[0];
            data[offset + 1] = background[1];
            data[offset + 2] = background[2];
          }
        }
      }
    };

    const glyphPixels = [];
    for (const [left, top, right, bottom] of glyphBoxes) {
      for (let y = top; y < bottom; y += 1) {
        for (let x = left; x < right; x += 1) glyphPixels.push([x, y]);
      }
    }

    // `truth` must describe what the paper actually looks like, tint included —
    // otherwise a tinted sample scores a constant offset as pure error.
    const lumaOf = (scenario, x, y) => scenario.truth(x, y) + ((scenario.tint || [0, 0, 0])[0]);

    const score = (data, scenario) => {
      let sum = 0;
      let worst = 0;
      let ghost = 0;
      const values = [];
      for (const [x, y] of glyphPixels) {
        const offset = (y * WIDTH + x) * 4;
        const expected = lumaOf(scenario, x, y);
        const error = Math.abs(data[offset] - expected);
        sum += error;
        worst = Math.max(worst, error);
        values.push(data[offset]);
        // "Ghost" = a pixel that should be paper but still reads as ink.
        if (data[offset] < expected - 45) ghost += 1;
      }
      // Spread across the repaired area. A flat fill scores ~0; a smeared one
      // (the "糊" the user described) scores high even when its average is close.
      const mean = values.reduce((total, value) => total + value, 0) / values.length;
      const variance = values.reduce((total, value) => total + (value - mean) ** 2, 0) / values.length;
      return {
        meanError: sum / glyphPixels.length,
        maxError: worst,
        ghostPercent: (ghost / glyphPixels.length) * 100,
        fillSpread: Math.sqrt(variance),
      };
    };

    const box = { left: 24, top: 16, right: 216, bottom: 124 };
    const report = {};
    for (const [name, scenario] of Object.entries(scenarios)) {
      const oldData = buildPatch(scenario);
      oldAlgorithm(oldData, box);
      const newData = buildPatch(scenario);
      reconstructBackground(newData, WIDTH, HEIGHT, box);
      report[name] = { old: score(oldData, scenario), next: score(newData, scenario) };
    }

    // Untouched artwork outside the box must stay untouched.
    const control = scenarios.linear;
    const reference = buildPatch(control);
    const newData = buildPatch(control);
    reconstructBackground(newData, WIDTH, HEIGHT, box);
    let outsideChanged = 0;
    for (let y = 0; y < HEIGHT; y += 1) {
      for (let x = 0; x < WIDTH; x += 1) {
        if (x >= box.left && x < box.right && y >= box.top && y < box.bottom) continue;
        const offset = (y * WIDTH + x) * 4;
        if (newData[offset] !== reference[offset]) outsideChanged += 1;
      }
    }

    return { report, outsideChanged, glyphCount: glyphPixels.length };
  });

  console.log(`glyph pixels : ${result.glyphCount}\n`);
  console.log("场景                 旧:平均  旧:最大  旧:残影   新:平均  新:最大  新:残影  新:平整度");
  const labels = {
    balloon: "白气球（真实场景）",
    balloonCream: "米色气球（带色调）",
    linear: "线性渐变（对照）",
    vignette: "径向渐变（非线性）",
    softGlyphs: "抗锯齿软边字形",
    contaminatedEdge: "边缘被墨迹污染",
    textured: "带纸张噪点",
  };
  for (const [name, entry] of Object.entries(result.report)) {
    const label = (labels[name] || name).padEnd(18, " ");
    console.log(
      `${label} ${entry.old.meanError.toFixed(1).padStart(6)}  ${entry.old.maxError.toFixed(0).padStart(6)}  ` +
      `${entry.old.ghostPercent.toFixed(1).padStart(5)}%  ${entry.next.meanError.toFixed(1).padStart(6)}  ` +
      `${entry.next.maxError.toFixed(0).padStart(6)}  ${entry.next.ghostPercent.toFixed(1).padStart(5)}%  ` +
      `${entry.next.fillSpread.toFixed(1).padStart(8)}`,
    );
  }
  console.log(`\n文字框外的像素被改动: ${result.outsideChanged}（应为 0）`);

  // The control must not regress; the hard scenarios must improve.
  const control = result.report.linear;
  if (control.next.meanError > control.old.meanError + 0.5) {
    failures.push(`对照场景退步：${control.next.meanError.toFixed(1)} vs ${control.old.meanError.toFixed(1)}`);
  }
  // Passing criteria are about *visible* quality, not raw arithmetic:
  //  * where the old algorithm was already accurate (mean error under ~3 grey
  //    levels) the only requirement is no meaningful regression — a fifth of a
  //    grey level is indistinguishable;
  //  * where it was visibly wrong, the replacement has to be substantially
  //    better, which is the whole point of the change.
  const VISIBLE = 3;
  const NEGLIGIBLE = 0.6;
  // The flat-balloon cases are the ones the user actually sees, and there the
  // bar is higher: nothing left of the original and a perfectly even fill.
  for (const name of ["balloon", "balloonCream"]) {
    const entry = result.report[name];
    if (entry.next.meanError > 2.5) {
      failures.push(`${labels[name]} 与背景色差 ${entry.next.meanError.toFixed(1)}，超过 2.5`);
    }
    if (entry.next.ghostPercent > 0.2) {
      failures.push(`${labels[name]} 仍有 ${entry.next.ghostPercent.toFixed(1)}% 原墨迹残留`);
    }
    if (entry.next.fillSpread > 3) {
      failures.push(`${labels[name]} 填补区域不平整（标准差 ${entry.next.fillSpread.toFixed(1)}，像糊了）`);
    }
  }
  for (const name of ["vignette", "softGlyphs", "contaminatedEdge", "textured"]) {
    const entry = result.report[name];
    if (entry.old.meanError > VISIBLE) {
      if (entry.next.meanError >= entry.old.meanError * 0.6) {
        failures.push(
          `${labels[name]} 改善不足（${entry.next.meanError.toFixed(1)} vs ${entry.old.meanError.toFixed(1)}）`,
        );
      }
    } else if (entry.next.meanError > entry.old.meanError + NEGLIGIBLE) {
      failures.push(
        `${labels[name]} 出现可见退步（${entry.next.meanError.toFixed(1)} vs ${entry.old.meanError.toFixed(1)}）`,
      );
    }
    if (entry.next.ghostPercent > entry.old.ghostPercent + 0.2) {
      failures.push(`${labels[name]} 残影变多（${entry.next.ghostPercent.toFixed(1)}% vs ${entry.old.ghostPercent.toFixed(1)}%）`);
    }
  }
  if (result.outsideChanged !== 0) {
    failures.push(`改动了文字框外的 ${result.outsideChanged} 个像素`);
  }

  // --- the overlay must never become its own window -------------------------
  console.log("\n译文呈现方式");
  const overlay = await page.evaluate(() => {
    const out = {};
    out.noticeFunctionRemoved = typeof showTranslationNotice === "undefined";

    // A toast is the only chrome allowed, and it must dismiss itself.
    showToast("测试提示", "info");
    const toast = document.getElementById("mt-toast");
    out.toastCreated = Boolean(toast);
    out.toastText = toast ? toast.textContent : null;
    out.toastFixed = toast ? getComputedStyle(toast).position === "fixed" : false;
    out.toastPassive = toast ? getComputedStyle(toast).pointerEvents === "none" : false;

    // Translation disabled: nothing may be left covering the artwork.
    activeRequestId = "check-1";
    showTranslationResult({ requestId: "check-1", mode: "none", result: {} });
    out.panelsAfterNone = document.querySelectorAll(".mt-overlay, .mt-overlay-status").length;
    out.canvasesAfterNone = document.querySelectorAll("canvas.mt-overlay-text-canvas").length;

    hideToast();
    out.toastRemoved = document.getElementById("mt-toast") === null;
    return out;
  });

  check("旧的居中结果面板函数已移除", overlay.noticeFunctionRemoved);
  check("状态提示是角落小条", overlay.toastCreated && overlay.toastFixed, JSON.stringify(overlay));
  check("状态提示不拦截鼠标", overlay.toastPassive);
  check("提示可自行消失", overlay.toastRemoved);
  check("关闭翻译时不留下任何面板", overlay.panelsAfterNone === 0, `还有 ${overlay.panelsAfterNone} 个`);
  check("关闭翻译时不留下覆盖画布", overlay.canvasesAfterNone === 0, `还有 ${overlay.canvasesAfterNone} 个`);
} finally {
  await browser.close();
}

if (failures.length) {
  console.error(`\n${failures.length} 项不合格：`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log("\n背景重建合格：残墨清干净，且没有动到文字框外的画面");
