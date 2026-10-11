// The in-page panel: does it exist, does it behave, and does it stay out of the
// way?
//
// The panel replaced the popup as the primary surface, so what matters is not
// just that the controls are there but that the thing is usable while reading:
// it can be dragged, it can be collapsed, it never covers the status strip, and
// it never blocks clicks on the page underneath.
//
//   node deploy/check-panel.mjs

import http from "node:http";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

// --- stubs ------------------------------------------------------------------

const ocrCalls = [];
const backend = http.createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ ok: true, backend: "stub" }));
    return;
  }
  if (request.url === "/api/recognize-page") {
    request.on("data", () => {});
    request.on("end", () => {
      ocrCalls.push(1);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        ok: true,
        items: [{
          text: "テスト", bbox: { left: 100, top: 100, right: 400, bottom: 300 },
          direction: "vertical", confidence: 0.95,
        }],
      }));
    });
    return;
  }
  // A working OpenAI-compatible endpoint, so the connectivity check can
  // succeed deterministically (the timer test needs a success to arm its
  // "restore the sample sentence" timer).
  if (request.url === "/v1/chat/completions") {
    request.on("data", () => {});
    request.on("end", () => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        choices: [{ message: { content: "[\"早上好\"]" } }],
      }));
    });
    return;
  }
  response.writeHead(404).end();
});
await new Promise((done) => backend.listen(0, "127.0.0.1", done));
const backendUrl = `http://127.0.0.1:${backend.address().port}`;

// A deliberately large page, so "does not block the page" has something to test.
const pages = http.createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>panel</title>
    <style>
      body{margin:0;background:#2a2a2a;font:14px system-ui}
      #under{position:fixed;left:12px;bottom:12px;width:120px;height:40px;background:#c0503f;color:#fff}
      #page{width:600px;margin:0 auto;padding:16px 0}
      .block{height:700px;background:#e9e9e9;margin-bottom:12px}
    </style></head>
    <body>
      <div id="page"><div class="block">manga 1</div><div class="block">manga 2</div></div>
      <button id="under">页面自己的按钮</button>
    </body></html>`);
});
await new Promise((done) => pages.listen(0, "127.0.0.1", done));
const pageUrl = `http://127.0.0.1:${pages.address().port}/`;

const workDir = mkdtempSync(join(tmpdir(), "maslingo-panel-"));
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
  await worker.evaluate((url) => chrome.storage.local.set({
    backendUrl: url, autoTranslate: false, translationMode: "none", autoConcurrency: 1,
  }), backendUrl);

  const page = await browser.newPage();
  await page.setViewport({ width: 1000, height: 800 });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(pageUrl, { waitUntil: "load" });
  await new Promise((r) => setTimeout(r, 2500));

  console.log("\n悬浮窗结构与位置");
  const layout = await page.evaluate(() => {
    const panel = document.getElementById("maslingo-panel");
    if (!panel) return null;
    const rect = panel.getBoundingClientRect();
    const panelRect = rect;
    const dots = [...panel.querySelectorAll(".maslingo-dot")].map((dot) => {
      const box = dot.getBoundingClientRect();
      return { text: dot.querySelector(".maslingo-dot-text").textContent.trim(), top: box.top, left: box.left };
    });
    // The material is layered, so the pane's own computed backdrop-filter is
    // `none` and always will be. Asking the root was the old contract.
    const baseLayer = panel.querySelector(".maslingo-glass__base");
    const edgeLayer = panel.querySelector(".maslingo-glass__edge");
    const baseStyle = baseLayer ? getComputedStyle(baseLayer) : null;
    const edgeStyle = edgeLayer ? getComputedStyle(edgeLayer) : null;
    const layers = [".maslingo-glass__base", ".maslingo-glass__edge"]
      .map((selector) => Boolean(panel.querySelector(selector)));
    const removedLayers = [".maslingo-glass__depth", ".maslingo-glass__specular"]
      .map((selector) => Boolean(panel.querySelector(selector)));
    return {
      right: window.innerWidth - rect.right,
      bottom: window.innerHeight - rect.bottom,
      width: rect.width,
      glass: baseStyle ? baseStyle.backdropFilter || baseStyle.webkitBackdropFilter : "none",
      noise: baseLayer ? getComputedStyle(baseLayer, "::after").backgroundImage : "",
      edgeBorder: edgeStyle ? `${edgeStyle.borderTopWidth} ${edgeStyle.borderTopStyle}` : "",
      edgeGlass: edgeStyle ? edgeStyle.backdropFilter || edgeStyle.webkitBackdropFilter : "none",
      layers,
      removedLayers,
      position: getComputedStyle(panel).position,
      pointerEvents: getComputedStyle(panel).pointerEvents,
      dots,
      hasAuto: Boolean(panel.querySelector("#maslingo-auto")),
      hasSelect: Boolean(panel.querySelector("#maslingo-select")),
      hasProvider: Boolean(panel.querySelector("#maslingo-provider")),
      hasConnect: Boolean(panel.querySelector("#maslingo-connect")),
      connectAfterSelect: (() => {
        const select = panel.querySelector("#maslingo-provider");
        const button = panel.querySelector("#maslingo-connect");
        return Boolean(select && button && select.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING);
      })(),
      // The line now carries a permanent 来源 note at its right end; the
      // message itself is the inner text node.
      line: panel.querySelector("#maslingo-line-text")?.textContent || "",
      // A short sample sentence must not start the overflow marquee.
      lineScrolling: Boolean(panel.querySelector("#maslingo-line.maslingo-scrolling")),
      hasSettings: Boolean(panel.querySelector("#maslingo-settings")),
      version: panel.querySelector("#maslingo-version")?.textContent || "",
      hasTerminal: Boolean(panel.querySelector("pre, .maslingo-terminal, .maslingo-log")),
      // The message line lives inside the panel; the bottom-right popup and
      // then the separate status row were both removed, so everything shares
      // this one line.
      hasMessageLine: Boolean(panel.querySelector("#maslingo-line")),
      floatingSurfaces: [...document.documentElement.children]
        .filter((node) => node.id?.startsWith("maslingo-"))
        .map((node) => node.id),
    };
  });

  check("悬浮窗已挂载", Boolean(layout), "找不到 #maslingo-panel");
  // Flush to the corner now: the status popup that used to reserve the last
  // 48px of this corner is gone.
  check("停在右下角（贴住底部）", layout.right < 40 && layout.bottom >= 8 && layout.bottom < 40,
    JSON.stringify({ right: layout.right, bottom: layout.bottom }));
  check("亚克力在材质层上（base 有 backdrop-filter）", /blur/.test(layout.glass || ""), layout.glass);
  check("base 带噪点层（亚克力的标志）",
    /data:image\/svg/.test(layout.noise || ""), String(layout.noise).slice(0, 60));
  check("边缘是 1px 平面描边（不再自带滤镜）",
    layout.edgeBorder === "1px solid" && !/blur/.test(layout.edgeGlass || "none"),
    `${layout.edgeBorder} / ${layout.edgeGlass}`);
  check("材质是 base + edge 两层（平面设计）",
    layout.layers.every(Boolean), JSON.stringify(layout.layers));
  check("旧的 depth/specular 层已移除",
    layout.removedLayers.every((present) => !present), JSON.stringify(layout.removedLayers));
  check("定位为 fixed", layout.position === "fixed");
  check("两个状态点横向排列", layout.dots.length === 2 && layout.dots[0].top === layout.dots[1].top,
    JSON.stringify(layout.dots));
  check("状态点是后端与翻译", layout.dots[0]?.text.includes("后端") && layout.dots[1]?.text.includes("翻译"),
    JSON.stringify(layout.dots.map((d) => d.text)));
  check("有自动识别开关", layout.hasAuto);
  check("有框选翻译按钮", layout.hasSelect);
  check("有翻译类型选择", layout.hasProvider);
  check("有连通检测按钮", layout.hasConnect);
  check("连通检测在选择框右侧", layout.connectAfterSelect);
  check("有一言区域", layout.line.startsWith("「") && layout.line.endsWith("」"), layout.line);
  check("短句不触发横向轮播", layout.lineScrolling === false);
  check("有设置入口", layout.hasSettings);
  check("显示版本号", /^v\d+\.\d+\.\d+$/.test(layout.version), layout.version);
  check("面板内没有终端", !layout.hasTerminal);

  console.log("\n消息行在面板内，页面上没有第二个浮层");
  check("面板自带消息行（一言与状态共用）", layout.hasMessageLine === true);
  // Auto translate is off at this point and nothing has reported a status, so
  // the panel is the only page-level surface. (The one-shot "detected manga"
  // notice in the top-right corner appears only after auto translate starts.)
  check("未开启自动识别时页面上只有面板", layout.floatingSurfaces.length === 1,
    JSON.stringify(layout.floatingSurfaces));

  console.log("\n不阻塞页面操作");
  const passthrough = await page.evaluate(() => {
    // Away from the panel: the overlay must not blanket the page. Directly under
    // the panel it does of course cover things — that is what a floating panel
    // is, and the user can drag it or collapse it.
    const button = document.getElementById("under").getBoundingClientRect();
    const top = document.elementFromPoint(button.left + button.width / 2, button.top + button.height / 2);
    return {
      buttonReachable: top ? top.id === "under" || top.closest("#under") !== null : false,
      topId: top?.id || top?.className || top?.tagName,
    };
  });
  check("面板之外页面照常可点击", passthrough.buttonReachable, String(passthrough.topId));

  console.log("\n拖动");
  const dragged = await page.evaluate(async () => {
    const panel = document.getElementById("maslingo-panel");
    const bar = document.getElementById("maslingo-panel-bar");
    const before = panel.getBoundingClientRect();
    const startX = bar.getBoundingClientRect().left + 40;
    const startY = bar.getBoundingClientRect().top + 8;

    const send = (type, x, y) => window.dispatchEvent(new PointerEvent(type, {
      bubbles: true, clientX: x, clientY: y, button: 0, pointerId: 1,
    }));
    bar.dispatchEvent(new PointerEvent("pointerdown", {
      bubbles: true, clientX: startX, clientY: startY, button: 0, pointerId: 1,
    }));
    send("pointermove", startX - 200, startY - 150);
    send("pointerup", startX - 200, startY - 150);
    await new Promise((r) => requestAnimationFrame(r));
    const after = panel.getBoundingClientRect();
    return { movedX: Math.round(before.left - after.left), movedY: Math.round(before.top - after.top) };
  });
  check("可以拖动", dragged.movedX > 100 && dragged.movedY > 80, JSON.stringify(dragged));

  // Position limits are gone on purpose: the pane follows the pointer even past
  // the window edges. The only correction left is a failsafe for a pane that is
  // entirely off screen (a stored position from a larger monitor), which
  // check-panel-layout exercises separately.
  // Let the settle animation from the drag above finish first: it scales the
  // pane, and getBoundingClientRect during it reports the scaled box a few px
  // off — enough to break the exact-delta assertion below.
  await new Promise((r) => setTimeout(r, 500));
  const free = await page.evaluate(async () => {
    const panel = document.getElementById("maslingo-panel");
    const bar = document.getElementById("maslingo-panel-bar");
    const before = panel.getBoundingClientRect();
    const startX = bar.getBoundingClientRect().left + 10;
    const startY = bar.getBoundingClientRect().top + 8;
    bar.dispatchEvent(new PointerEvent("pointerdown", {
      bubbles: true, clientX: startX, clientY: startY, button: 0, pointerId: 2,
    }));
    const dx = window.innerWidth + 400;
    const dy = window.innerHeight + 300;
    window.dispatchEvent(new PointerEvent("pointermove", {
      bubbles: true, clientX: startX + dx, clientY: startY + dy, button: 0, pointerId: 2,
    }));
    window.dispatchEvent(new PointerEvent("pointerup", {
      bubbles: true, clientX: startX + dx, clientY: startY + dy, pointerId: 2,
    }));
    // The release starts a settle animation (a brief scale), and a scaled pane
    // reports a box ~4px off its committed position. Measure after it ends.
    await new Promise((r) => setTimeout(r, 400));
    const after = panel.getBoundingClientRect();

    // And back from wherever it now is, so the rest of the run has a panel on
    // screen to click.
    const backBox = bar.getBoundingClientRect();
    const backX = backBox.left + 10;
    const backY = backBox.top + 8;
    bar.dispatchEvent(new PointerEvent("pointerdown", {
      bubbles: true, clientX: backX, clientY: backY, button: 0, pointerId: 4,
    }));
    window.dispatchEvent(new PointerEvent("pointermove", {
      bubbles: true, clientX: 380, clientY: 320, button: 0, pointerId: 4,
    }));
    window.dispatchEvent(new PointerEvent("pointerup", {
      bubbles: true, clientX: 380, clientY: 320, pointerId: 4,
    }));
    await new Promise((r) => setTimeout(r, 400));
    const restored = panel.getBoundingClientRect();

    return {
      movedX: Math.round(after.left - before.left),
      movedY: Math.round(after.top - before.top),
      dx,
      dy,
      offscreen: after.left > window.innerWidth || after.top > window.innerHeight,
      backOnScreen: restored.left >= 0 && restored.top >= 0
        && restored.left < window.innerWidth && restored.top < window.innerHeight,
      backX: Math.round(restored.left),
      backY: Math.round(restored.top),
    };
  });
  check("拖动不再被位置限制夹住（可以拖出视口）",
    free.offscreen === true
      && Math.abs(free.movedX - free.dx) <= 2 && Math.abs(free.movedY - free.dy) <= 2,
    JSON.stringify(free));
  check("拖回屏幕后仍可继续操作", free.backOnScreen === true, JSON.stringify(free));

  console.log("\n收起为挂件（真实点击）");
  // A real mouse click, not element.click(). The collapse button sits inside the
  // drag handle, and the drag handler calls preventDefault() on pointerdown —
  // which suppresses the click that follows. element.click() dispatches straight
  // to the listener and sails past that, so the first version of this check
  // passed while the button did nothing for an actual user.
  const collapseBox = await page.evaluate(() => {
    const box = document.getElementById("maslingo-collapse").getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  });
  await page.mouse.click(collapseBox.x, collapseBox.y);
  await new Promise((r) => setTimeout(r, 400));

  const collapsed = await page.evaluate(() => {
    const panel = document.getElementById("maslingo-panel");
    const widget = document.getElementById("maslingo-widget");
    const body = panel.querySelector(".maslingo-panel-body");
    // Collapse is a continuous shape change now, not a swap between two
    // layouts: every band is a grid row that animates to 0fr, so what shrinks is
    // the band's clipping box. The body inside keeps its natural height and is
    // simply clipped away — measuring the body itself reports 323px and looks
    // like a failure when the collapse worked perfectly.
    const clip = panel.querySelector(".maslingo-sec-body .maslingo-sec-in");
    // Scoped to the collapse machinery: a hard switch there would show up as a
    // band with `display: none`. The status line is exempt on purpose — it uses
    // the `hidden` attribute whenever there is no message, which is content
    // visibility and has nothing to do with the collapse.
    let hiddenByDisplay = false;
    for (const node of panel.querySelectorAll(".maslingo-sec, .maslingo-sec-in, .maslingo-glass__content")) {
      if (getComputedStyle(node).display === "none") { hiddenByDisplay = true; break; }
    }
    return {
      bodyHeight: Math.round(clip ? clip.getBoundingClientRect().height : -1),
      panelHeight: Math.round(panel.getBoundingClientRect().height),
      hiddenByDisplay,
      widgetVisible: getComputedStyle(widget).display !== "none",
      text: widget.textContent.trim(),
      width: panel.getBoundingClientRect().width,
    };
  });
  check("点击收起按钮能收起", collapsed.bodyHeight < 2,
    `主体还有 ${collapsed.bodyHeight}px 高`);
  check("收起不使用 display:none 硬切换", collapsed.hiddenByDisplay === false,
    "面板里出现了 display:none 的元素");
  check("收起后显示挂件", collapsed.widgetVisible === true && collapsed.bodyHeight < 2);
  check("挂件只保留核心状态", collapsed.text.includes("自动翻译") && collapsed.width < 200,
    `${collapsed.text} / ${collapsed.width}px`);
  console.log(`      收起后 面板高 ${collapsed.panelHeight}px  宽 ${Math.round(collapsed.width)}px`);

  const widgetBox = await page.evaluate(() => {
    const box = document.getElementById("maslingo-widget").getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  });
  await page.mouse.click(widgetBox.x, widgetBox.y);
  await new Promise((r) => setTimeout(r, 800));
  const expandedAgain = await page.evaluate(() => {
    const clip = document.querySelector("#maslingo-panel .maslingo-sec-body .maslingo-sec-in");
    return Math.round(clip.getBoundingClientRect().height);
  });
  check("点击挂件能再次展开", expandedAgain > 100, `主体只有 ${expandedAgain}px 高`);

  // The drag handle must still drag: the fix for the button cannot cost that.
  const stillDrags = await page.evaluate(async () => {
    const bar = document.getElementById("maslingo-panel-bar");
    const panel = document.getElementById("maslingo-panel");
    const before = panel.getBoundingClientRect().left;
    const box = bar.getBoundingClientRect();
    const x = box.left + 20;
    const y = box.top + box.height / 2;
    bar.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: x, clientY: y, button: 0, pointerId: 3 }));
    window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: x - 120, clientY: y, button: 0, pointerId: 3 }));
    window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: x - 120, clientY: y, pointerId: 3 }));
    await new Promise((r) => requestAnimationFrame(r));
    return Math.round(before - panel.getBoundingClientRect().left);
  });
  check("拖拽仍然可用", stillDrags > 60, `只移动了 ${stillDrags}px`);

  console.log("\n消息行：一言与加载状态共用一行，自动识别会把进度写上去");
  await worker.evaluate(() => chrome.storage.local.set({ autoTranslate: true }));
  // Sampled early and then again later: a loading state must replace the
  // sample sentence while it runs, and the sentence must come back when the
  // message expires — both halves are worth pinning down.
  const sample = async () => page.evaluate(() => {
    const line = document.getElementById("maslingo-line");
    const panel = document.getElementById("maslingo-panel");
    if (!line || !panel) return { missing: true };
    // The line is updated in place, never rebuilt. A marker written on the
    // first sample survives only if the same node is still there.
    if (!line.dataset.probe) line.dataset.probe = String(Date.now());
    const text = document.getElementById("maslingo-line-text");
    const dot = document.getElementById("maslingo-line-dot");
    return {
      missing: false,
      probe: line.dataset.probe,
      text: text?.textContent?.trim() || "",
      kind: line.dataset.kind,
      dotVisible: dot ? dot.hidden === false : false,
      insidePanel: panel.contains(line),
      whiteSpace: text ? getComputedStyle(text).whiteSpace : null,
    };
  });

  let progress = await sample();
  for (let attempt = 0; attempt < 15 && !(progress.kind && progress.text); attempt += 1) {
    await new Promise((r) => setTimeout(r, 200));
    progress = await sample();
  }
  const afterToggle = ocrCalls.length;
  console.log(`      一行：「${progress.text}」  kind=${progress.kind}  点=${progress.dotVisible}`);

  await new Promise((r) => setTimeout(r, 6000));
  const settled = await sample();

  check("消息行已挂载且在面板内", progress.missing === false && progress.insidePanel === true);
  check("加载状态写进一言行（替换样句）并显示状态点",
    progress.kind !== "" && progress.dotVisible === true && progress.text.length > 0,
    JSON.stringify(progress));
  check("状态文字只在一行", progress.whiteSpace === "nowrap" && !progress.text.includes("\n"),
    progress.whiteSpace);
  check("进度结束后样句回来（点隐藏）",
    settled.missing === false && settled.kind === "" && settled.dotVisible === false
      && settled.text.startsWith("「") && settled.text.endsWith("」"),
    JSON.stringify(settled));
  check("消息行是同一个节点，没有重建", settled.probe === progress.probe,
    `${progress.probe} -> ${settled.probe}`);

  console.log("\n面板按钮真的接线了");
  // Clicked for real. The button existed in every earlier run and did nothing:
  // it sent START_SELECT through runtime.sendMessage, which never reaches a
  // content script, and the only assertion was that the element was present.
  await page.evaluate(() => {
    document.body.insertAdjacentHTML("afterbegin", '<div id="probe" style="height:10px"></div>');
  });
  const selectBox = await page.evaluate(() => {
    const box = document.getElementById("maslingo-select").getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  });
  await page.mouse.click(selectBox.x, selectBox.y);
  await new Promise((r) => setTimeout(r, 600));
  const selection = await page.evaluate(() => ({
    overlay: document.querySelectorAll(".maslingo-selection").length,
    status: document.getElementById("maslingo-line-text")?.textContent?.trim() || "",
  }));
  console.log(`      选择层 ${selection.overlay} 个，状态「${selection.status}」`);
  check("点击框选翻译会进入选择模式", selection.overlay === 1,
    `状态栏说「${selection.status}」`);
  // Leave selection mode so the rest of the checks run against a clean page.
  await page.keyboard.press("Escape");
  await new Promise((r) => setTimeout(r, 300));
  const escaped = await page.evaluate(() =>
    document.querySelectorAll(".maslingo-selection").length);
  check("Escape 能退出选择模式", escaped === 0, `还剩 ${escaped} 个`);

  console.log("\n状态点反映真实连通性");
  // The backend is reachable only through the service worker: a content script
  // is bound by the page's origin and cannot reach another host, so this also
  // guards against the check silently failing for everyone.
  await new Promise((r) => setTimeout(r, 2000));
  const dots = await page.evaluate(() => {
    const read = (id) => {
      const node = document.getElementById(id);
      return { state: node.dataset.state, text: node.querySelector(".maslingo-dot-text").textContent.trim() };
    };
    return { backend: read("maslingo-dot-backend"), translation: read("maslingo-dot-translation") };
  });
  console.log(`      后端：${dots.backend.text}（${dots.backend.state}）  翻译：${dots.translation.text}（${dots.translation.state}）`);
  check("后端检测为正常", dots.backend.state === "ok", JSON.stringify(dots.backend));
  check("未选翻译来源时报告失败", dots.translation.state === "bad", JSON.stringify(dots.translation));

  console.log("\n连通检测失败：合并成一行，不再多出一行重复提示");
  // Point the provider at a port nothing listens on, so the failure is
  // deterministic instead of depending on the network.
  await worker.evaluate(() => chrome.storage.local.set({
    translationProvider: "custom",
    translationMode: "openai-compatible",
    translationEndpoint: "http://127.0.0.1:9/v1/chat/completions",
    translationModel: "dead-endpoint",
    translationApiKey: "",
  }));
  // "custom" is an AI source, so the panel's provider-row button is now 配置:
  // one click opens the AI page, and the check itself runs from the button
  // beside the key (which probes the draft).
  await page.evaluate(() => document.getElementById("maslingo-connect").click());
  await new Promise((r) => setTimeout(r, 600));
  await page.evaluate(() => document.getElementById("maslingo-connect-ai").click());
  await new Promise((r) => setTimeout(r, 3000));
  const merged = await page.evaluate(() => {
    const line = document.getElementById("maslingo-line");
    const text = document.getElementById("maslingo-line-text");
    const dot = document.getElementById("maslingo-line-dot");
    return {
      text: text.textContent.trim(),
      kind: line.dataset.kind,
      dotHidden: dot.hidden,
      dotColor: getComputedStyle(dot).backgroundColor,
      scrolling: line.classList.contains("maslingo-scrolling"),
      distance: text.style.getPropertyValue("--maslingo-marquee-distance"),
      animation: getComputedStyle(text).animationName,
      // The clipping window must not move; only the text layer inside it does.
      windowTransform: getComputedStyle(line.querySelector(".maslingo-line-clip")).transform,
    };
  });
  console.log(`      一行：「${merged.text}」 kind=${merged.kind}  点=${merged.dotHidden ? "隐藏" : merged.dotColor}`
    + `  轮播=${merged.scrolling}(${merged.distance || "0px"}, ${merged.animation})`);
  check("失败原因写进上一行、并带错误色",
    merged.text.startsWith("翻译连接失败：") && merged.kind === "error", merged.text);
  check("错误显示红色状态点",
    merged.dotHidden === false && merged.dotColor === "rgb(211, 58, 63)",
    JSON.stringify({ hidden: merged.dotHidden, color: merged.dotColor }));
  check("放不下的文字横向轮播",
    merged.scrolling === true
      && parseFloat(merged.distance) > 0
      && merged.animation === "maslingo-marquee"
      // The window stays put and the glyphs translate inside it.
      && merged.windowTransform === "none",
    JSON.stringify({
      scrolling: merged.scrolling,
      distance: merged.distance,
      animation: merged.animation,
      windowTransform: merged.windowTransform,
    }));

  // Persistence: the failure must still be there well past the old 9-second
  // dwell. An expired message left the panel looking idle while translation
  // kept failing — reported as "stuck".
  await new Promise((r) => setTimeout(r, 8000));
  const persisted = await page.evaluate(() => {
    const line = document.getElementById("maslingo-line");
    return {
      text: document.getElementById("maslingo-line-text").textContent.trim(),
      kind: line.dataset.kind,
    };
  });
  check("错误不会自动消失（超过旧 9 秒时限仍在）",
    persisted.text.startsWith("翻译连接失败：") && persisted.kind === "error",
    persisted.text.slice(0, 60));

  // Resolution: a successful check clears it and shows the translation again.
  await worker.evaluate((url) => chrome.storage.local.set({
    translationEndpoint: `${url}/v1/chat/completions`,
  }), backendUrl);
  await page.evaluate(() => document.getElementById("maslingo-connect-ai").click());
  await new Promise((r) => setTimeout(r, 1500));
  const resolved = await page.evaluate(() =>
    document.getElementById("maslingo-line-text").textContent.trim());
  check("解决后错误消失（成功译样回到该行）", resolved === "早上好", resolved);

  console.log("\n失败提示不会被上一次成功的样句定时器挤掉");
  // A success arms a 4s timer that restores the 「…」 sample sentence. A check
  // that fails inside that window must cancel it — without that, the fresh
  // error was overwritten by a one-liner seconds later.
  await worker.evaluate((url) => chrome.storage.local.set({
    translationProvider: "custom",
    translationMode: "openai-compatible",
    translationEndpoint: `${url}/v1/chat/completions`,
    translationModel: "stub",
  }), backendUrl);
  await page.evaluate(() => document.getElementById("maslingo-connect-ai").click());
  await new Promise((r) => setTimeout(r, 1200));
  const succeeded = await page.evaluate(() =>
    document.getElementById("maslingo-line-text").textContent.trim());
  check("先成功一次（译样已打上，定时器已武装）", succeeded === "早上好", succeeded);

  await worker.evaluate(() => chrome.storage.local.set({
    translationEndpoint: "http://127.0.0.1:9/v1/chat/completions",
  }));
  await page.evaluate(() => document.getElementById("maslingo-connect-ai").click());
  await new Promise((r) => setTimeout(r, 5500));
  const survivor = await page.evaluate(() =>
    document.getElementById("maslingo-line-text").textContent.trim());
  console.log(`      5.5 秒后一行仍为：「${survivor.slice(0, 40)}…」`);
  check("错误提示不会被样句定时器覆盖",
    survivor.startsWith("翻译连接失败："), survivor);
  // Back to the main page so the sections below run in the layout they were
  // written against.
  await page.evaluate(() => document.getElementById("maslingo-ai-cancel").click());
  await new Promise((r) => setTimeout(r, 700));

  console.log("\n状态行走马灯：文字在固定的裁剪窗口内平移，不与状态点重叠");
  // The natural trigger — the long mount-time backend error — depends on no
  // backend answering at 127.0.0.1:8001 (true in CI, not on a machine running
  // one), so the contract is asserted directly on the same elements: the class
  // panel.js adds, the keyframes it starts, the geometry that keeps the glyphs
  // inside the clip window, and that the text layer actually moves.
  // A fresh real message puts the line into its message state (dot visible)
  // so the simulation below has a laid-out line to measure.
  await page.evaluate(() => document.getElementById("maslingo-auto").click());
  await new Promise((r) => setTimeout(r, 150));
  const marquee = await page.evaluate(async () => {
    const line = document.getElementById("maslingo-line");
    const clip = line.querySelector(".maslingo-line-clip");
    const text = document.getElementById("maslingo-line-text");
    const dot = document.getElementById("maslingo-line-dot");
    text.style.setProperty("--maslingo-marquee-distance", "300px");
    text.style.setProperty("--maslingo-marquee-duration", "4s");
    line.classList.add("maslingo-scrolling");
    const txOf = () => {
      const transform = getComputedStyle(text).transform;
      if (!transform || transform === "none") return 0;
      const match = transform.match(/matrix\(([^)]+)\)/);
      return match ? Number(match[1].split(",")[4]) : 0;
    };
    const before = txOf();
    await new Promise((r) => setTimeout(r, 1200));
    const after = txOf();
    const result = {
      animation: getComputedStyle(text).animationName,
      windowTransform: getComputedStyle(clip).transform,
      dotHidden: dot.hidden,
      before,
      after,
      windowLeft: Math.round(clip.getBoundingClientRect().left),
      dotRight: Math.round(dot.getBoundingClientRect().right),
    };
    line.classList.remove("maslingo-scrolling");
    text.style.removeProperty("--maslingo-marquee-distance");
    text.style.removeProperty("--maslingo-marquee-duration");
    return result;
  });
  console.log(`      ${JSON.stringify(marquee)}`);
  check("消息行走马灯用合成器 transform（裁剪窗口不动）",
    marquee.animation === "maslingo-marquee" && marquee.windowTransform === "none",
    JSON.stringify(marquee));
  check("滚动中文字确实在动（位移变化）",
    marquee.before !== marquee.after, `${marquee.before} -> ${marquee.after}`);
  check("裁剪窗口左缘在状态点右侧（移动的字不会压到点）",
    marquee.dotHidden === false && marquee.windowLeft >= marquee.dotRight - 1,
    JSON.stringify(marquee));

  console.log("\n页面无脚本错误");
  check("页面无脚本错误", errors.length === 0, errors.slice(0, 2).join(" | "));
  if (afterToggle === 0) console.log("      （本页没有可识别的图片，OCR 未触发，属正常）");

  // A picture of it, so the glass and the layout can be looked at rather than
  // inferred from computed styles.
  try {
    const shotDir = resolve(repoRoot, "deploy", "screenshots");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(shotDir, { recursive: true });
    await page.screenshot({ path: join(shotDir, "panel.png") });
    console.log(`      截图：deploy/screenshots/panel.png`);
  } catch (error) {
    console.log(`      截图失败：${error.message}`);
  }
} finally {
  await browser.close();
  backend.close();
  pages.close();
  rmSync(workDir, { recursive: true, force: true });
}

if (failures.length) {
  console.log(`\n${failures.length} 项失败`);
  process.exit(1);
}
console.log("\n悬浮窗行为符合预期");
