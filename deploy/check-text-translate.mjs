// Webpage paragraph translation, end to end.
//
// The feature is hover-driven now: no card should exist before the pointer
// visits a paragraph, hovering opens a white card under that block, moving away
// hides it, and a paragraph already in the target language is not sent to the
// provider at all. The test also pins the two title gaps (source→arrow and
// arrow→target) to the same width.
//
//   node deploy/check-text-translate.mjs

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

const received = [];
const echo = http.createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => { body += chunk; });
  request.on("end", () => {
    let payload = {};
    try {
      payload = JSON.parse(body || "{}");
    } catch {
      payload = {};
    }
    received.push(payload);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ echo: payload }));
  });
});
await new Promise((done) => echo.listen(0, "127.0.0.1", done));
const echoUrl = `http://127.0.0.1:${echo.address().port}/v1/chat/completions`;

const paragraphs = [
  "吾輩は猫である。名前はまだ無い。どこで生れたかとんと見当がつかぬ。",
  "何でも薄暗いじめじめした所でニャーニャー泣いていた事だけは記憶している。",
  "吾輩はここで始めて人間というものを見た。しかもあとで聞くとそれは書生という人間中で一番獰悪な種族であったそうだ。",
];
const chineseParagraph = "这是已经写好的中文段落，不需要再次翻译。";
const shortParagraph = "おはよう、元気？";
const pages = http.createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(
    "<!doctype html><html lang=\"ja\"><head><meta charset=\"utf-8\"><title>text</title>"
    + "<style>body{margin:20px;max-width:640px;font:16px/1.7 sans-serif}"
    + "p,#short{padding:8px;border-radius:6px;background:#f3f4f6}"
    + "p{margin:10px 0}#short{margin:10px 0;height:36px}</style></head><body>"
    + paragraphs.map((text, index) => `<p id="p${index}">${text}</p>`).join("")
    + `<p id="zh">${chineseParagraph}</p>`
    + `<div id="short">${shortParagraph}</div>`
    + "</body></html>",
  );
});
await new Promise((done) => pages.listen(0, "127.0.0.1", done));
const pageUrl = `http://127.0.0.1:${pages.address().port}/`;

const workDir = mkdtempSync(join(tmpdir(), "maslingo-text-"));
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

  await worker.evaluate((url) => {
    globalThis.MAS_providers.list.push({
      id: "echo-text",
      label: "Echo Text",
      group: "AI 大模型",
      adapter: (request) => ({
        url,
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            texts: request.texts,
            target: request.target,
            source: request.source,
            sourceName: request.sourceName,
          }),
        },
      }),
      parse: (json) => {
        const texts = json?.echo?.texts || [];
        return texts.map((text) => `译:${text}`);
      },
    });
    return chrome.storage.local.set({
      translationProvider: "echo-text",
      translationMode: "openai-compatible",
      targetLanguage: "简体中文",
      autoTranslate: false,
      hoverTranslate: true,
      selectionTranslate: false,
    });
  }, echoUrl);

  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 900 });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error?.stack || String(error)));
  await page.goto(pageUrl, { waitUntil: "load" });
  await new Promise((done) => setTimeout(done, 1800));

  const readBoxes = () => page.evaluate(() => {
    const hosts = [...document.querySelectorAll("div[data-maslingo-textbox='1']")];
    return hosts.map((host) => {
      const shadow = host.shadowRoot;
      const titleNode = shadow?.querySelector(".title");
      let title = "";
      if (titleNode) {
        const clone = titleNode.cloneNode(true);
        clone.querySelectorAll("select, option").forEach((node) => node.remove());
        title = clone.textContent.replace(/\s+/g, " ").trim();
      }
      const src = shadow?.querySelector(".src");
      const lang = shadow?.querySelector(".lang");
      const arrow = shadow?.querySelector(".arrow");
      const srcBox = src?.getBoundingClientRect();
      const arrowBox = arrow?.getBoundingClientRect();
      const langBox = lang?.getBoundingClientRect();
      return {
        visible: host.style.display !== "none" && getComputedStyle(host).display !== "none",
        title,
        text: shadow?.querySelector(".text")?.textContent?.trim() || "",
        language: lang?.value || "",
        source: src?.value || "",
        collapsed: Boolean(shadow?.querySelector(".card.collapsed")),
        gapSourceArrow: srcBox && arrowBox ? Math.round((arrowBox.left - srcBox.right) * 10) / 10 : -1,
        gapArrowTarget: arrowBox && langBox ? Math.round((langBox.left - arrowBox.right) * 10) / 10 : -1,
      };
    });
  });

  const waitForVisible = async (needle = "译:") => {
    const deadline = Date.now() + 10000;
    let boxes = [];
    while (Date.now() < deadline) {
      boxes = (await readBoxes()).filter((box) => box.visible && box.text.startsWith(needle));
      if (boxes.length) return boxes[0];
      await new Promise((done) => setTimeout(done, 180));
    }
    return null;
  };

  check("打开悬停翻译时不会自动插入段落框",
    (await readBoxes()).length === 0,
    JSON.stringify(await readBoxes()));

  console.log("悬停：出现、标题间距、翻译");
  await page.hover("#p0");
  const first = await waitForVisible(`译:${paragraphs[0]}`);
  check("悬停段落出现白色翻译框", Boolean(first));
  check("标题仍为「翻译：源 → 目标」且源/目标可读",
    first?.title.replace(/\s+/g, "") === "翻译：→"
      && first?.source === "自动识别" && first?.language === "简体中文",
    JSON.stringify({ title: first?.title, source: first?.source, target: first?.language }));
  check("源语言与箭头、箭头与目标语言的间距相等",
    first && first.gapSourceArrow >= 0 && Math.abs(first.gapSourceArrow - first.gapArrowTarget) <= 1.5,
    JSON.stringify({ left: first?.gapSourceArrow, right: first?.gapArrowTarget }));
  check("框内是本段译文", first?.text === `译:${paragraphs[0]}`, first?.text);
  check("请求带上了所悬停的段落",
    received.some((item) => item.texts?.[0] === paragraphs[0]),
    JSON.stringify(received.map((item) => item.texts)));

  await page.mouse.move(5, 5);
  await new Promise((done) => setTimeout(done, 600));
  check("移开后翻译框隐藏",
    (await readBoxes()).every((box) => !box.visible),
    JSON.stringify(await readBoxes()));

  console.log("\n切换段落与语言");
  await page.hover("#p1");
  const second = await waitForVisible(`译:${paragraphs[1]}`);
  check("悬停另一段显示该段结果", second?.text === `译:${paragraphs[1]}`, second?.text);

  const beforeLanguage = received.length;
  await page.evaluate(() => {
    const host = [...document.querySelectorAll("div[data-maslingo-textbox='1']")]
      .find((node) => node.style.display !== "none");
    const select = host?.shadowRoot?.querySelector(".lang");
    if (!select) return;
    select.value = "English";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const languageDeadline = Date.now() + 8000;
  while (Date.now() < languageDeadline && received.length <= beforeLanguage) {
    await new Promise((done) => setTimeout(done, 200));
  }
  const lastLanguage = received[received.length - 1] || {};
  check("切换目标语言会重新请求", received.length > beforeLanguage, String(received.length));
  check("请求的目标语言是英文", lastLanguage.target === "English", lastLanguage.target);
  check("切语言后框内更新",
    (await waitForVisible(`译:${paragraphs[1]}`))?.text === `译:${paragraphs[1]}`);

  const beforeSource = received.length;
  await page.evaluate(() => {
    const host = [...document.querySelectorAll("div[data-maslingo-textbox='1']")]
      .find((node) => node.style.display !== "none");
    const select = host?.shadowRoot?.querySelector(".src");
    if (!select) return;
    select.value = "日本語";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const sourceDeadline = Date.now() + 8000;
  while (Date.now() < sourceDeadline && received.length <= beforeSource) {
    await new Promise((done) => setTimeout(done, 200));
  }
  const lastSource = received[received.length - 1] || {};
  check("切换源语言会重新请求", received.length > beforeSource, String(received.length));
  check("请求带的是日文源语言",
    lastSource.source === "日本語" && lastSource.sourceName === "日文",
    JSON.stringify({ source: lastSource.source, sourceName: lastSource.sourceName }));

  console.log("\n覆盖至原文 / 还原");
  const hostFor = (id) => page.evaluate((id) => {
    const node = document.getElementById(id)?.nextElementSibling;
    return node?.matches?.("[data-maslingo-textbox='1']") ? true : false;
  }, id);
  check("结果框插在段落之后", await hostFor("p1"));
  const paragraphText = () => page.evaluate(() => document.getElementById("p1")?.textContent.trim() || "");
  await page.evaluate(() => {
    const host = document.getElementById("p1")?.nextElementSibling;
    host?.shadowRoot?.querySelector(".cover")?.click();
  });
  await new Promise((done) => setTimeout(done, 250));
  check("覆盖至原文：段落换成译文", (await paragraphText()) === `译:${paragraphs[1]}`);
  await page.evaluate(() => {
    const host = document.getElementById("p1")?.nextElementSibling;
    host?.shadowRoot?.querySelector(".cover")?.click();
  });
  await new Promise((done) => setTimeout(done, 250));
  check("还原原文：段落文字恢复", (await paragraphText()) === paragraphs[1]);

  console.log("\n同语言与短文本");
  const beforeChinese = received.length;
  await page.hover("#zh");
  await new Promise((done) => setTimeout(done, 600));
  check("中文段落不显示同语言翻译框",
    (await readBoxes()).every((box) => !box.visible),
    JSON.stringify(await readBoxes()));
  check("中文段落没有发给翻译服务",
    received.length === beforeChinese && !received.some((item) => item.texts?.includes(chineseParagraph)),
    JSON.stringify(received.slice(beforeChinese).map((item) => item.texts)));

  await page.hover("#short");
  const short = await waitForVisible(`译:${shortParagraph}`);
  check("较短的块级文本也能被悬停识别", short?.text === `译:${shortParagraph}`, short?.text);

  console.log("\n开关");
  await page.evaluate(() => document.getElementById("maslingo-text").click());
  await new Promise((done) => setTimeout(done, 500));
  const off = await worker.evaluate(() => chrome.storage.local.get("hoverTranslate"));
  check("面板开关写入 hoverTranslate=false", off.hoverTranslate === false, JSON.stringify(off));
  check("关闭后移除已插入的段落框", (await readBoxes()).length === 0,
    String((await readBoxes()).length));
  await page.hover("#p0");
  await new Promise((done) => setTimeout(done, 600));
  check("关闭后悬停不弹框", (await readBoxes()).length === 0);

  await page.evaluate(() => document.getElementById("maslingo-text").click());
  await new Promise((done) => setTimeout(done, 300));
  await page.evaluate(() => {
    const panel = document.getElementById("maslingo-panel");
    if (panel) panel.style.display = "none";
  });
  await page.mouse.move(5, 5);
  await new Promise((done) => setTimeout(done, 120));
  await page.hover("#p0");
  const finalCard = await waitForVisible(`译:${paragraphs[0]}`);
  check("重新开启后悬停仍能显示结果", Boolean(finalCard));
  check("页面无脚本错误", errors.length === 0, errors.slice(0, 2).join(" | "));
  await page.screenshot({ path: join(repoRoot, "deploy", "screenshots", "text-translate.png") });
  console.log("      截图：deploy/screenshots/text-translate.png");
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
console.log("网页文本翻译：悬停显示 / 标题等距 / 同语言跳过 / 短块识别 / 开关正常");
