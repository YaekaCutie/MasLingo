// The message line: everything shares one line, and long messages scroll.
//
// The sample sentence, loading states ("正在 OCR……"), connectivity results and
// errors all live on ONE line inside the panel. Long content scrolls: the
// glyphs move inside a stationary clipping window, out to the end, pause,
// back, pause. The move is a `transform` on the text layer (composited;
// `text-indent` was tried and stuttered on the main thread), and the window is
// the element next to the message dot, so the glyphs can never cover it.
//
// This checks the behaviours that were each broken at some point and reported:
//
//   * a loading state replaces the sample sentence while it runs, and the
//     sentence comes back when the message expires ("一言和加载状态共享一行");
//   * the marquee moves, and repeating the same message does not restart it
//     (auto.js wrote one line per picture, faster than the opening pause — the
//     text measured as frozen: "卡住");
//   * an error replaces everything, does not expire, and comes back after a
//     progress message overlays it — it only goes away when something succeeds;
//   * a success ("ok") clears the held error and the sample sentence returns.
//
// The scripts are injected into a plain page rather than loading the extension,
// so the scenario is deterministic (no backend, no network) and uses the same
// DOM the panel builds in the wild.
//
//   node deploy/check-status-marquee.mjs

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import puppeteer from "puppeteer";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const contentScripts = [
  "extension/config.js", "extension/translation/providers.js",
  "extension/content/glass.js", "extension/content/overlay.js",
  "extension/content/auto.js", "extension/content/panel.js",
  "extension/content/content.js",
].map((name) => readFileSync(join(repoRoot, name), "utf8"));
const contentStyles = ["glass", "window", "status", "marker", "page"]
  .map((name) => readFileSync(join(repoRoot, "extension", "content", "styles", `${name}.css`), "utf8"))
  .join("\n");

const failures = [];
const check = (label, condition, detail = "") => {
  console.log(`  ${condition ? "ok  " : "FAIL"}  ${label}${condition || !detail ? "" : ` — ${detail}`}`);
  if (!condition) failures.push(label);
};

const LONG_INFO = "正在识别第 12 张图片：自动翻译正在依次处理本页检测到的全部文字区域";
const LONG_ERROR = "翻译失败：翻译服务限流了（429）。稍后再试，或在设置里换用其它翻译来源。";

const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 800 });
  await page.setContent("<!doctype html><html><body style='margin:0;height:200vh;background:#2a2e34'></body></html>");
  await page.evaluate(() => {
    globalThis.chrome = {
      runtime: {
        onMessage: { addListener() {} },
        getManifest: () => ({ version: "0.0.0-test" }),
        sendMessage: async () => ({ ok: false }),
      },
      storage: { local: { get: async () => ({}), set: async () => {} }, onChanged: { addListener() {} } },
    };
  });
  await page.addStyleTag({ content: contentStyles });
  await page.addScriptTag({ content: contentScripts.join("\n;\n") });

  const result = await page.evaluate(async (longInfo, longError) => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    /** The x the text layer is currently translated by. */
    const txOf = (node) => {
      const transform = getComputedStyle(node).transform;
      if (!transform || transform === "none") return 0;
      const match = transform.match(/matrix\(([^)]+)\)/);
      return match ? Number(match[1].split(",")[4]) : 0;
    };

    globalThis.MAS_panel.mount();
    const line = document.getElementById("maslingo-line");
    const clip = line.querySelector(".maslingo-line-clip");
    const text = document.getElementById("maslingo-line-text");
    const dot = document.getElementById("maslingo-line-dot");
    const widget = document.getElementById("maslingo-widget-text");

    // --- a loading state shares the line with the sample sentence ----------
    globalThis.MAS_panel.status(longInfo, "info");
    const infoGeometry = {
      dotVisible: dot.hidden === false,
      kind: line.dataset.kind,
      scrolling: line.classList.contains("maslingo-scrolling"),
      animation: getComputedStyle(text).animationName,
      windowTransform: getComputedStyle(clip).transform,
      distance: text.style.getPropertyValue("--maslingo-marquee-distance"),
      windowLeft: Math.round(clip.getBoundingClientRect().left),
      dotRight: Math.round(dot.getBoundingClientRect().right),
      widget: widget.textContent,
    };
    await wait(1500);
    const infoA = txOf(text);
    await wait(700);
    const infoB = txOf(text);
    const infoRepeats = [];
    for (let i = 0; i < 4; i += 1) {
      globalThis.MAS_panel.status(longInfo, "info");
      await wait(700);
      infoRepeats.push(txOf(text));
    }

    // A resize is what browser zoom fires. The marquee has to re-measure for
    // the new layout — a distance measured before the resize can clip the tail
    // or overshoot — which shows up as the animation restarting from its
    // opening pause.
    await wait(2200);
    const beforeResize = txOf(text);
    window.dispatchEvent(new Event("resize"));
    await wait(600);
    const resizeState = {
      before: beforeResize,
      after: txOf(text),
      scrolling: line.classList.contains("maslingo-scrolling"),
      distance: text.style.getPropertyValue("--maslingo-marquee-distance"),
    };

    await wait(1600); // remainder of the dwell: the sample sentence must be back
    const infoExpired = { kind: line.dataset.kind, text: text.textContent, dotHidden: dot.hidden };

    // --- an error replaces everything and is held ---------------------------
    globalThis.MAS_panel.status(longError, "error");
    const errorGeometry = {
      dotVisible: dot.hidden === false,
      kind: line.dataset.kind,
      text: text.textContent,
      scrolling: line.classList.contains("maslingo-scrolling"),
      animation: getComputedStyle(text).animationName,
      windowTransform: getComputedStyle(clip).transform,
      distance: text.style.getPropertyValue("--maslingo-marquee-distance"),
      widget: widget.textContent,
    };
    await wait(1500);
    const errA = txOf(text);
    await wait(700);
    const errB = txOf(text);
    const errRepeats = [];
    for (let i = 0; i < 4; i += 1) {
      globalThis.MAS_panel.status(longError, "error");
      await wait(700);
      errRepeats.push(txOf(text));
    }
    await wait(4600); // past every dwell the messages might expire on
    const errPersisted = { kind: line.dataset.kind, text: text.textContent };

    // A progress message overlays the held error briefly, then it returns.
    globalThis.MAS_panel.status(longInfo, "info");
    await wait(300);
    const overlaid = { kind: line.dataset.kind, text: text.textContent, widget: widget.textContent };
    await wait(4400);
    const errReturned = { kind: line.dataset.kind, text: text.textContent, widget: widget.textContent };

    // --- resolution ---------------------------------------------------------
    globalThis.MAS_panel.status("翻译完成", "ok");
    await wait(250);
    const okShown = { kind: line.dataset.kind, text: text.textContent, widget: widget.textContent };
    await wait(4400);
    const resolved = {
      kind: line.dataset.kind,
      text: text.textContent,
      dotHidden: dot.hidden,
      widget: widget.textContent,
    };

    return {
      infoGeometry, infoA, infoB, infoRepeats, resizeState, infoExpired,
      errorGeometry, errA, errB, errRepeats, errPersisted,
      overlaid, errReturned, okShown, resolved,
    };
  }, LONG_INFO, LONG_ERROR);

  console.log(`      进度消息几何 ${JSON.stringify(result.infoGeometry)}`);
  console.log(`      进度位移：单次 ${result.infoA} -> ${result.infoB}；重复期间 ${result.infoRepeats.join(" -> ")}`);
  console.log(`      resize（缩放）后：${JSON.stringify(result.resizeState)}`);
  console.log(`      进度结束后：${JSON.stringify(result.infoExpired)}`);
  console.log(`      错误几何 ${JSON.stringify(result.errorGeometry)}`);
  console.log(`      错误位移：单次 ${result.errA} -> ${result.errB}；重复期间 ${result.errRepeats.join(" -> ")}`);
  console.log(`      4.6 秒后错误仍在：${JSON.stringify(result.errPersisted)}`);
  console.log(`      进度覆盖时：${JSON.stringify(result.overlaid)} → 恢复：${JSON.stringify(result.errReturned)}`);
  console.log(`      解决后：${JSON.stringify(result.okShown)} → ${JSON.stringify(result.resolved)}`);

  check("加载状态写进同一行（替换样句），并显示状态点",
    result.infoGeometry.kind === "info"
      && result.infoGeometry.dotVisible === true
      && result.infoGeometry.scrolling === true
      && parseFloat(result.infoGeometry.distance) > 0,
    JSON.stringify(result.infoGeometry));
  check("裁剪窗口固定不动（transform none），且左缘在状态点右侧",
    result.infoGeometry.windowTransform === "none"
      && result.infoGeometry.windowLeft >= result.infoGeometry.dotRight - 1,
    JSON.stringify(result.infoGeometry));
  check("加载文字确实在移动（transform 位移在变）",
    result.infoA !== result.infoB && (result.infoA !== 0 || result.infoB !== 0),
    `${result.infoA} / ${result.infoB}`);
  check("相同进度消息反复写入不会重置滚动（回归）",
    result.infoRepeats[result.infoRepeats.length - 1] !== result.infoRepeats[0]
      && new Set(result.infoRepeats).size >= 3,
    result.infoRepeats.join(" / "));
  check("resize/缩放后重新测量、滚动继续（动画重置到起点）",
    result.resizeState.scrolling === true
      && parseFloat(result.resizeState.distance) > 0
      && Math.abs(result.resizeState.after) < Math.abs(result.resizeState.before) - 20,
    JSON.stringify(result.resizeState));
  check("进度结束后样句回来（点隐藏、无滚动）",
    result.infoExpired.kind === ""
      && result.infoExpired.dotHidden === true
      && result.infoExpired.text.startsWith("「")
      && result.infoExpired.text.endsWith("」"),
    JSON.stringify(result.infoExpired));
  check("缩略挂件只显示短状态（进度：正在 OCR 中）",
    result.infoGeometry.widget === "正在 OCR 中",
    result.infoGeometry.widget);

  check("错误替换样句、显示红点并进入走马灯",
    result.errorGeometry.kind === "error"
      && result.errorGeometry.text === LONG_ERROR
      && result.errorGeometry.dotVisible === true
      && result.errorGeometry.scrolling === true
      && result.errorGeometry.windowTransform === "none",
    JSON.stringify(result.errorGeometry));
  check("错误文字确实在移动",
    result.errA !== result.errB && (result.errA !== 0 || result.errB !== 0),
    `${result.errA} / ${result.errB}`);
  check("相同错误反复写入不会重置滚动（回归）",
    result.errRepeats[result.errRepeats.length - 1] !== result.errRepeats[0]
      && new Set(result.errRepeats).size >= 3,
    result.errRepeats.join(" / "));
  check("错误不会自动消失（4.6 秒后仍在）",
    result.errPersisted.kind === "error" && result.errPersisted.text === LONG_ERROR,
    JSON.stringify(result.errPersisted));
  check("报错时挂件只显示关键信息（翻译失败，不含详情）",
    result.errorGeometry.widget === "翻译失败",
    result.errorGeometry.widget);
  check("进度消息暂时覆盖错误，结束后错误回来（仍被持有）",
    result.overlaid.kind === "info"
      && result.errReturned.kind === "error"
      && result.errReturned.text === LONG_ERROR,
    `${JSON.stringify(result.overlaid)} -> ${JSON.stringify(result.errReturned)}`);
  check("进度覆盖结束后挂件回到仍持有的错误（翻译失败）",
    result.overlaid.widget === "正在 OCR 中" && result.errReturned.widget === "翻译失败",
    `${result.overlaid.widget} -> ${result.errReturned.widget}`);
  check("解决后（ok）错误消失、样句回来、点隐藏",
    result.okShown.kind === "ok"
      && result.resolved.kind === ""
      && result.resolved.dotHidden === true
      && result.resolved.text.startsWith("「"),
    `${JSON.stringify(result.okShown)} -> ${JSON.stringify(result.resolved)}`);
  check("成功后挂件显示「翻译成功」并在 3 秒内淡出恢复默认",
    result.okShown.widget === "翻译成功" && result.resolved.widget === "自动翻译",
    `${result.okShown.widget} -> ${result.resolved.widget}`);
} finally {
  await browser.close();
}

console.log("");
if (failures.length) {
  console.error(`${failures.length} 项不合格`);
  process.exit(1);
}
console.log("消息行行为合格（共享一行 / 走马灯 / 重复不重置 / 错误持久直到解决）");
