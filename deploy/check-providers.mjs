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
check("openai 用配置的模型", JSON.parse(openaiReq.init.body).model === "gpt-4o-mini");
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

// --- response parsing -------------------------------------------------------
section("响应解析");
const count = 2;
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
  ["backend", "backend", { ok: true, items: [{ text: "a", translated: "甲" }, { text: "b", translated: "乙" }] }],
];
for (const [name, id, fixture] of cases) {
  const provider = providers.byId(id);
  let parsed = null;
  let error = null;
  try {
    parsed = provider.parse(fixture, id === "google-free" ? 1 : count);
  } catch (caught) {
    error = caught;
  }
  const expected = id === "google-free" ? ["甲乙"] : ["甲", "乙"];
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
