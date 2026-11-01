// Same-language suppression through the real service worker.
//
// Auto-detected webpage text already in the target language is skipped.
// MangaOCR has a known Japanese source: kanji-only lines must still translate.
//
//   node deploy/check-same-language.mjs

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
    const payload = JSON.parse(body || "{}");
    received.push(payload);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ echo: payload }));
  });
});
await new Promise((done) => echo.listen(0, "127.0.0.1", done));
const echoUrl = `http://127.0.0.1:${echo.address().port}/v1/chat/completions`;

const workDir = mkdtempSync(join(tmpdir(), "maslingo-same-"));
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
  const extensionId = new URL(worker.url()).host;

  await worker.evaluate((url) => {
    globalThis.MAS_providers.list.push({
      id: "echo-same",
      label: "Echo Same",
      group: "AI 大模型",
      chat: true,
      adapter: (request) => ({
        url,
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ texts: request.texts, target: request.target }),
        },
      }),
      parse: (json) => (json?.echo?.texts || []).map((text) => `译:${text}`),
    });
    return chrome.storage.local.set({
      translationProvider: "echo-same",
      translationMode: "openai-compatible",
      targetLanguage: "简体中文",
    });
  }, echoUrl);

  const popup = await browser.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`, { waitUntil: "load" });
  const chinese = "这是已经写好的中文，不需要再次翻译。";
  const japanese = "おはようございます。";

  const kanji = "用事";
  const auto = await popup.evaluate(({ kanji, japanese }) => chrome.runtime.sendMessage({
    type: "AUTO_TRANSLATE",
    texts: [kanji, japanese],
  }), { kanji, japanese });
  check("AUTO_TRANSLATE 返回两项", auto?.ok && auto.items?.length === 2,
    JSON.stringify(auto));
  check("日文 OCR 的纯汉字短句不会被误判中文而跳过",
    auto.items?.[0]?.skipped === false && auto.items?.[0]?.translated === `译:${kanji}`,
    JSON.stringify(auto.items?.[0]));
  check("同一批里的日文仍然翻译",
    auto.items?.[1]?.skipped === false && auto.items?.[1]?.translated === `译:${japanese}`,
    JSON.stringify(auto.items?.[1]));
  check("翻译服务收到纯汉字和假名两条日文",
    received.length === 1 && received[0]?.texts?.length === 2 && received[0]?.texts?.[0] === kanji,
    JSON.stringify(received));

  const beforeParagraph = received.length;
  const paragraph = await popup.evaluate((chinese) => chrome.runtime.sendMessage({
    type: "TRANSLATE_TEXT_BLOCKS",
    texts: [chinese],
    source: "自动识别",
    target: "简体中文",
  }), chinese);
  check("段落接口返回 skipped 标记",
    paragraph?.ok && paragraph.skipped?.[0] === true
      && paragraph.translations?.[0] === chinese,
    JSON.stringify(paragraph));
  check("段落同语言不产生请求", received.length === beforeParagraph);

  const english = "This paragraph is already written in English.";
  const beforeEnglish = received.length;
  const englishResult = await popup.evaluate((english) => chrome.runtime.sendMessage({
    type: "TRANSLATE_TEXT_BLOCKS",
    texts: [english],
    source: "自动识别",
    target: "English",
  }), english);
  check("英文到英文也通过 Chrome 检测跳过",
    englishResult?.ok && englishResult.skipped?.[0] === true
      && englishResult.translations?.[0] === english,
    JSON.stringify(englishResult));
  check("英文同语言不产生请求", received.length === beforeEnglish);

  const beforeLookup = received.length;
  const lookup = await popup.evaluate((chinese) => chrome.runtime.sendMessage({
    type: "LOOKUP_WORD",
    text: chinese,
    context: chinese,
    word: false,
  }), chinese);
  check("划词短语同语言返回无需翻译",
    lookup?.ok && lookup.kind === "notice" && lookup.notice.includes("无需翻译"),
    JSON.stringify(lookup));
  check("划词同语言不产生请求", received.length === beforeLookup);
  await popup.close();
} finally {
  await browser.close();
  echo.close();
  rmSync(workDir, { recursive: true, force: true });
}

console.log("");
if (failures.length) {
  console.error(`${failures.length} 项不合格`);
  process.exit(1);
}
console.log("同语言抑制：已知日文 OCR 不漏翻；自动识别的同语言段落和划词不请求服务");
