// Selection translation, end to end.
//
// A fake chat provider answers the dictionary prompt with a two-sense entry.
// The page selects 猫 and dispatches mouseup, then checks that the card shows
// every sense, part of speech and example, and highlights the sense the
// context points at. A phrase must take the ordinary-translation path, Esc
// must close the card, and a non-chat source must say plainly that it cannot
// produce a dictionary entry.
//
//   node deploy/check-selection-translate.mjs

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

const dictionaryEntry = {
  word: "猫",
  reading: "ねこ",
  dictionary: "広辞苑・新明解国語辞典",
  senses: [
    {
      pos: "名词",
      meaning: "猫。家猫。",
      example: "猫が窓辺で眠っている。",
      exampleTranslation: "猫在窗边睡觉。",
    },
    {
      pos: "名词",
      meaning: "（转义）装糊涂的人。",
      example: "猫をかぶる。",
      exampleTranslation: "装傻。",
    },
  ],
  contextSense: 1,
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
    if (payload.prompt) {
      // The OpenAI-compatible shape, which is what the fake chat provider's
      // extractText reads.
      response.end(JSON.stringify({
        choices: [{ message: { content: JSON.stringify(dictionaryEntry) } }],
      }));
    } else if (payload.basic) {
      response.end(JSON.stringify({
        translations: (payload.texts || []).map((text) => `译:${text}`),
      }));
    } else {
      response.end(JSON.stringify({
        choices: [{ message: {
          content: JSON.stringify((payload.texts || []).map((text) => `译:${text}`)),
        } }],
      }));
    }
  });
});
await new Promise((done) => echo.listen(0, "127.0.0.1", done));
const echoUrl = `http://127.0.0.1:${echo.address().port}/v1/chat/completions`;

const pages = http.createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(
    "<!doctype html><html lang=\"ja\"><head><meta charset=\"utf-8\"><title>selection</title>"
    + "<style>body{margin:30px;max-width:640px;font:17px/1.8 sans-serif}"
    + "p{padding:10px 12px;background:#f3f4f6;border-radius:8px}"
    + "input,textarea{display:block;width:100%;margin:12px 0;padding:8px;font:16px sans-serif}"
    + "</style></head><body>"
    + "<p id=\"one\">猫が窓辺で眠っている。今日はいい天気だ。</p>"
    + "<p id=\"two\">吾輩は猫である。名前はまだ無い。</p>"
    + "<p id=\"zh\">这是已经写好的中文段落，不需要再次翻译。</p>"
    + "<input id=\"field\" value=\"おはよう、元気ですか\">"
    + "<textarea id=\"area\">今日はいい天気ですね。</textarea>"
    + "</body></html>",
  );
});
await new Promise((done) => pages.listen(0, "127.0.0.1", done));
const pageUrl = `http://127.0.0.1:${pages.address().port}/`;

const workDir = mkdtempSync(join(tmpdir(), "maslingo-selection-"));
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
      id: "echo-selection",
      label: "Echo Selection",
      group: "AI 大模型",
      chat: true,
      adapter: (request) => ({
        url,
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: request.prompt || null,
            texts: request.texts,
            target: request.target,
          }),
        },
      }),
      extractText: (json) => json?.choices?.[0]?.message?.content,
      parse: (json) => {
        const content = json?.choices?.[0]?.message?.content;
        return JSON.parse(content).map((text) => String(text));
      },
    });
    globalThis.MAS_providers.list.push({
      id: "echo-basic",
      label: "Echo Basic",
      group: "翻译 API",
      chat: false,
      adapter: (request) => ({
        url,
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ basic: true, texts: request.texts }),
        },
      }),
      parse: (json) => (json?.translations || []).map((text) => String(text)),
    });
    return chrome.storage.local.set({
      translationProvider: "echo-selection",
      translationMode: "openai-compatible",
      targetLanguage: "简体中文",
      autoTranslate: false,
      hoverTranslate: false,
      selectionTranslate: true,
    });
  }, echoUrl);

  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 900 });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error?.stack || String(error)));
  await page.goto(pageUrl, { waitUntil: "load" });
  await new Promise((done) => setTimeout(done, 1800));
  const panelChecked = () => page.evaluate(() =>
    document.getElementById("maslingo-selection-toggle")?.checked);
  check("面板里的划词翻译默认开启", (await panelChecked()) === true);

  const selectText = (paragraph, start, end) => page.evaluate(({ paragraph, start, end }) => {
    const node = document.getElementById(paragraph).firstChild;
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, end);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.getElementById(paragraph).dispatchEvent(new MouseEvent("mouseup", {
      bubbles: true,
      clientX: range.getBoundingClientRect().left,
      clientY: range.getBoundingClientRect().top,
    }));
  }, { paragraph, start, end });

  const readPopup = () => page.evaluate(() => {
    const host = document.getElementById("maslingo-selection-popup");
    const root = host?.shadowRoot;
    if (!root) return { exists: false };
    const senses = [...root.querySelectorAll(".sense")].map((sense) => ({
      pos: sense.querySelector(".pos")?.textContent.trim() || "",
      meaning: sense.querySelector(".meaning")?.textContent.trim() || "",
      example: sense.querySelector(".ex")?.textContent.trim() || "",
      exampleTranslation: sense.querySelector(".ex-t")?.textContent.trim() || "",
      context: sense.classList.contains("is-context"),
      tag: sense.querySelector(".tag")?.textContent.trim() || "",
      posBackground: sense.querySelector(".pos")
        ? getComputedStyle(sense.querySelector(".pos")).backgroundColor
        : "",
    }));
    return {
      exists: true,
      meta: root.querySelector(".meta")?.textContent.trim() || "",
      word: root.querySelector(".word")?.textContent.trim() || "",
      reading: root.querySelector(".reading")?.textContent.trim() || "",
      source: root.querySelector(".source")?.textContent.trim() || "",
      senses,
      quote: root.querySelector(".quote")?.textContent.trim() || "",
      translation: root.querySelector(".translation")?.textContent.trim() || "",
      notice: root.querySelector(".notice")?.textContent.trim() || "",
      footer: root.querySelector(".foot")?.textContent.trim() || "",
      contextNote: root.querySelector(".context-note")?.textContent.trim() || "",
      minimized: host.classList.contains("minimized"),
      cardVisible: root.querySelector(".card")
        ? getComputedStyle(root.querySelector(".card")).display !== "none"
        : false,
      miniVisible: root.querySelector(".mini")
        ? getComputedStyle(root.querySelector(".mini")).display !== "none"
        : false,
      width: Math.round(host.getBoundingClientRect().width),
    };
  });

  const waitForPopup = async (predicate = (state) => state.exists) => {
    const deadline = Date.now() + 10000;
    let state = await readPopup();
    while (Date.now() < deadline && !predicate(state)) {
      await new Promise((done) => setTimeout(done, 180));
      state = await readPopup();
    }
    return state;
  };

  console.log("单字：权威词典义项 / 词性 / 例句 / 本文义项");
  await selectText("one", 0, 1);
  const word = await waitForPopup((state) => state.word === "猫" && state.senses?.length === 2);
  check("划词后弹出白色卡片", word.exists === true);
  check("卡片显示词条与读音", word.word === "猫" && word.reading === "ねこ",
    JSON.stringify({ word: word.word, reading: word.reading }));
  check("卡片列出全部义项", word.senses?.length === 2, JSON.stringify(word.senses));
  check("每个义项都有词性", word.senses?.every((sense) => sense.pos === "名词"));
  check("每个义项都有原文例句与译文",
    word.senses?.every((sense) => sense.example && sense.exampleTranslation),
    JSON.stringify(word.senses));
  check("本文义项被标记并高亮",
    word.senses?.[0]?.context === true && word.senses?.[0]?.tag === "本文义项"
      && word.senses?.[0]?.posBackground === "rgb(28, 30, 33)",
    JSON.stringify(word.senses?.[0]));
  check("其他义项没有被误标", word.senses?.[1]?.context === false && !word.senses?.[1]?.tag);
  check("释义标明权威辞典来源", word.source.includes("広辞苑") && word.source.includes("新明解"),
    word.source);
  const dictionaryRequest = received.find((item) => item.prompt);
  check("词典请求带上下文", Boolean(dictionaryRequest?.prompt?.includes("猫が窓辺で眠っている")));
  check("词典请求要求全部义项与本文义项",
    dictionaryRequest?.prompt?.includes("全部") || dictionaryRequest?.prompt?.includes("常见义项"),
    dictionaryRequest?.prompt?.slice(0, 120));

  console.log("\n最小化为图标");
  await page.evaluate(() => {
    document.getElementById("maslingo-selection-popup")
      ?.shadowRoot?.querySelector(".min")?.click();
  });
  await new Promise((done) => setTimeout(done, 150));
  const mini = await readPopup();
  check("点最小化后卡片隐藏、图标出现",
    mini.minimized && mini.cardVisible === false && mini.miniVisible === true,
    JSON.stringify({ minimized: mini.minimized, card: mini.cardVisible, icon: mini.miniVisible }));
  check("图标缩到 38px", mini.width <= 40, String(mini.width));
  await page.screenshot({ path: join(repoRoot, "deploy", "screenshots", "selection-minimized.png") });
  console.log("      截图：deploy/screenshots/selection-minimized.png");
  await page.evaluate(() => {
    document.getElementById("maslingo-selection-popup")
      ?.shadowRoot?.querySelector(".mini")?.click();
  });
  await new Promise((done) => setTimeout(done, 150));
  const restored = await readPopup();
  check("点图标恢复卡片", restored.minimized === false && restored.cardVisible === true
    && restored.width > 200, JSON.stringify({ width: restored.width }));

  console.log("\n短语：普通翻译");
  const phrase = "猫が窓辺で眠っている";
  await selectText("one", 0, phrase.length);
  const textResult = await waitForPopup((state) => state.translation === `译:${phrase}`);
  check("短语弹出翻译卡片", textResult.exists === true);
  check("卡片显示选中原文", textResult.quote === phrase, textResult.quote);
  check("卡片显示普通翻译结果", textResult.translation === `译:${phrase}`, textResult.translation);
  check("短语不走词典请求",
    received.filter((item) => item.prompt).length === 1,
    JSON.stringify(received.map((item) => Boolean(item.prompt))));

  console.log("\n输入框与文本域");
  const selectControl = (id) => page.evaluate((id) => {
    const control = document.getElementById(id);
    control.focus();
    control.setSelectionRange(0, control.value.length);
    control.dispatchEvent(new Event("select", { bubbles: true }));
  }, id);
  const inputText = "おはよう、元気ですか";
  await selectControl("field");
  const inputResult = await waitForPopup((state) => state.translation === `译:${inputText}`);
  check("输入框内选中的短语可以翻译",
    inputResult.translation === `译:${inputText}` && inputResult.quote === inputText,
    JSON.stringify({ quote: inputResult.quote, translation: inputResult.translation }));
  const areaText = "今日はいい天気ですね。";
  await selectControl("area");
  const areaResult = await waitForPopup((state) => state.translation === `译:${areaText}`);
  check("文本域内选中的文字可以翻译",
    areaResult.translation === `译:${areaText}` && areaResult.quote === areaText,
    JSON.stringify({ quote: areaResult.quote, translation: areaResult.translation }));

  console.log("\n同语言不翻译");
  const chinese = "这是已经写好的中文段落，不需要再次翻译。";
  const beforeChinese = received.length;
  await selectText("zh", 0, chinese.length);
  const sameLanguage = await waitForPopup((state) => state.meta === "无需翻译");
  check("中文原文给出「无需翻译」提示",
    sameLanguage.meta === "无需翻译"
      && sameLanguage.notice.includes("原文已是简体中文"),
    JSON.stringify({ meta: sameLanguage.meta, notice: sameLanguage.notice }));
  check("中文原文没有调用翻译服务",
    received.length === beforeChinese
      && !received.some((item) => item.texts?.includes(chinese)),
    JSON.stringify(received.slice(beforeChinese).map((item) => item.texts)));

  console.log("\n关闭与开关");
  await page.keyboard.press("Escape");
  await new Promise((done) => setTimeout(done, 150));
  check("Esc 关闭卡片", (await readPopup()).exists === false);

  await page.evaluate(() => document.getElementById("maslingo-selection-toggle").click());
  await new Promise((done) => setTimeout(done, 300));
  const offStored = await worker.evaluate(() => chrome.storage.local.get("selectionTranslate"));
  check("面板开关关闭会写入存储", offStored.selectionTranslate === false,
    JSON.stringify(offStored));
  check("面板开关显示为关闭", (await panelChecked()) === false);
  await selectText("two", 0, 1);
  await new Promise((done) => setTimeout(done, 600));
  check("关闭划词翻译后不再弹出", (await readPopup()).exists === false);
  await page.evaluate(() => document.getElementById("maslingo-selection-toggle").click());
  await new Promise((done) => setTimeout(done, 300));
  const onStored = await worker.evaluate(() => chrome.storage.local.get("selectionTranslate"));
  check("面板开关重新开启会写入存储", onStored.selectionTranslate === true,
    JSON.stringify(onStored));

  console.log("\n非 AI 来源：普通翻译与如实提示");
  await worker.evaluate(() => chrome.storage.local.set({
    translationProvider: "echo-basic",
  }));
  await new Promise((done) => setTimeout(done, 300));
  await selectText("two", 0, 1);
  const basic = await waitForPopup((state) => state.translation === "译:吾");
  check("非 AI 来源仍能给出普通翻译", basic.translation === "译:吾", basic.translation);
  check("非 AI 来源明确说明没有词典释义",
    basic.notice.includes("词典释义需要 AI 大模型来源"),
    basic.notice);
  check("页面无脚本错误", errors.length === 0, errors.slice(0, 2).join(" | "));

  await page.keyboard.press("Escape");
  await worker.evaluate(() => chrome.storage.local.set({
    translationProvider: "none", translationMode: "none",
  }));
  await new Promise((done) => setTimeout(done, 300));
  await selectText("two", 0, 1);
  await new Promise((done) => setTimeout(done, 500));
  check("未选择翻译来源时不打扰页面", (await readPopup()).exists === false);

  // A visual record for the docs: put the dictionary view back and hide the
  // floating panel so it does not cover the card.
  await worker.evaluate(() => chrome.storage.local.set({
    translationProvider: "echo-selection", translationMode: "openai-compatible",
  }));
  await new Promise((done) => setTimeout(done, 200));
  await page.evaluate(() => {
    const panel = document.getElementById("maslingo-panel");
    if (panel) panel.style.display = "none";
  });
  await selectText("one", 0, 1);
  await waitForPopup((state) => state.word === "猫");
  await page.screenshot({ path: join(repoRoot, "deploy", "screenshots", "selection-translate.png") });
  console.log("      截图：deploy/screenshots/selection-translate.png");
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
console.log("划词翻译：词典义项 / 词性 / 例句 / 本文义项高亮 / 普通翻译 / 开关正常");
