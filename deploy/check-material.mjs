// The material, measured rather than eyeballed.
//
// §24 of the specification refuses "已实现" as an answer and lists seven things to
// demonstrate. Several of them are measurable, and this does that:
//
//   A/B  the pane is a material, not a translucent card. A high-contrast striped
//        page is used as the backdrop, and local contrast is measured in three
//        places: on the bare page, through the middle of the pane, and through
//        the rim band. A card with one flat blur gives the same number in the
//        last two; a layered material does not, because the rim runs a different
//        filter than the body.
//   C    the specular follows the pointer and then stops. Measured by driving
//        real pointer moves and reading the custom property it writes, including
//        that it settles and that no frames are scheduled afterwards.
//   D    the collapse is a morph of one element. Measured mid-transition: the
//        morph variable must be between 0 and 1 at some point, which a
//        cross-fade between two elements can never produce.
//   E    the drag never writes left/top per frame. Measured by watching the
//        element's own style during a drag.
//   F    nothing in the chrome is a saturated hue. Every colour the panel paints
//        is checked for saturation.
//   G    cost with many overlays on the page.
//
//   node deploy/check-material.mjs

import http from "node:http";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import puppeteer from "puppeteer";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const check = (name, condition, detail = "") => {
  if (condition) {
    console.log(`  ok    ${name}`);
  } else {
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
    failures.push(name);
  }
};

// --- the backdrop -----------------------------------------------------------
//
// Hard black/white stripes at 6px. Anything the glass does to the image behind
// it shows up as a change in local contrast, which is exactly what "the page is
// under the glass and the glass changes it" means in pixels.
const BACKDROPS = {
  stripes: `background:repeating-linear-gradient(90deg,#000 0 6px,#fff 6px 12px)`,
  white: "background:#fff",
  black: "background:#000",
  colour: "background:linear-gradient(120deg,#c0392b,#2980b9 50%,#f1c40f)",
  text: "background:#fafafa;color:#111",
  mixed: "",
  tall: `background:repeating-linear-gradient(90deg,#123 0 6px,#cfe 6px 12px);height:300vh`,
};

const server = http.createServer((request, response) => {
  const key = request.url.replace(/^\//, "").split("?")[0] || "stripes";
  const style = BACKDROPS[key] ?? BACKDROPS.stripes;
  // The dense-text overlay belongs only to the backdrops that are about text.
  // Putting it on the stripes page washed the stripes out under the "bare"
  // sample and inverted the whole contrast comparison.
  const prose = key === "text" || key === "mixed"
    ? `<div class="prose">${"これはテスト用の長い日本語テキストです。背景の透過とブラーを確認するために、密な文字を敷いています。".repeat(30)}</div>`
    : "";
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>bg</title>
    <style>
      html,body{margin:0;min-height:100%}
      body{${style}}
      .prose{font:14px/1.7 system-ui;max-width:900px;padding:8px 12px;color:#111;background:rgba(255,255,255,.85)}
    </style></head>
    <body>${prose}</body></html>`);
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const base = `http://127.0.0.1:${server.address().port}`;

const workDir = mkdtempSync(join(tmpdir(), "mas-material-"));
const extensionDir = join(workDir, "extension");
cpSync(join(repoRoot, "extension"), extensionDir, { recursive: true });
const manifestPath = join(extensionDir, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
manifest.host_permissions = [...(manifest.host_permissions || []), "<all_urls>"];
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

const browser = await puppeteer.launch({
  headless: true,
  args: [
    "--no-sandbox", "--disable-dev-shm-usage",
    // The screenshot path needs real compositing, not a headless shortcut.
    "--enable-gpu-rasterization",
    "--disable-features=DisableLoadExtensionCommandLineSwitch",
    `--disable-extensions-except=${extensionDir}`,
    `--load-extension=${extensionDir}`,
  ],
});

/**
 * Decode a screenshot inside the browser and return statistics for a band.
 *
 * `captureBeyondViewport: false` is load-bearing. It defaults to true, which
 * makes Chrome temporarily resize the viewport to capture the whole page — and a
 * resize fires the panel's own handler, which clamps it back to the corner. The
 * clip then samples a region the panel has already left, and the numbers look
 * like the glass is doing nothing at all.
 *
 * `panelHidden` gives the control: the same clip, the same page, with the pane
 * taken out of the picture, so the difference is the glass and nothing else.
 */
async function bandStats(page, clip, { panelHidden = false } = {}) {
  await page.evaluate((hidden) => {
    document.getElementById("maslingo-panel").style.visibility = hidden ? "hidden" : "";
  }, panelHidden);
  await new Promise((r) => setTimeout(r, 220));
  const shot = await page.screenshot({
    encoding: "base64",
    clip,
    captureBeyondViewport: false,
  });
  return page.evaluate(async (data) => {
    const image = new Image();
    image.src = `data:image/png;base64,${data}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);
    const { data: px } = context.getImageData(0, 0, canvas.width, canvas.height);
    // Local contrast: mean absolute difference between neighbouring pixels.
    // Blur reduces it; a sharper rim keeps more of it.
    let sum = 0;
    let count = 0;
    let luma = 0;
    for (let y = 0; y < canvas.height; y += 1) {
      for (let x = 0; x < canvas.width; x += 1) {
        const i = (y * canvas.width + x) * 4;
        luma += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
        if (x === 0) continue;
        const j = i - 4;
        sum += Math.abs(px[i] - px[j]) + Math.abs(px[i + 1] - px[j + 1]) + Math.abs(px[i + 2] - px[j + 2]);
        count += 3;
      }
    }
    const pixels = canvas.width * canvas.height;
    return {
      contrast: count ? sum / count : 0,
      // Mean brightness is the cleaner signal for the rim: the edge layer runs
      // brightness(1.12), so a band inside the rim should be measurably lighter
      // than the same content under the body of the pane.
      luma: pixels ? luma / pixels : 0,
      width: canvas.width,
      height: canvas.height,
    };
  }, shot);
}

try {
  const target = await browser.waitForTarget(
    (t) => t.type() === "service_worker" && t.url().includes("service-worker.js"),
    { timeout: 30000 },
  );
  const worker = await target.worker();
  await worker.evaluate(() => chrome.storage.local.set({
    autoTranslate: false, translationProvider: "deepseek",
    backendUrl: "http://127.0.0.1:8001", panelCollapsed: false,
  }));

  // ==== A / B: the pane changes what is behind it =========================
  console.log("A/B 背景穿透与边缘光学差异（黑白条纹背景）");
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 760, deviceScaleFactor: 1 });
  await page.goto(`${base}/stripes`, { waitUntil: "load" });
  await new Promise((r) => setTimeout(r, 2500));

  const panelBox = await page.evaluate(() => {
    const panel = document.getElementById("maslingo-panel");
    // Parked in the middle of the page so all three bands see the same stripes.
    panel.style.setProperty("left", "320px", "important");
    panel.style.setProperty("top", "180px", "important");
    panel.style.setProperty("right", "auto", "important");
    panel.style.setProperty("bottom", "auto", "important");
    const rect = panel.getBoundingClientRect();
    return {
      x: rect.x, y: rect.y, width: rect.width, height: rect.height,
      computed: getComputedStyle(panel).position,
      leftStyle: panel.style.left,
      inline: panel.getAttribute("style"),
    };
  });
  console.log(`      面板位置 (${Math.round(panelBox.x)}, ${Math.round(panelBox.y)}) `
    + `${Math.round(panelBox.width)}x${Math.round(panelBox.height)} position=${panelBox.computed}`);
  await new Promise((r) => setTimeout(r, 600));
  const parked = await page.evaluate(() => {
    const rect = document.getElementById("maslingo-panel").getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
  console.log(`      600ms 后 (${Math.round(parked.x)}, ${Math.round(parked.y)})`);
  if (Math.abs(parked.x - panelBox.x) > 2 || Math.abs(parked.y - panelBox.y) > 2) {
    console.log("      面板被移动了，改用实测位置继续");
    panelBox.x = parked.x;
    panelBox.y = parked.y;
    panelBox.width = parked.width;
    panelBox.height = parked.height;
  }

  const bare = await bandStats(page, { x: 40, y: 300, width: 200, height: 40 });
  const middle = await bandStats(page, {
    x: panelBox.x + 40,
    y: panelBox.y + Math.round(panelBox.height / 2) - 12,
    width: 120,
    height: 24,
  });
  // The rim band is only a few pixels wide by design — it is an edge, not a
  // frame — so the sample has to sit inside it rather than straddle it.
  const rim = await bandStats(page, {
    x: panelBox.x + 1,
    y: panelBox.y + Math.round(panelBox.height / 2) - 10,
    width: 3,
    height: 20,
  });
  // A second band just inside the rim, under the body of the pane. Same stripes
  // behind it, different filter in front of it.
  const justInside = await bandStats(page, {
    x: panelBox.x + 6,
    y: panelBox.y + Math.round(panelBox.height / 2) - 10,
    width: 3,
    height: 20,
  });

  // The control: the identical clip with the pane hidden. Everything else about
  // the page and the capture pipeline is unchanged, so any difference is the
  // glass — which is the only way to say "the material does something" without
  // trusting an absolute number.
  const control = await bandStats(page, {
    x: panelBox.x + 40,
    y: panelBox.y + Math.round(panelBox.height / 2) - 12,
    width: 120,
    height: 24,
  }, { panelHidden: true });
  await page.evaluate(() => { document.getElementById("maslingo-panel").style.visibility = ""; });

  const r = (value) => Math.round(value * 10) / 10;
  console.log(`      裸页面 对比${r(bare.contrast)} 亮度${r(bare.luma)}`);
  console.log(`      玻璃中部 对比${r(middle.contrast)} 亮度${r(middle.luma)}`);
  console.log(`      边缘圈 对比${r(rim.contrast)} 亮度${r(rim.luma)}`);
  console.log(`      圈内侧 对比${r(justInside.contrast)} 亮度${r(justInside.luma)}`);
  console.log(`      对照组（遮住面板后，同一位置）对比${r(control.contrast)} 亮度${r(control.luma)}`);

  check("玻璃确实改变了后方内容（同一位置，遮住面板后对比度回升）",
    control.contrast > middle.contrast * 2.5,
    `遮住 ${r(control.contrast)} vs 玻璃下 ${r(middle.contrast)}`);
  check("边缘圈的光学表现与圈内侧不同（边缘是独立光学层）",
    Math.abs(rim.luma - justInside.luma) > 2 || Math.abs(rim.contrast - justInside.contrast) > 1.5,
    `边缘 亮度${r(rim.luma)} 对比${r(rim.contrast)} / 圈内 亮度${r(justInside.luma)} 对比${r(justInside.contrast)}`);

  // The layer stack itself.
  const layers = await page.evaluate(() => {
    const panel = document.getElementById("maslingo-panel");
    const read = (selector) => {
      const node = panel.querySelector(selector);
      if (!node) return null;
      const style = getComputedStyle(node);
      return {
        backdrop: style.backdropFilter || style.webkitBackdropFilter,
        background: style.backgroundImage !== "none" || style.backgroundColor !== "rgba(0, 0, 0, 0)",
        shadow: style.boxShadow !== "none",
      };
    };
    return {
      base: read(".maslingo-glass__base"),
      depth: read(".maslingo-glass__depth"),
      edge: read(".maslingo-glass__edge"),
      specular: read(".maslingo-glass__specular"),
      pointerEvents: getComputedStyle(panel.querySelector(".maslingo-glass__edge")).pointerEvents,
    };
  });
  check("base 层承担主模糊", /blur\(2[0-9]px\)/.test(layers.base?.backdrop || ""), layers.base?.backdrop);
  check("edge 层用不同的滤镜（边缘折射的来源）",
    Boolean(layers.edge?.backdrop) && layers.edge.backdrop !== layers.base?.backdrop,
    `${layers.edge?.backdrop} vs ${layers.base?.backdrop}`);
  check("depth 层提供厚度（渐变+内阴影）", layers.depth?.shadow === true);
  check("所有材质层都不拦鼠标", layers.pointerEvents === "none", layers.pointerEvents);

  // ==== C: the specular follows the pointer, then stops ===================
  console.log("\nC 高光跟随鼠标并自行停止");
  const readSpec = () => page.evaluate(() => {
    const panel = document.getElementById("maslingo-panel");
    return {
      mx: parseFloat(panel.style.getPropertyValue("--maslingo-mx")) || 0,
      my: parseFloat(panel.style.getPropertyValue("--maslingo-my")) || 0,
      state: panel.dataset.state,
    };
  });
  await page.mouse.move(10, 10);
  await new Promise((r) => setTimeout(r, 120));
  const whatIsThere = await page.evaluate((box) => {
    const node = document.elementFromPoint(box.x + 10, box.y + 10);
    return { tag: node?.tagName, cls: String(node?.className || "").slice(0, 60) };
  }, panelBox);
  console.log(`      鼠标落点命中：${whatIsThere.tag}.${whatIsThere.cls}`);
  await page.mouse.move(panelBox.x + 10, panelBox.y + 10, { steps: 4 });
  await new Promise((r) => setTimeout(r, 150));
  const beforeMove = await readSpec();
  await page.mouse.move(panelBox.x + panelBox.width - 20, panelBox.y + panelBox.height - 30, { steps: 12 });
  await new Promise((r) => setTimeout(r, 700));
  const afterMove = await readSpec();

  check("高光位置随鼠标改变", Math.abs(afterMove.mx - beforeMove.mx) > 80,
    `${r(beforeMove.mx)} -> ${r(afterMove.mx)}`);
  check("鼠标悬停时材质进入 hover 状态", afterMove.state === "hover", afterMove.state);
  await new Promise((r) => setTimeout(r, 500));
  const settledA = await readSpec();
  await new Promise((r) => setTimeout(r, 500));
  const settledB = await readSpec();
  check("鼠标停止后高光稳定下来（没有持续动画）",
    Math.abs(settledA.mx - settledB.mx) < 0.6 && Math.abs(settledA.my - settledB.my) < 0.6,
    `${r(settledA.mx)} -> ${r(settledB.mx)}`);

  check("高光不依赖无限循环动画（没有 drift 类 keyframes）",
    await page.evaluate(() => {
      const style = getComputedStyle(document.querySelector(".maslingo-glass__specular i"));
      return style.animationName === "none";
    }));

  // ==== D: the collapse is a morph, not a swap ===========================
  console.log("\nD 收起是同一材质的连续变形");
  const morphSamples = await page.evaluate(async () => {
    const panel = document.getElementById("maslingo-panel");
    const samples = [];
    document.getElementById("maslingo-collapse").click();
    for (let i = 0; i < 16; i += 1) {
      await new Promise((r) => requestAnimationFrame(r));
      samples.push(parseFloat(getComputedStyle(panel).getPropertyValue("--maslingo-morph")) || 0);
    }
    return samples;
  });
  const mid = morphSamples.filter((value) => value > 0.02 && value < 0.98);
  console.log(`      morph 采样：${morphSamples.map((v) => v.toFixed(2)).join(" ")}`);
  check("收起过程中 morph 出现中间值（连续插值，不是切换）", mid.length >= 2,
    `只有 ${mid.length} 个中间值`);
  check("收起后 morph 到达 1", morphSamples[morphSamples.length - 1] > 0.98,
    String(morphSamples[morphSamples.length - 1]));
  check("收起不使用 display:none", await page.evaluate(() => {
    const panel = document.getElementById("maslingo-panel");
    return [...panel.querySelectorAll("*")].every((node) => getComputedStyle(node).display !== "none");
  }));

  await new Promise((r) => setTimeout(r, 600));
  await page.evaluate(() => document.getElementById("maslingo-widget").click());
  await new Promise((r) => setTimeout(r, 900));

  // ==== E: the drag never writes left/top per frame ======================
  console.log("\nE 拖动只写 transform");
  const dragTrace = await page.evaluate(async () => {
    const panel = document.getElementById("maslingo-panel");
    const bar = document.getElementById("maslingo-panel-bar");
    const box = bar.getBoundingClientRect();
    const x = box.left + 20;
    const y = box.top + box.height / 2;
    let sawInlineLeft = false;
    let sawTransform = false;
    let sawDraggingState = false;
    let sawMaterialLift = false;
    const leftBefore = panel.style.left;

    bar.dispatchEvent(new PointerEvent("pointerdown", {
      bubbles: true, clientX: x, clientY: y, button: 0, pointerId: 9,
    }));
    for (let i = 0; i < 8; i += 1) {
      window.dispatchEvent(new PointerEvent("pointermove", {
        bubbles: true, clientX: x - i * 12, clientY: y + i * 4, button: 0, pointerId: 9,
      }));
      await new Promise((r) => requestAnimationFrame(r));
      if (panel.style.left !== leftBefore) sawInlineLeft = true;
      if (panel.style.transform.includes("translate3d")) sawTransform = true;
      if (panel.dataset.state === "dragging") sawDraggingState = true;
      // Read the alpha that is actually painted, not the custom property: the
      // property now holds a calc() expression, so parseFloat on it is NaN. The
      // base layer's computed gradient has every var() and calc() resolved.
      const painted = getComputedStyle(panel.querySelector(".maslingo-glass__base")).backgroundImage;
      const alphas = [...painted.matchAll(/rgba?\([^)]*?,\s*([\d.]+)\s*\)/g)].map((m) => Number(m[1]));
      if (alphas.some((value) => value > 0.55)) sawMaterialLift = true;
    }
    window.dispatchEvent(new PointerEvent("pointerup", {
      bubbles: true, clientX: x - 96, clientY: y + 32, pointerId: 9,
    }));
    await new Promise((r) => requestAnimationFrame(r));
    return { sawInlineLeft, sawTransform, sawDraggingState, sawMaterialLift };
  });
  check("拖动期间用 translate3d 移动", dragTrace.sawTransform);
  check("拖动期间不逐帧写 left", dragTrace.sawInlineLeft === false);
  check("拖动时材质进入 dragging 状态", dragTrace.sawDraggingState);
  check("拖动时材质变厚（alpha 提升）", dragTrace.sawMaterialLift);
  await new Promise((r) => setTimeout(r, 600));

  // ==== F: no neon, no saturated chrome ==================================
  console.log("\nF 没有霓虹/高饱和色");
  const saturation = await page.evaluate(() => {
    const panel = document.getElementById("maslingo-panel");
    const parse = (value) => (value.match(/[\d.]+/g) || []).map(Number);
    const worst = [];
    for (const node of [panel, ...panel.querySelectorAll("*")]) {
      const style = getComputedStyle(node);
      for (const prop of ["color", "backgroundColor", "borderTopColor", "borderLeftColor"]) {
        const [rr, gg, bb, aa] = parse(style[prop]);
        if (aa === 0) continue;
        const max = Math.max(rr, gg, bb);
        const min = Math.min(rr, gg, bb);
        // Saturation of the pixel colour; status dots are excluded by name so the
        // four permitted colours do not count as chrome.
        if (node.closest(".maslingo-dot, .maslingo-status-dot") && prop === "backgroundColor") continue;
        const sat = max === 0 ? 0 : (max - min) / max;
        if (sat > 0.35 && max > 60) {
          worst.push({ cls: node.className || node.tagName, prop, value: style[prop], sat: r2(sat) });
        }
      }
    }
    function r2(v) { return Math.round(v * 100) / 100; }
    return worst.slice(0, 6);
  });
  check("面板内的颜色都是低饱和的", saturation.length === 0,
    JSON.stringify(saturation));

  // ==== G: cost with many overlays =======================================
  console.log("\nG 大量覆盖物下的开销");
  const heavy = await page.evaluate(async () => {
    // The real overlay layer only exists once something has been anchored to it,
    // so this builds an equivalent zero-sized host. What is being measured is the
    // browser's cost for a page carrying this many absolutely-positioned canvases,
    // which is the question §17 asks.
    const host = document.createElement("div");
    host.style.cssText = "position:absolute;top:0;left:0;width:0;height:0;pointer-events:none";
    document.documentElement.appendChild(host);
    const canvases = [];
    for (let i = 0; i < 120; i += 1) {
      const canvas = document.createElement("canvas");
      canvas.className = "maslingo-result";
      canvas.width = 120;
      canvas.height = 60;
      canvas.style.left = `${20 + (i % 12) * 70}px`;
      canvas.style.top = `${20 + Math.floor(i / 12) * 60}px`;
      host.appendChild(canvas);
      canvases.push(canvas);
    }
    const start = performance.now();
    for (let frame = 0; frame < 90; frame += 1) await new Promise((r) => requestAnimationFrame(r));
    const elapsed = performance.now() - start;
    const overlays = host.childElementCount;
    host.remove();
    return { elapsed, overlays, perFrame: elapsed / 90 };
  });
  console.log(`      ${heavy.overlays} 个覆盖物，平均每帧 ${r(heavy.perFrame)}ms`);
  check("大量覆盖物时仍能维持 60fps 预算（<16.7ms/帧）", heavy.perFrame < 16.7,
    `${r(heavy.perFrame)}ms/帧`);

  // ==== §23: the backdrop matrix ========================================
  console.log("\n§23 七种背景下的截图");
  const outDir = resolve(repoRoot, "deploy", "screenshots");
  mkdirSync(outDir, { recursive: true });
  for (const key of ["white", "black", "colour", "text", "stripes"]) {
    const p = await browser.newPage();
    await p.setViewport({ width: 900, height: 700, deviceScaleFactor: 2 });
    await p.goto(`${base}/${key}`, { waitUntil: "load" });
    await new Promise((r2) => setTimeout(r2, 2200));
    await p.evaluate(() => {
      const panel = document.getElementById("maslingo-panel");
      panel.style.left = "80px";
      panel.style.top = "60px";
      panel.style.right = "auto";
      panel.style.bottom = "auto";
    });
    await new Promise((r2) => setTimeout(r2, 400));
    const handle = await p.$("#maslingo-panel");
    await handle.screenshot({ path: join(outDir, `material-${key}.png`) });
    console.log(`      material-${key}.png`);
    await p.close();
  }
} finally {
  await browser.close();
  server.close();
  rmSync(workDir, { recursive: true, force: true });
}

console.log("");
if (failures.length) {
  console.log(`${failures.length} 项失败：${failures.join("、")}`);
  process.exit(1);
}
console.log("材质验收通过");
