// Unit tests for the translation provider layer.
//
// The adapters are pure request/response builders, so they can be checked
// without any API key: known hashes for the two signed Chinese APIs, the exact
// request each provider would send, and the parser against a realistic fixture
// for every response shape. What cannot be checked here is whether a vendor
// accepts the request — that needs a real key.
//
//   node deploy/check-providers.mjs

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(repoRoot, "extension", "translation", "providers.js"), "utf8");

const sandbox = { crypto, TextEncoder, URLSearchParams, console, Math, Date, JSON };
vm.createContext(sandbox);
vm.runInContext(source, sandbox);
const providers = sandbox.MAS_providers;

const failures = [];
const check = (name, condition, detail = "") => {
  if (condition) {
    console.log(`  ok    ${name}`);
  } else {
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
    failures.push(name);
  }
};
const section = (title) => console.log(`\n${title}`);

// --- hashing: the hand-written MD5 is the risky part ------------------------
section("MD5（百度签名用，手写实现）");
const md5Vectors = [
  ["", "d41d8cd98f00b204e9800998ecf8427e"],
  ["abc", "900150983cd24fb0d6963f7d28e17f72"],
  ["message digest", "f96b697d7cb7938d525a2f31aaf161d0"],
  ["abcdefghijklmnopqrstuvwxyz", "c3fcd3d76192e4007dfb496cca67e13b"],
  ["The quick brown fox jumps over the lazy dog", "9e107d9d372bb6826bd81d3542a419d6"],
];
for (const [input, expected] of md5Vectors) {
  const actual = providers.md5(input);
  check(`md5(${JSON.stringify(input.slice(0, 24))})`, actual === expected, `得到 ${actual}`);
}

section("SHA-256（有道签名用）");
const sha = await providers.sha256Hex("abc");
check("sha256(abc)", sha === "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", sha);

// --- request construction ---------------------------------------------------
section("请求构造");
const TEXTS = ["おはよう", "ありがとう"];

const requestFor = (id, extra = {}) =>
  providers.byId(id).adapter({
    endpoint: providers.byId(id).endpoint,
    apiKey: "KEY",
    model: providers.byId(id).model,
    appId: "APPID",
    source: providers.byId(id).source || "ja",
    target: providers.byId(id).target || "zh-CN",
    texts: TEXTS,
    salt: 123456,
    ...extra,
  });

const openaiReq = await requestFor("openai");
check("openai 走 POST", openaiReq.init.method === "POST");
check("openai 带 Bearer", openaiReq.init.headers.Authorization === "Bearer KEY");
check("openai 用配置的模型",
  JSON.parse(openaiReq.init.body).model === providers.byId("openai").model);
check(
  "openai 提示词里含原文数组",
  JSON.parse(openaiReq.init.body).messages[0].content.includes(JSON.stringify(TEXTS)),
);

const geminiReq = await requestFor("gemini");
check("gemini 使用 generateContent", geminiReq.url.includes(":generateContent"));
check("gemini 把密钥放在查询串", geminiReq.url.includes("key=KEY"));

const claudeReq = await requestFor("claude");
check("claude 用 x-api-key", claudeReq.init.headers["x-api-key"] === "KEY");
check("claude 声明 anthropic-version", Boolean(claudeReq.init.headers["anthropic-version"]));
check(
  "claude 开启浏览器直连",
  claudeReq.init.headers["anthropic-dangerous-direct-browser-access"] === "true",
);

const deepLReq = await requestFor("deepL");
check("deepl 使用 DeepL-Auth-Key", deepLReq.init.headers.Authorization === "DeepL-Auth-Key KEY");
check("deepl 一次带多条文本", JSON.parse(deepLReq.init.body).text.length === 2);

const googleReq = await requestFor("google-free", { text: "おはよう" });
check("google 免密钥", !googleReq.init.headers || !googleReq.init.headers.Authorization);
check("google 目标语言正确", googleReq.url.includes("tl=zh-CN"));
check("google 原文已编码", googleReq.url.includes(encodeURIComponent("おはよう")));
const googleTextsOnly = await providers.byId("google-free").adapter({
  texts: ["おはよう"], source: "ja", target: "zh-CN",
});
check("google 只给 texts 时取到原文（连通检测走这条路）",
  googleTextsOnly.url.includes(encodeURIComponent("おはよう")), googleTextsOnly.url);

const baiduReq = await requestFor("baidu");
const baiduBody = new URLSearchParams(baiduReq.init.body);
const expectedSign = providers.md5(`APPID${TEXTS.join("\n")}123456KEY`);
check("baidu 签名符合官方公式", baiduBody.get("sign") === expectedSign, baiduBody.get("sign"));
check("baidu 带 appid", baiduBody.get("appid") === "APPID");
check("baidu 多条以换行连接", baiduBody.get("q") === TEXTS.join("\n"));

const youdaoReq = await requestFor("youdao");
const youdaoBody = new URLSearchParams(youdaoReq.init.body);
check("youdao 声明 signType=v3", youdaoBody.get("signType") === "v3");
check("youdao 带 curtime", /^\d+$/.test(youdaoBody.get("curtime") || ""));
check("youdao 签名是 64 位十六进制", /^[0-9a-f]{64}$/.test(youdaoBody.get("sign") || ""));

const backendReq = await requestFor("backend");
check("backend 调用 /api/translate-text", backendReq.url.endsWith("/api/translate-text"));

const myMemoryReq = await requestFor("mymemory", { text: "おはよう" });
check("MyMemory 用公开 get 端点",
  myMemoryReq.url.startsWith("https://api.mymemory.translated.net/get?"), myMemoryReq.url);
check("MyMemory 带 langpair", myMemoryReq.url.includes(encodeURIComponent("ja|zh-CN")));

// --- Bing's free flow: page tokens, then the translate request ---------------
//
// The adapter fetches the translator page for its IG/key/token pair. The fetch
// is stubbed here so the check stays offline and deterministic; the live flow
// was measured separately (and the extension's service worker sees the same
// behaviour, since nothing but the page fetch is involved).
section("必应免密钥流程（页面令牌 → 翻译请求）");
const BING_PAGE = '<!doctype html><script>var _G={IG:"ABC123DEF456"};'
  + 'params_AbusePreventionHelper=[1791710657099,"TOKENVALUE",3600000];</script>';
const bingFetchCalls = [];
sandbox.fetch = async (url) => {
  bingFetchCalls.push(url);
  return { ok: url === "https://cn.bing.com/translator", status: 200, text: async () => BING_PAGE };
};
const bingBuilt = await providers.byId("bing-free").adapter({
  text: "おはよう", source: "ja", target: "zh-Hans",
});
check("bing 从翻译页取令牌", bingFetchCalls[0] === "https://cn.bing.com/translator", bingFetchCalls.join(","));
check("bing 请求带 IG",
  bingBuilt.url.includes("ttranslatev3") && bingBuilt.url.includes("IG=ABC123DEF456"), bingBuilt.url);
check("bing 表单带 key / token / 目标语言",
  bingBuilt.init.body.includes("key=1791710657099")
    && bingBuilt.init.body.includes("token=TOKENVALUE")
    && bingBuilt.init.body.includes("to=zh-Hans")
    && bingBuilt.init.body.includes(encodeURIComponent("おはよう")),
  bingBuilt.init.body);
const bingSecond = await providers.byId("bing-free").adapter({
  text: "ありがとう", source: "ja", target: "zh-Hans",
});
check("bing 令牌缓存（第二条不再请求页面）",
  bingFetchCalls.length === 1 && bingSecond.url.includes("IG=ABC123DEF456"),
  `fetch ${bingFetchCalls.length} 次`);
// 一次一条的适配器也可能只拿到 `texts`：面板的连通检测曾经只传 texts，必应于是
// 把字面量 "undefined" 当原文送出去，面板上显示的「未定义」就是必应对这个词的
// 翻译结果。这条锁住修复。
const bingTextsOnly = await providers.byId("bing-free").adapter({
  texts: ["ありがとう"], source: "ja", target: "zh-Hans",
});
check("bing 只给 texts 时取到原文（不再翻译 undefined）",
  bingTextsOnly.init.body.includes(encodeURIComponent("ありがとう"))
    && !bingTextsOnly.init.body.includes("undefined"),
  bingTextsOnly.init.body);

// --- translation strength ---------------------------------------------------
section("反应强度（Low / High / Max，无 Off）");
check("Low / High / Max 各带一条指令",
  providers.chatPrompt(["おはよう"], "简体中文", 0).includes("强度 Low")
    && providers.chatPrompt(["おはよう"], "简体中文", 1).includes("强度 High")
    && providers.chatPrompt(["おはよう"], "简体中文", 2).includes("强度 Max"));
check("档位语义：不联网轻度润色 / 联网润色 / 联网完美翻译",
  providers.chatPrompt(["おはよう"], "简体中文", 0).includes("不联网轻度润色")
    && providers.chatPrompt(["おはよう"], "简体中文", 1).includes("联网润色")
    && providers.chatPrompt(["おはよう"], "简体中文", 2).includes("联网完美翻译"));
const openaiMax = await requestFor("openai", { strength: 2 });
check("强度进入实际请求（OpenAI 形状）",
  JSON.parse(openaiMax.init.body).messages[0].content.includes("强度 Max"));
check("默认强度是 Low（0）",
  providers.normalizeStrength(undefined) === 0
    && providers.normalizeStrength(null) === 0
    && providers.normalizeStrength("") === 0);
check("旧的 Off（0）落到 Low，越界被夹到 0..2",
  providers.normalizeStrength(0) === 0
    && providers.normalizeStrength(9) === 2
    && providers.normalizeStrength(-3) === 0
    && providers.normalizeStrength(3) === 2);
check("档位文案齐全（三档，各带说明）",
  providers.strengths.length === 3
    && providers.strengthLabel(0) === "Low"
    && providers.strengthLabel(1) === "High"
    && providers.strengthLabel(2) === "Max"
    && providers.strengthHint(0) === "不联网轻度润色"
    && providers.strengthHint(1) === "联网润色"
    && providers.strengthHint(2) === "联网完美翻译");

// --- strength carries the proper-noun policy --------------------------------
section("档位里的专有名词要求（前后文一致 + 联网核官方译名）");
check("High / Max 要求联网核对专有名词官方译名（含人名）",
  providers.chatPrompt(["おはよう"], "简体中文", 1).includes("联网核对官方译名")
    && providers.chatPrompt(["おはよう"], "简体中文", 1).includes("人名")
    && providers.chatPrompt(["おはよう"], "简体中文", 2).includes("官方译名")
    && providers.chatPrompt(["おはよう"], "简体中文", 2).includes("人名"));
check("Low 明确不联网，只做轻度润色",
  providers.chatPrompt(["おはよう"], "简体中文", 0).includes("不要联网检索")
    && !providers.chatPrompt(["おはよう"], "简体中文", 0).includes("联网核对官方译名"));
check("每一档都要求专有名词在整批上下文中前后一致",
  [0, 1, 2].every((level) =>
    providers.chatPrompt(["おはよう"], "简体中文", level)
      .includes("专有名词必须在整批上下文中前后一致")));

// --- enhanced recognition: AI vision ---------------------------------------
section("增强识别（整页交给 AI：定位 + 翻译）");
const visionPrompt = providers.visionPrompt(1, "简体中文");
check("视觉提示词要求 JSON 盒子 + 原文 + 译文",
  visionPrompt.includes('"items"') && visionPrompt.includes('"box"')
    && visionPrompt.includes('"text"') && visionPrompt.includes('"translation"'));
check("视觉提示词要求 0-1000 相对坐标并紧贴文字",
  visionPrompt.includes("0-1000") && visionPrompt.includes("紧贴文字"));
check("视觉提示词要求专有名词全页一致",
  visionPrompt.includes("专有名词在整页内必须前后一致"));
check("视觉提示词随档位变化（不联网 / 联网润色 / 联网完美翻译）",
  providers.visionPrompt(0, "简体中文").includes("不联网轻度润色")
    && providers.visionPrompt(1, "简体中文").includes("联网润色")
    && providers.visionPrompt(2, "简体中文").includes("联网完美翻译"));

const visionImage = "data:image/png;base64,QUJD";
const buildVision = (id, extra = {}) => providers.visionFor(providers.byId(id)).build({
  endpoint: providers.byId(id).endpoint,
  apiKey: "KEY",
  model: providers.byId(id).model,
  strength: 0,
  target: "简体中文",
  image: visionImage,
  ...extra,
});
const openaiVisionBody = JSON.parse(buildVision("openai").init.body);
check("OpenAI 形状把整页作为 image_url 发送",
  openaiVisionBody.messages[0].content.some(
    (part) => part.type === "image_url" && part.image_url.url === visionImage));
check("OpenAI 视觉请求带提示词",
  openaiVisionBody.messages[0].content.some(
    (part) => part.type === "text" && part.text.includes("整页日文漫画截图")));
const geminiVisionBody = JSON.parse(buildVision("gemini").init.body);
check("Gemini 形状使用 inline_data",
  geminiVisionBody.contents[0].parts.some(
    (part) => part.inline_data?.mime_type === "image/png"
      && part.inline_data.data === "QUJD"));
const claudeVisionBody = JSON.parse(buildVision("claude").init.body);
check("Claude 形状使用 base64 image block",
  claudeVisionBody.messages[0].content.some(
    (part) => part.type === "image" && part.source?.type === "base64"
      && part.source.media_type === "image/png"));
check("视觉适配器只给 AI 大模型来源",
  providers.visionFor(providers.byId("openai"))?.family === "openai"
    && providers.visionFor(providers.byId("gemini"))?.family === "gemini"
    && providers.visionFor(providers.byId("claude"))?.family === "claude"
    && providers.visionFor(providers.byId("google-free")) === null
    && providers.visionFor(providers.byId("none")) === null);

const visionParsed = providers.parseVisionItems(
  '{"items":[{"box":[100,200,300,400],"text":"おはよう","translation":"早上好"}]}',
  { width: 1000, height: 1000 });
check("解析视觉 JSON（0-1000 相对坐标）",
  visionParsed.length === 1 && visionParsed[0].text === "おはよう"
    && visionParsed[0].translation === "早上好" && visionParsed[0].box[2] === 300);
const visionFenced = providers.parseVisionItems(
  '```json\n[{"box":[0,0,1000,1000],"text":"a","translation":"b"}]\n```');
check("解析器容忍代码块与数组形状",
  visionFenced.length === 1 && visionFenced[0].translation === "b");
const visionPixels = providers.parseVisionItems(
  JSON.stringify([{ box: [200, 100, 1200, 900], text: "a", translation: "b" }]),
  { width: 1600, height: 1200 });
check("解析器识别像素坐标并换算",
  visionPixels[0].box[0] === 125 && visionPixels[0].box[2] === 750,
  JSON.stringify(visionPixels[0].box));
let visionRejected = false;
try {
  providers.parseVisionItems('{"items":[{"box":[0,0,10,10],"text":"あ"}]}');
} catch {
  visionRejected = true;
}
check("没有译文的条目被丢弃（整条结果为空则报错）", visionRejected);

// --- the concrete model per provider ----------------------------------------
section("具体模型（每个来源自己的型号，不跨来源泄漏）");
const deepseekProvider = providers.byId("deepseek");
const openaiProvider = providers.byId("openai");
check("没有覆盖时用来源默认型号",
  providers.resolveModel(deepseekProvider, {}) === "deepseek-flash");
check("覆盖属于该来源时生效",
  providers.resolveModel(deepseekProvider, {
    translationModel: "deepseek-reasoner", translationModelProvider: "deepseek",
  }) === "deepseek-reasoner");
check("覆盖属于别的来源时被忽略",
  providers.resolveModel(openaiProvider, {
    translationModel: "deepseek-reasoner", translationModelProvider: "deepseek",
  }) === "gpt-6.1-sol");
check("旧档案（没有归属标记）仍沿用存的型号",
  providers.resolveModel(openaiProvider, { translationModel: "my-finetune" }) === "my-finetune");
check("空白覆盖回落到来源默认",
  providers.resolveModel(deepseekProvider, {
    translationModel: "  ", translationModelProvider: "deepseek",
  }) === "deepseek-flash");
check("AI 来源都带型号清单，且第一项就是默认型号",
  ["openai", "deepseek", "moonshot", "zhipu", "dashscope", "siliconflow", "groq",
    "openrouter", "gemini", "claude", "ollama"].every((id) => {
    const provider = providers.byId(id);
    const models = providers.modelsOf(provider);
    return models.length >= 2 && models[0].id === provider.model;
  }));
check("DeepSeek 的型号是当前的具体型号（V4.1 Flash / V4 Pro）",
  providers.modelsOf(deepseekProvider).map((model) => model.id).join(",")
    === "deepseek-flash,deepseek-v4-pro"
    && providers.modelsOf(deepseekProvider)[0].label === "DeepSeek V4.1 Flash"
    && providers.modelsOf(deepseekProvider)[1].label === "DeepSeek V4 Pro");
check("ChatGPT 条目带上产品名，型号是现行 GPT-6 家族（4o 已无 API）",
  providers.byId("openai").label.includes("ChatGPT")
    && providers.modelsOf(providers.byId("openai")).some((m) => m.id === "gpt-6.1-sol")
    && !providers.modelsOf(providers.byId("openai")).some((m) => m.id.includes("4o")));
check("Claude 的型号 id 用官方连字符写法（不是版本号的点）",
  providers.modelsOf(providers.byId("claude")).every((m) => /^claude-[a-z]+-\d+(-\d+)+$/.test(m.id)));
check("Groq / 硅基流动也换成了现行型号",
  providers.modelsOf(providers.byId("groq")).some((m) => m.id === "qwen/qwen3.8-27b")
    && providers.modelsOf(providers.byId("siliconflow")).some((m) => m.id === "deepseek-ai/DeepSeek-V4-Flash"));
check("Groq 条目有说明（它不是 Grok）",
  (providers.byId("groq").note || "").includes("Grok"));
check("Grok（xAI）条目存在，型号是现行 Grok 家族",
  (providers.byId("xai")?.label || "").includes("Grok")
    && providers.byId("xai").host === "https://api.x.ai/*"
    && providers.byId("xai").model === "grok-4.7"
    && providers.modelsOf(providers.byId("xai")).some((m) => m.id === "grok-4.6"));
check("自定义模型框只开给读它的适配器（OpenAI 兼容）",
  providers.byId("deepseek").modelEditable === true
    && providers.byId("custom").modelEditable === true
    && providers.byId("gemini").modelEditable === false
    && providers.byId("claude").modelEditable === false);

// --- response parsing -------------------------------------------------------
section("响应解析");
const count = 2;
// Providers that translate one text per request parse a single-item result.
const SINGLE_CALL = new Set(["google-free", "mymemory", "bing-free"]);
const cases = [
  ["openai JSON 数组", "openai", { choices: [{ message: { content: '["甲","乙"]' } }] }],
  ["openai 带代码块", "openai", { choices: [{ message: { content: '```json\n["甲","乙"]\n```' } }] }],
  ["openai 前后有解释", "openai", { choices: [{ message: { content: '好的：\n["甲","乙"]\n完成' } }] }],
  ["openai 换行兜底", "openai", { choices: [{ message: { content: "1. 甲\n2. 乙" } }] }],
  ["gemini", "gemini", { candidates: [{ content: { parts: [{ text: '["甲","乙"]' }] } }] }],
  ["claude", "claude", { content: [{ text: '["甲","乙"]' }] }],
  ["google 免密钥", "google-free", [[["甲", "おはよう", null, null, 10], ["乙", "ありがとう", null, null, 10]], null, "ja"]],
  ["deepl", "deepL", { translations: [{ text: "甲" }, { text: "乙" }] }],
  ["baidu", "baidu", { trans_result: [{ src: "a", dst: "甲" }, { src: "b", dst: "乙" }] }],
  ["youdao", "youdao", { errorCode: "0", translation: ["甲", "乙"] }],
  ["mymemory", "mymemory", { responseStatus: 200, responseData: { translatedText: "甲乙" } }],
  ["bing", "bing-free", [{ translations: [{ text: "甲乙" }] }]],
  ["backend", "backend", { ok: true, items: [{ text: "a", translated: "甲" }, { text: "b", translated: "乙" }] }],
];
for (const [name, id, fixture] of cases) {
  const provider = providers.byId(id);
  let parsed = null;
  let error = null;
  try {
    parsed = provider.parse(fixture, SINGLE_CALL.has(id) ? 1 : count);
  } catch (caught) {
    error = caught;
  }
  const expected = SINGLE_CALL.has(id) ? ["甲乙"] : ["甲", "乙"];
  check(`解析 ${name}`, !error && JSON.stringify(parsed) === JSON.stringify(expected),
    error ? error.message : JSON.stringify(parsed));
}

section("错误路径必须抛出，而不是静默给出错误结果");
const mustThrow = [
  ["条数不符", () => providers.byId("openai").parse({ choices: [{ message: { content: '["只有一条"]' } }] }, 2)],
  ["openai 返回错误对象", () => providers.byId("openai").parse({ error: { message: "invalid key" } }, 2)],
  ["gemini 返回错误", () => providers.byId("gemini").parse({ error: { message: "quota" } }, 2)],
  ["claude 返回错误", () => providers.byId("claude").parse({ error: { message: "overloaded" } }, 2)],
  ["百度错误码", () => providers.byId("baidu").parse({ error_code: "54003", error_msg: "访问频率受限" }, 2)],
  ["有道错误码", () => providers.byId("youdao").parse({ errorCode: "108" }, 2)],
  ["后端未成功", () => providers.byId("backend").parse({ ok: false, error: "boom" }, 2)],
  ["google 格式异常", () => providers.byId("google-free").parse({ unexpected: true }, 1)],
  ["MyMemory 配额/错误", () => providers.byId("mymemory").parse({ responseStatus: 429, responseDetails: "QUERY LENGTH LIMIT" }, 1)],
  ["bing 401 对象", () => providers.byId("bing-free").parse({ statusCode: 401, message: "InvalidRequest" }, 1)],
];
for (const [name, fn] of mustThrow) {
  let threw = false;
  try { fn(); } catch { threw = true; }
  check(name, threw, "没有抛出");
}

section("注册表");
const real = providers.list.filter((p) => p.id !== "none");
check("除了「关闭翻译」以外，每个 provider 都有 id/label/parse",
  real.every((p) => p.id && p.label && p.parse && p.adapter));
check("存在「关闭翻译」选项且它没有适配器",
  providers.byId("none") !== null && !providers.byId("none").adapter);
const ids = providers.list.map((p) => p.id);
check("id 不重复", new Set(ids).size === ids.length, ids.join(","));
const hosts = providers.hosts();
check("hosts() 覆盖了固定 host 的 provider",
  providers.list.filter((p) => p.host).every((p) => hosts.includes(p.host)));
check("免密钥的 provider 至少有两个（Google / Ollama）",
  providers.list.filter((p) => !p.keyRequired).length >= 2);
check("每个 provider 都有目标语言与类型",
  providers.list.every((p) => p.target && (p.targetKind === "name" || p.targetKind === "code")));
check("对话类模型用「简体中文」这类可读写法，而不是 zh-CN",
  providers.list.filter((p) => p.targetKind === "name").every((p) => !/^[a-z]{2}(-[A-Za-z]+)?$/.test(p.target)),
  providers.list.filter((p) => p.targetKind === "name").map((p) => `${p.id}=${p.target}`).join(","));
check("翻译 API 用语言代码",
  providers.list.filter((p) => p.targetKind === "code").every((p) => p.target.length <= 8),
  providers.list.filter((p) => p.targetKind === "code").map((p) => `${p.id}=${p.target}`).join(","));

// One resolution rule for the connectivity probe and the real translation —
// they used to disagree, so a probe against `ZH` could pass while every real
// request sent the stored language *name* and failed.
section("目标语言解析（检测与真实翻译共用）");
const openAiProvider = providers.byId("openai");
const deepLProvider = providers.byId("deepL");
check("对话类：用户填写的语言名生效",
  providers.resolveTarget(openAiProvider, { targetLanguage: "繁體中文" }) === "繁體中文");
check("对话类：未填写时回落到默认语言名",
  providers.resolveTarget(openAiProvider, {}) === "简体中文");
check("翻译 API：沿用语言代码，忽略用户填的语言名",
  providers.resolveTarget(deepLProvider, { targetLanguage: "繁體中文" }) === "ZH");
check("翻译 API：未填写时也返回语言代码",
  providers.resolveTarget(deepLProvider, {}) === "ZH");

// The manifest has to declare every host the registry talks to, otherwise the
// request is blocked at runtime with a message that looks like a network error.
section("manifest 权限与注册表一致");
const manifest = JSON.parse(readFileSync(join(repoRoot, "extension", "manifest.json"), "utf8"));
const declared = new Set(manifest.host_permissions || []);
const missing = hosts.filter((host) => !declared.has(host));
check("host_permissions 覆盖全部 provider", missing.length === 0, `缺少 ${missing.join(", ")}`);
// <all_urls> is expected alongside the provider hosts: captureVisibleTab needs
// it (or activeTab, which turned out not to be enough in practice), and
// localhost is a loopback fallback. What should NOT be here is a wildcard
// *domain*, which is what store reviewers push back on.
const extra = [...declared].filter((host) => !hosts.includes(host));
const allowed = new Set(["<all_urls>", "http://localhost:8001/*", "http://localhost:11434/*"]);
const unwanted = extra.filter((host) => !allowed.has(host));
check("没有多余的 host 权限（通配域名会拖慢商店审核）",
  unwanted.length === 0, `多余 ${unwanted.join(", ")}`);
check("为了截图能力声明了 <all_urls>", declared.has("<all_urls>"));
check("自定义接口走可选权限，而不是写死在 manifest 里",
  (manifest.optional_host_permissions || []).includes("https://*/*"));

console.log("");
if (failures.length) {
  console.error(`${failures.length} 项不合格`);
  process.exit(1);
}
console.log(`provider 层全部通过（${providers.list.length} 个来源，${hosts.length} 个 host）`);
console.log(`hosts: ${hosts.join(" ")}`);
