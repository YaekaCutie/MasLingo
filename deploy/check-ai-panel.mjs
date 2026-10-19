// The panel's two pages, and the connectivity probe's text forwarding.
//
// Two regressions this file exists for:
//
//   1. 必应's connectivity check showed 未定义. The probe sent the text only as
//      `texts`, the one-text-per-request adapters read `request.text`, and
//      URLSearchParams stringified the missing field — Bing was asked to
//      translate the literal word "undefined" and the panel displayed Bing's
//      translation of it as a success. The fake provider below fails the check
//      if the worker stops forwarding the text (or the current strength).
//
//   2. The panel is two pages in one fixed-size window. Choosing an "AI 大模型"
//      source navigates to the AI page — 反应强度 on top, a divider, API Key
//      below — with 取消 / 保存 in the footer; the page is a draft (nothing is
//      written until 保存), and either button returns to the main page. The
//      message line carries a small grey 来源 note and the strength slider
//      emits meteors while the page is open.
//
//   node deploy/check-ai-panel.mjs

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

// The fake provider's endpoint: whatever arrives here is what actually left
// the service worker, which is exactly the thing the 未定义 bug corrupted.
const received = [];
const echo = http.createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => { body += chunk; });
  request.on("end", () => {
    received.push(body);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ echo: JSON.parse(body || "{}") }));
  });
});
await new Promise((done) => echo.listen(0, "127.0.0.1", done));
const echoUrl = `http://127.0.0.1:${echo.address().port}/v1/chat/completions`;

const pages = http.createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end("<!doctype html><html lang=\"ja\"><head><meta charset=\"utf-8\">"
    + "<title>ai panel</title></head><body style=\"margin:0;background:#2a2a2a\">"
    + "<p style=\"font:14px system-ui\">manga</p></body></html>");
});
await new Promise((done) => pages.listen(0, "127.0.0.1", done));
const pageUrl = `http://127.0.0.1:${pages.address().port}/`;

const workDir = mkdtempSync(join(tmpdir(), "maslingo-ai-"));
const extensionDir = join(workDir, "extension");
cpSync(join(repoRoot, "extension"), extensionDir, { recursive: true });
// The worker must be able to reach the recorder on its ephemeral port; the
// shipped manifest only whitelists 8001 (and the recorder is not a real
// provider, so it does not belong in the manifest).
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
  const extensionId = new URL(worker.url()).host;

  // A fake provider whose adapter reports exactly the fields the worker built.
  // Registered in the worker, not stubbed around it: the point is the real
  // TEST_PROVIDER handler.
  await worker.evaluate((url) => {
    globalThis.MAS_providers.list.push({
      id: "echo-test",
      label: "Echo Test",
      group: "AI 大模型",
      adapter: (request) => ({
        url,
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: request.text ?? null,
            strength: request.strength ?? null,
          }),
        },
      }),
      parse: (json) => [json?.echo?.text === null ? "NULL" : String(json?.echo?.text)],
    });
  }, echoUrl);

  console.log("连通检测把原文交给适配器（必应「未定义」回归）");
  const popup = await browser.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`, { waitUntil: "load" });
  const probe = await popup.evaluate(() => chrome.runtime.sendMessage({
    type: "TEST_PROVIDER",
    text: "おはよう",
    cfg: {
      translationProvider: "echo-test",
      translationStrength: 2,
    },
  }));
  const sent = received.length ? JSON.parse(received[0]) : {};
  check("探测请求真的发出了", received.length === 1, String(received.length));
  check("适配器收到的是面板上的原句", sent.text === "おはよう", JSON.stringify(sent));
  check("面板结果不是 undefined/未定义 一类", probe?.translated === "おはよう", JSON.stringify(probe));
  check("探测带上当前强度", sent.strength === 2, JSON.stringify(sent));
  await popup.close();

  console.log("\n主页面 → AI 配置页");
  await worker.evaluate(() => chrome.storage.local.set({
    translationMode: "none", translationProvider: "none", autoTranslate: false,
  }));
  await worker.evaluate(() => chrome.storage.local.remove([
    "translationStrength", "translationApiKey", "translationModel",
    "translationModelProvider", "panelPosition",
  ]));

  const page = await browser.newPage();
  await page.setViewport({ width: 1000, height: 900 });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error?.stack || String(error)));
  await page.goto(pageUrl, { waitUntil: "load" });
  await new Promise((r) => setTimeout(r, 2500));

  const readStorage = (keys) => worker.evaluate((wanted) =>
    chrome.storage.local.get(wanted), keys);

  const sample = () => page.evaluate(() => {
    const panel = document.getElementById("maslingo-panel");
    if (!panel) return null;
    const box = (node) => (node ? node.getBoundingClientRect() : null);
    const basic = panel.querySelector(".maslingo-basic");
    const providerFold = panel.querySelector(".maslingo-provider");
    const keyFold = panel.querySelector(".maslingo-key");
    const strengthFold = panel.querySelector(".maslingo-strength-fold");
    const body = panel.querySelector(".maslingo-panel-body");
    const strength = document.getElementById("maslingo-strength");
    const ruleAi = document.getElementById("maslingo-rule-ai");
    const track = panel.querySelector(".maslingo-strength-track");
    const fill = panel.querySelector(".maslingo-strength-fill");
    const thumb = panel.querySelector(".maslingo-strength-thumb");
    const trackBox = box(track);
    const thumbBox = box(thumb);
    const fillBox = box(fill);
    const strengthBox = box(strength);
    const keyBox = box(keyFold);
    const ruleAiBox = box(ruleAi);
    const line = document.getElementById("maslingo-line");
    const source = document.getElementById("maslingo-source");
    const footRule = document.getElementById("maslingo-rule-foot");
    const cancel = document.getElementById("maslingo-ai-cancel");
    const save = document.getElementById("maslingo-ai-save");
    const settings = document.getElementById("maslingo-settings");
    const visible = (node) => {
      if (!node) return false;
      const style = getComputedStyle(node);
      return style.display !== "none" && style.visibility !== "hidden";
    };
    return {
      aiPage: panel.classList.contains("maslingo-panel-ai"),
      panelHeight: Math.round(panel.getBoundingClientRect().height * 10) / 10,
      panelTop: Math.round(panel.getBoundingClientRect().top),
      basicHeight: Math.round(basic.getBoundingClientRect().height * 10) / 10,
      providerHeight: Math.round(providerFold.getBoundingClientRect().height * 10) / 10,
      keyHeight: Math.round(keyFold.getBoundingClientRect().height * 10) / 10,
      keyVisibility: getComputedStyle(keyFold).visibility,
      strengthHeight: Math.round(strengthFold.getBoundingClientRect().height * 10) / 10,
      strengthVisibility: getComputedStyle(strengthFold).visibility,
      bodyClipped: body ? body.scrollHeight > body.clientHeight + 1 : false,
      // 底部留白：最后一段可见内容到页脚分割线之间。
      airBelow: (() => {
        // 一言行在两种页面里都是最后一段内容（AI 页：强度、密钥、一言）。
        if (!line || !footRule) return -1;
        return Math.round(footRule.getBoundingClientRect().top
          - line.getBoundingClientRect().bottom);
      })(),
      lineTop: Math.round(line.getBoundingClientRect().top),
      sourceText: source ? source.textContent.trim() : "",
      sourceRightGap: source ? Math.round(line.getBoundingClientRect().right
        - source.getBoundingClientRect().right) : -1,
      sourceDropped: source
        ? Math.round(source.getBoundingClientRect().top
          - document.getElementById("maslingo-line-text").getBoundingClientRect().top)
        : -1,
      strengthTop: strengthBox ? Math.round(strengthBox.top) : -1,
      keyTop: keyBox ? Math.round(keyBox.top) : -1,
      ruleAiVisible: ruleAi ? Number(getComputedStyle(ruleAi).opacity) : -1,
      ruleAiBetween: strengthBox && keyBox && ruleAiBox
        ? ruleAiBox.top >= strengthBox.bottom - 1 && ruleAiBox.bottom <= keyBox.top + 1
        : false,
      cancelVisible: visible(cancel),
      saveVisible: visible(save),
      settingsVisible: visible(settings),
      saveBackground: save ? getComputedStyle(save).backgroundColor : "",
      cancelBackground: cancel ? getComputedStyle(cancel).backgroundColor : "",
      configureLabel: document.getElementById("maslingo-connect").textContent.trim(),
      level: document.getElementById("maslingo-strength-name").textContent.trim(),
      strengthHint: document.getElementById("maslingo-strength-hint")?.textContent.trim() || "",
      model: document.getElementById("maslingo-strength-model").dataset.model,
      modelLabel: document.getElementById("maslingo-strength-model-name").textContent.trim(),
      modelBoxOpen: document.getElementById("maslingo-modelbox").hidden === false,
      advGone: !panel.querySelector(".maslingo-adv")
        && !document.getElementById("maslingo-search")
        && !document.getElementById("maslingo-context"),
      ariaNow: document.getElementById("maslingo-strength-slider").getAttribute("aria-valuenow"),
      thumbHeight: thumbBox ? Math.round(thumbBox.height * 10) / 10 : -1,
      trackHeight: trackBox ? Math.round(trackBox.height * 10) / 10 : -1,
      thumbLeftGap: trackBox ? Math.round((thumbBox.left - trackBox.left) * 10) / 10 : -1,
      thumbRightGap: trackBox ? Math.round((trackBox.right - thumbBox.right) * 10) / 10 : -1,
      fillRightGap: trackBox && fillBox
        ? Math.round((thumbBox.right - fillBox.right) * 10) / 10 : -1,
      keyPlaceholder: document.getElementById("maslingo-ai-key").placeholder,
      keyValue: document.getElementById("maslingo-ai-key").value,
      lineText: document.getElementById("maslingo-line-text").textContent.trim(),
      glossary: document.getElementById("maslingo-glossary")?.value || "",
      glossaryOptions: [...(document.getElementById("maslingo-glossary")?.options || [])]
        .map((option) => option.value),
    };
  });

  const before = await sample();
  check("面板已挂载", Boolean(before));
  check("主页面：框选区与翻译类型在位",
    before.aiPage === false && before.basicHeight > 40 && before.providerHeight > 40,
    JSON.stringify({ basic: before.basicHeight, provider: before.providerHeight }));
  check("主页面：强度与密钥模块收起且移出可达性树",
    before.strengthHeight < 2 && before.strengthVisibility === "hidden"
      && before.keyHeight < 2 && before.keyVisibility === "hidden",
    JSON.stringify({ strength: before.strengthHeight, key: before.keyHeight }));
  check("主页面：页脚是设置/版本，不是保存/取消",
    before.settingsVisible === true && before.cancelVisible === false && before.saveVisible === false,
    JSON.stringify({ settings: before.settingsVisible, cancel: before.cancelVisible }));
  check("行为开关已移除（AI 页上不再有搜索/上下文控件）", before.advGone === true);
  check("一言行右侧有灰色来源小字",
    before.sourceText === "来源 · 不翻译" && before.sourceRightGap <= 2 && before.sourceDropped >= 2,
    JSON.stringify({ text: before.sourceText, right: before.sourceRightGap, drop: before.sourceDropped }));
  check("主页面内容没有被固定高度裁掉", before.bodyClipped === false);
  console.log(`      主页面：底部留白 ${before.airBelow}px`);

  // Pick an AI source the way a user does, then sample while it animates: a
  // snap would leave no sample strictly between the two states.
  await page.evaluate(() => {
    const select = document.getElementById("maslingo-provider");
    select.value = "deepseek";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const samples = [];
  for (let i = 0; i < 14; i += 1) {
    samples.push((await sample()).basicHeight);
    await new Promise((r) => setTimeout(r, 40));
  }
  await new Promise((r) => setTimeout(r, 700));
  const ai = await sample();

  const midway = samples.filter((h) => h > before.basicHeight * 0.1 && h < before.basicHeight * 0.9);
  check("框选区是动画收起（中途出现连续高度）", midway.length >= 1, JSON.stringify(samples));
  check("AI 配置页已打开", ai.aiPage === true);
  check("主页面控件收起（框选区与翻译类型都归零）",
    ai.basicHeight < 2 && ai.providerHeight < 2,
    JSON.stringify({ basic: ai.basicHeight, provider: ai.providerHeight }));
  check("反应强度在上、API Key 在下",
    ai.strengthHeight > 60 && ai.keyHeight > 40 && ai.strengthTop < ai.keyTop,
    JSON.stringify({ strength: ai.strengthHeight, key: ai.keyHeight, sTop: ai.strengthTop, kTop: ai.keyTop }));
  check("两者之间有分割线（可见且夹在中间）",
    ai.ruleAiVisible >= 0.9 && ai.ruleAiBetween === true,
    JSON.stringify({ opacity: ai.ruleAiVisible, between: ai.ruleAiBetween }));
  check("页脚换成保存/取消（设置让位）",
    ai.cancelVisible === true && ai.saveVisible === true && ai.settingsVisible === false,
    JSON.stringify({ cancel: ai.cancelVisible, save: ai.saveVisible, settings: ai.settingsVisible }));
  check("保存有重点色（墨色实心），取消没有",
    /^rgba?\(28, 30, 33/.test(ai.saveBackground)
      && (ai.cancelBackground === "rgba(0, 0, 0, 0)" || ai.cancelBackground === "transparent"),
    JSON.stringify({ save: ai.saveBackground, cancel: ai.cancelBackground }));
  check("窗口尺寸两个页面完全一致",
    Math.abs(ai.panelHeight - before.panelHeight) <= 1 && Math.abs(ai.panelTop - before.panelTop) <= 1,
    JSON.stringify({ before: before.panelHeight, after: ai.panelHeight }));
  check("AI 页内容没有被固定高度裁掉", ai.bodyClipped === false);
  console.log(`      AI 页：底部留白 ${ai.airBelow}px`);
  check("两个页面都没有大块空洞（底部留白 ≤ 24px）",
    before.airBelow <= 24 && ai.airBelow <= 24,
    JSON.stringify({ normal: before.airBelow, ai: ai.airBelow }));
  check("来源小字跟着来源变化", ai.sourceText === "来源 · DeepSeek", ai.sourceText);
  check("草稿默认值来自存储（Low / deepseek-flash）",
    ai.level === "Low" && ai.ariaNow === "0" && ai.model === "deepseek-flash",
    JSON.stringify({ level: ai.level, model: ai.model }));
  check("模型行显示的是具体型号名", ai.modelLabel === "DeepSeek V4.1 Flash", ai.modelLabel);
  check("档位名字旁边标出该档含义",
    ai.strengthHint === "不联网轻度润色", ai.strengthHint);
  check("AI 页有术语库选择器且包含医学/法律",
    ai.glossary === "general"
      && ai.glossaryOptions.includes("medical")
      && ai.glossaryOptions.includes("legal"),
    JSON.stringify({ value: ai.glossary, options: ai.glossaryOptions }));

  console.log("\n具体型号选择框");
  await page.click("#maslingo-strength-model");
  await new Promise((r) => setTimeout(r, 250));
  const boxOpen = await sample();
  check("点击模型行弹出选择框", boxOpen.modelBoxOpen === true);
  check("选择框不改变窗口尺寸",
    Math.abs(boxOpen.panelHeight - before.panelHeight) <= 1,
    JSON.stringify({ open: boxOpen.panelHeight, closed: before.panelHeight }));
  const boxItems = await page.$$eval("#maslingo-modelbox .maslingo-modelbox-item", (nodes) =>
    nodes.map((node) => ({
      id: node.dataset.model,
      text: node.textContent.trim(),
    })));
  check("选择框列出 DeepSeek 的具体型号（名字 + id）",
    boxItems.some((item) => item.id === "deepseek-flash" && item.text.includes("DeepSeek V4.1 Flash"))
      && boxItems.some((item) => item.id === "deepseek-v4-pro" && item.text.includes("deepseek-v4-pro")),
    JSON.stringify(boxItems));
  const boxShot = await page.evaluate(() => {
    const rect = document.getElementById("maslingo-panel").getBoundingClientRect();
    return {
      x: Math.round(rect.left) - 8,
      y: Math.round(rect.top) - 8,
      width: Math.round(rect.width) + 16,
      height: Math.round(rect.height) + 16,
    };
  });
  await page.screenshot({
    path: join(repoRoot, "deploy", "screenshots", "ai-panel-modelbox.png"),
    clip: boxShot,
  });
  console.log("      截图：deploy/screenshots/ai-panel-modelbox.png");
  // Click-away closes without changing anything.
  await page.click(".maslingo-dots");
  await new Promise((r) => setTimeout(r, 200));
  check("点别处收起选择框", (await sample()).modelBoxOpen === false);

  await page.click("#maslingo-strength-model");
  await new Promise((r) => setTimeout(r, 200));
  await page.click('#maslingo-modelbox .maslingo-modelbox-item[data-model="deepseek-v4-pro"]');
  await new Promise((r) => setTimeout(r, 250));
  const pickedModel = await sample();
  check("选中后收起并更新模型行",
    pickedModel.modelBoxOpen === false && pickedModel.model === "deepseek-v4-pro"
      && pickedModel.modelLabel === "DeepSeek V4 Pro",
    JSON.stringify({ open: pickedModel.modelBoxOpen, model: pickedModel.model, label: pickedModel.modelLabel }));

  console.log("\n行为选项（联网搜索 / 上下文联系）");
  // 搜索 / 上下文的 UI 开关已删除（搜索的要求写在 High/Max 的 prompt 行里）。
  check("行为开关在 AI 页上也已移除", pickedModel.advGone === true);

  console.log("\n草稿：改动只有点保存才落盘");
  const sliderBox = await page.evaluate(() => {
    const box = document.getElementById("maslingo-strength-slider").getBoundingClientRect();
    return { right: box.right, top: box.top, height: box.height };
  });
  await page.mouse.click(sliderBox.right - 6, sliderBox.top + sliderBox.height / 2);
  await new Promise((r) => setTimeout(r, 400));
  const maxDraft = await sample();
  check("点最右端到 Max（草稿）", maxDraft.level === "Max" && maxDraft.ariaNow === "2",
    JSON.stringify({ level: maxDraft.level, aria: maxDraft.ariaNow }));
  check("滑块头与条内切（直径 = 条高）",
    Math.abs(maxDraft.thumbHeight - maxDraft.trackHeight) <= 0.6,
    JSON.stringify({ thumb: maxDraft.thumbHeight, track: maxDraft.trackHeight }));
  check("Max 时滑块头抵住条右端、不越界",
    Math.abs(maxDraft.thumbRightGap) <= 1 && maxDraft.thumbLeftGap > 0,
    JSON.stringify({ left: maxDraft.thumbLeftGap, right: maxDraft.thumbRightGap }));

  await page.click("#maslingo-ai-key");
  await page.keyboard.type("sk-draft-key");
  await page.keyboard.press("Tab");
  await new Promise((r) => setTimeout(r, 250));
  const drafted = await readStorage([
    "translationStrength", "translationModel", "translationApiKey",
  ]);
  check("草稿期间不写存储（强度/型号/密钥都未落盘）",
    drafted.translationStrength === undefined
      && drafted.translationModel === undefined
      && drafted.translationApiKey === undefined,
    JSON.stringify(drafted));
  const draftedState = await sample();
  check("密钥留在输入框里等待保存（未回显为已保存）",
    draftedState.keyValue === "sk-draft-key", draftedState.keyValue);

  console.log("\n流星：从滑块头向左、到上一档淡出（Low 无）");
  const countMeteors = (ms) => page.evaluate((window_ms) => new Promise((resolve) => {
    const fill = document.querySelector(".maslingo-strength-fill");
    const report = { count: 0, movedLeft: false, faded: false, lanes: new Set() };
    let first = null;
    let startLeft = null;
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.classList && node.classList.contains("maslingo-meteor")) {
            report.count += 1;
            report.lanes.add(Math.round(Number.parseFloat(node.style.top) / 10));
            if (!first) {
              first = node;
              startLeft = node.getBoundingClientRect().left;
            }
          }
        }
      }
    });
    observer.observe(fill, { childList: true });
    const sampler = setInterval(() => {
      if (!first || !first.isConnected) return;
      const box = first.getBoundingClientRect();
      if (box.left < startLeft - 6) report.movedLeft = true;
      if (report.movedLeft && Number(getComputedStyle(first).opacity) < 0.75) report.faded = true;
    }, 50);
    setTimeout(() => {
      clearInterval(sampler);
      observer.disconnect();
      resolve({ count: report.count, movedLeft: report.movedLeft, faded: report.faded, lanes: report.lanes.size });
    }, window_ms);
  }), ms);

  await page.focus("#maslingo-strength-slider");
  await page.keyboard.press("Home");
  await new Promise((r) => setTimeout(r, 300));
  const lowEnd = await sample();
  check("Home 回到 Low，滑块头抵住左端、不越界",
    lowEnd.level === "Low" && lowEnd.ariaNow === "0"
      && Math.abs(lowEnd.thumbLeftGap) <= 1,
    JSON.stringify({ level: lowEnd.level, left: lowEnd.thumbLeftGap }));
  check("Low 时填充不超出滑块头（最左不漏黑边）",
    lowEnd.fillRightGap >= -0.6 && lowEnd.fillRightGap <= 2,
    JSON.stringify({ fillRightGap: lowEnd.fillRightGap }));
  const lowMeteors = await countMeteors(1200);
  check("Low 档没有流星（最左没有上一档）", lowMeteors.count === 0, JSON.stringify(lowMeteors));

  await page.keyboard.press("ArrowRight");
  await new Promise((r) => setTimeout(r, 250));
  const highState = await sample();
  check("方向键可以调档（键盘可达）", highState.level === "High" && highState.ariaNow === "1",
    JSON.stringify({ level: highState.level, aria: highState.ariaNow }));
  const highMeteors = await countMeteors(1700);
  check("High 档流星稀疏（1–4 颗）", highMeteors.count >= 1 && highMeteors.count <= 4,
    JSON.stringify(highMeteors));

  await page.keyboard.press("End");
  await new Promise((r) => setTimeout(r, 300));
  const maxMeteors = await countMeteors(1700);
  check("Max 档流星更密（≥ 4 颗）", maxMeteors.count >= 4, JSON.stringify(maxMeteors));
  check("流星向左移动并在到达后淡出",
    maxMeteors.movedLeft === true && maxMeteors.faded === true, JSON.stringify(maxMeteors));
  check("流星分布在多个高度（上下更密，不单调）", maxMeteors.lanes >= 2,
    JSON.stringify({ lanes: maxMeteors.lanes }));

  console.log("\n取消：返回上一页且什么都不写");
  await page.select("#maslingo-glossary", "medical");
  await new Promise((r) => setTimeout(r, 120));
  await page.click("#maslingo-ai-cancel");
  await new Promise((r) => setTimeout(r, 700));
  const cancelled = await sample();
  const afterCancel = await readStorage([
    "translationStrength", "translationModel", "translationApiKey", "translationGlossary",
  ]);
  check("取消后回到主页面",
    cancelled.aiPage === false && cancelled.basicHeight > 40 && cancelled.providerHeight > 40,
    JSON.stringify({ aiPage: cancelled.aiPage, basic: cancelled.basicHeight }));
  check("取消后页脚恢复设置/版本",
    cancelled.settingsVisible === true && cancelled.cancelVisible === false && cancelled.saveVisible === false);
  check("取消不写存储", afterCancel.translationStrength === undefined
    && afterCancel.translationModel === undefined && afterCancel.translationApiKey === undefined
    && afterCancel.translationGlossary === undefined
    && afterCancel.translationSearch === undefined
    && afterCancel.translationContext === undefined,
    JSON.stringify(afterCancel));
  check("取消给出反馈（一言行）", cancelled.lineText.includes("已取消"), cancelled.lineText);
  check("回到主页面后 AI 页的按钮变成「配置」", cancelled.configureLabel === "配置",
    cancelled.configureLabel);
  const idleMeteors = await countMeteors(1200);
  check("主页面不跑流星", idleMeteors.count === 0, JSON.stringify(idleMeteors));

  console.log("\n配置按钮重新进入；保存才落盘");
  await page.click("#maslingo-connect");
  await new Promise((r) => setTimeout(r, 700));
  const reopened = await sample();
  check("点「配置」回到 AI 页", reopened.aiPage === true);
  check("草稿重置为存储值（Low / deepseek-flash / 输入框空）",
    reopened.level === "Low" && reopened.model === "deepseek-flash"
      && reopened.keyValue === "",
    JSON.stringify({ level: reopened.level, model: reopened.model, key: reopened.keyValue }));
  await page.mouse.click(sliderBox.right - 6, sliderBox.top + sliderBox.height / 2);
  await new Promise((r) => setTimeout(r, 300));
  await page.click("#maslingo-strength-model");
  await new Promise((r) => setTimeout(r, 200));
  await page.click('#maslingo-modelbox .maslingo-modelbox-item[data-model="deepseek-v4-pro"]');
  await new Promise((r) => setTimeout(r, 200));
  await page.click("#maslingo-ai-key");
  await page.keyboard.type("sk-saved-key");
  await page.keyboard.press("Tab");
  await new Promise((r) => setTimeout(r, 250));
  await page.select("#maslingo-glossary", "legal");
  await new Promise((r) => setTimeout(r, 120));
  await page.click("#maslingo-ai-save");
  await new Promise((r) => setTimeout(r, 700));
  const saved = await sample();
  const stored = await readStorage([
    "translationStrength", "translationModel", "translationModelProvider",
    "translationApiKey", "translationGlossary",
  ]);
  check("保存后回到主页面", saved.aiPage === false && saved.basicHeight > 40);
  check("保存写入强度/型号/归属/密钥",
    stored.translationStrength === 2
      && stored.translationModel === "deepseek-v4-pro"
      && stored.translationModelProvider === "deepseek"
      && stored.translationApiKey === "sk-saved-key"
      && stored.translationGlossary === "legal",
    JSON.stringify(stored));
  check("保存给出反馈（一言行）", saved.lineText.includes("已保存"), saved.lineText);

  await page.click("#maslingo-connect");
  await new Promise((r) => setTimeout(r, 700));
  const restored = await sample();
  check("再进 AI 页显示已保存的值",
    restored.level === "Max" && restored.model === "deepseek-v4-pro"
      && restored.modelLabel === "DeepSeek V4 Pro"
      && restored.keyValue === "" && restored.keyPlaceholder.includes("已保存")
      && restored.glossary === "legal",
    JSON.stringify({ level: restored.level, model: restored.model, key: restored.keyPlaceholder }));

  // A visual record of the state, next to the other material screenshots.
  const shot = async (name) => {
    const box = await page.evaluate(() => {
      const rect = document.getElementById("maslingo-panel").getBoundingClientRect();
      return {
        x: Math.round(rect.left) - 8,
        y: Math.round(rect.top) - 8,
        width: Math.round(rect.width) + 16,
        height: Math.round(rect.height) + 16,
      };
    });
    await page.screenshot({ path: join(repoRoot, "deploy", "screenshots", name), clip: box });
    console.log(`      截图：deploy/screenshots/${name}`);
  };
  await shot("ai-panel.png");
  await page.click("#maslingo-ai-cancel");
  await new Promise((r) => setTimeout(r, 700));
  await shot("ai-panel-normal.png");

  console.log("\n免密钥来源（Ollama）与切回普通来源");
  await page.evaluate(() => {
    const select = document.getElementById("maslingo-provider");
    select.value = "ollama";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await new Promise((r) => setTimeout(r, 700));
  const ollama = await sample();
  check("选 Ollama 同样进入 AI 页",
    ollama.aiPage === true && ollama.strengthHeight > 60 && ollama.keyHeight > 40,
    JSON.stringify({ aiPage: ollama.aiPage }));
  check("Ollama 的模型清单是自己的（跨来源覆盖不生效）",
    ollama.model === "gemma4:12b", ollama.model);
  check("Ollama 的来源小字跟着换", ollama.sourceText === "来源 · 本机 Ollama", ollama.sourceText);
  check("换来源窗口尺寸仍然不变",
    Math.abs(ollama.panelHeight - before.panelHeight) <= 1, String(ollama.panelHeight));
  await page.click("#maslingo-ai-cancel");
  await new Promise((r) => setTimeout(r, 500));

  await page.evaluate(() => {
    const select = document.getElementById("maslingo-provider");
    select.value = "bing-free";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await new Promise((r) => setTimeout(r, 700));
  const back = await sample();
  check("非 AI 来源：留在主页面（不跳配置页）", back.aiPage === false && back.basicHeight > 40,
    JSON.stringify({ aiPage: back.aiPage, basic: back.basicHeight }));
  check("非 AI 来源：按钮回到「连通检测」", back.configureLabel === "连通检测", back.configureLabel);
  check("非 AI 来源：来源小字跟着换", back.sourceText === "来源 · 必应翻译", back.sourceText);
  check("非 AI 来源：密钥与强度收起", back.keyHeight < 2 && back.strengthHeight < 2);
  check("切回后窗口尺寸不变",
    Math.abs(back.panelHeight - before.panelHeight) <= 1,
    JSON.stringify({ before: before.panelHeight, back: back.panelHeight }));
  check("切回后内容没有被裁掉", back.bodyClipped === false);
  check("页面无脚本错误", errors.length === 0, errors.slice(0, 2).join(" | "));
} finally {
  await browser.close();
  echo.close();
  pages.close();
  rmSync(workDir, { recursive: true, force: true });
}

console.log("");
if (failures.length) {
  console.error(`${failures.length} 项不合格`);
  process.exit(1);
}
console.log("AI 配置页 / 保存取消 / 来源小字 / 流星 与探测文本转发正常");
