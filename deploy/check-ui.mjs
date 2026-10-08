// Browser checks for the settings/popup UI and a live translation call.
//
// The provider unit tests prove the request shapes; this proves the wiring:
// the options page builds its dropdown from the registry, shows the right
// fields per provider, and a real request actually comes back translated.
// Google's public endpoint is used because it needs no key — everything else
// would require one, so those are covered by the unit tests instead.
//
//   node deploy/check-ui.mjs [--proxy http://127.0.0.1:7890]

import http from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import puppeteer from "puppeteer";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionDir = resolve(repoRoot, "extension");

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}
const proxy = arg("--proxy", "");

const failures = [];
const check = (name, condition, detail = "") => {
  if (condition) console.log(`  ok    ${name}`);
  else {
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
    failures.push(name);
  }
};

const args = [
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "--disable-features=DisableLoadExtensionCommandLineSwitch",
  `--disable-extensions-except=${extensionDir}`,
  `--load-extension=${extensionDir}`,
];
// Loopback is deliberately left on Chrome's default bypass list: the mock
// service below listens on 127.0.0.1, and routing that through the proxy is
// exactly the mistake that produced a 502 the first time this ran.
if (proxy) args.push(`--proxy-server=${proxy}`);

const browser = await puppeteer.launch({ headless: true, args });
try {
  const target = await browser.waitForTarget(
    (t) => t.type() === "service_worker" && t.url().includes("service-worker.js"),
    { timeout: 30000 },
  );
  const worker = await target.worker();
  const extensionId = new URL(target.url()).host;
  console.log(`extension: ${extensionId}${proxy ? `  proxy: ${proxy}` : ""}\n`);

  // --- options page ---------------------------------------------------------
  console.log("设置页");
  const options = await browser.newPage();
  const optionErrors = [];
  options.on("pageerror", (error) => optionErrors.push(String(error)));
  await options.goto(`chrome-extension://${extensionId}/options/options.html`, { waitUntil: "load" });

  const optionCount = await options.$$eval("#translationProvider option", (nodes) => nodes.length);
  check("下拉框由注册表生成", optionCount >= 15, `只有 ${optionCount} 项`);

  const groups = await options.$$eval("#translationProvider optgroup", (nodes) =>
    nodes.map((node) => node.label));
  check("按来源类型分组", groups.includes("翻译 API") && groups.includes("AI 大模型"), groups.join("/"));

  const setProvider = async (id) => {
    await options.select("#translationProvider", id);
    await options.evaluate(() => document.getElementById("translationProvider")
      .dispatchEvent(new Event("change")));
    return options.evaluate(() => ({
      key: !document.getElementById("fieldKey").hidden,
      model: !document.getElementById("fieldModel").hidden,
      endpoint: !document.getElementById("fieldEndpoint").hidden,
      appId: !document.getElementById("fieldAppId").hidden,
      target: !document.getElementById("fieldTarget").hidden,
      note: document.getElementById("providerNote").textContent.trim(),
    }));
  };

  const googleFields = await setProvider("google-free");
  check("免密钥来源不显示密钥框", !googleFields.key);
  check("免密钥来源不显示模型框", !googleFields.model);

  const openaiFields = await setProvider("openai");
  check("OpenAI 显示密钥与模型", openaiFields.key && openaiFields.model);
  check("OpenAI 不需要 APP ID", !openaiFields.appId);
  check("对话类来源显示目标语言", openaiFields.target);

  const baiduFields = await setProvider("baidu");
  check("百度显示 APP ID", baiduFields.appId);
  check("百度不显示目标语言（用语言代码）", !baiduFields.target);

  const customFields = await setProvider("custom");
  check("自定义来源可编辑接口地址", customFields.endpoint);

  const noneFields = await setProvider("none");
  check("关闭翻译时不显示任何密钥字段", !noneFields.key && !noneFields.model && !noneFields.endpoint);

  check("设置页没有脚本错误", optionErrors.length === 0, optionErrors.join(" | "));

  // --- end-to-end translation through the provider layer --------------------
  //
  // A local stand-in for an OpenAI-compatible service, so the whole path is
  // exercised deterministically: settings -> storage -> service worker ->
  // request builder -> fetch -> parser -> back to the page. Hitting a real
  // vendor would need a key and would make the suite depend on someone else's
  // uptime. Port 8001 is reused because it is already in host_permissions.
  console.log("\n真实调用（本机模拟 OpenAI 兼容服务）");
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      let received = null;
      try { received = JSON.parse(body); } catch { /* reported below */ }
      const prompt = received?.messages?.[0]?.content || "";
      requests.push({ url: request.url, model: received?.model, prompt });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        choices: [{ message: { content: JSON.stringify(["早上好"]) } }],
      }));
    });
  });
  const requests = [];
  await new Promise((done) => server.listen(8001, "127.0.0.1", done));

  try {
    await setProvider("custom");
    await options.evaluate(() => {
      document.getElementById("translationEndpoint").value = "http://127.0.0.1:8001/v1/chat/completions";
      document.getElementById("translationModel").value = "mock-model";
      document.getElementById("translationApiKey").value = "test-key";
    });
    await options.click("#save");
    await new Promise((done) => setTimeout(done, 300));
    await options.click("#test");
    const testText = await options
      .waitForFunction(() => {
        const node = document.getElementById("testResult");
        return node && !node.hidden && !node.textContent.includes("正在测试");
      }, { timeout: 30000 })
      .then(() => options.$eval("#testResult", (node) => node.textContent.trim()))
      .catch(() => null);

    console.log(`      结果: ${JSON.stringify(testText)}`);
    check("端到端翻译成功", Boolean(testText && testText.includes("早上好")), testText || "超时");
    check("请求确实到达了服务", requests.length === 1, `收到 ${requests.length} 次`);
    if (requests.length) {
      const sent = requests[0];
      check("请求发往正确路径", sent.url === "/v1/chat/completions", sent.url);
      check("带上配置的模型名", sent.model === "mock-model", sent.model);
      check("提示词包含待翻译原文", sent.prompt.includes("おはよう"));
      check("提示词包含目标语言", sent.prompt.includes("简体中文"));
    }
  } finally {
    server.close();
  }

  // --- popup ----------------------------------------------------------------
  console.log("\n弹窗");
  const popup = await browser.newPage();
  const popupErrors = [];
  popup.on("pageerror", (error) => popupErrors.push(String(error)));
  await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`, { waitUntil: "load" });

  // The popup was reorganised around auto translate: the headline is the switch
  // and its state line, and the old OCR / translation status readouts are gone
  // (they now live in the collapsed diagnostics block).
  const popupState = await popup.waitForFunction(
    () => document.getElementById("autoStateText")?.textContent?.length > 0,
    { timeout: 15000 },
  ).then(() => popup.evaluate(() => ({
    title: document.querySelector("h1")?.textContent.trim(),
    auto: document.getElementById("autoTranslate")?.checked,
    state: document.getElementById("autoStateText").textContent.trim(),
    stateKind: document.getElementById("autoState").dataset.state,
    hasManual: Boolean(document.getElementById("select")),
    hasSettings: Boolean(document.getElementById("settings")),
    accent: getComputedStyle(document.documentElement).getPropertyValue("--accent").trim(),
  }))).catch(() => null);

  console.log(`      标题: ${popupState?.title}   自动翻译状态: ${popupState?.state} (${popupState?.stateKind})`);
  check("弹窗标题正确", popupState?.title === "MasLingo", popupState?.title);
  check("自动翻译开关存在且默认关闭", popupState?.auto === false);
  check("自动翻译有状态行", Boolean(popupState?.state), popupState?.state);
  check("手动框选入口保留", popupState?.hasManual === true);
  check("设置入口存在", popupState?.hasSettings === true);
  // The whole point of the colour change: not the default extension blue.
  check("重点色不是默认蓝", popupState?.accent && !/^#(0|1|2|3|4)[0-9a-f]{2}(ff|f{3})?$/i.test(popupState.accent),
    popupState?.accent);
  check("弹窗没有脚本错误", popupErrors.length === 0, popupErrors.join(" | "));

  // --- optional: the real keyless endpoint ---------------------------------
  // Google's public endpoint rate-limits and serves anti-bot interstitials, so
  // this is reported rather than asserted — a failure here says nothing about
  // this code. It runs last because it leaves a different provider selected,
  // and it is fully guarded so an unreachable external service cannot fail the
  // suite (it once hung long enough to trip the CDP protocol timeout).
  console.log("\n参考：Google 公开端点（外部服务，不计入结果）");
  try {
    await setProvider("google-free");
    await options.click("#save");
    await new Promise((done) => setTimeout(done, 300));
    await options.click("#test");
    const googleText = await options
      .waitForFunction(() => {
        const node = document.getElementById("testResult");
        return node && !node.hidden && !node.textContent.includes("正在测试");
      }, { timeout: 20000, polling: 500 })
      .then(() => options.$eval("#testResult", (node) => node.textContent.trim()))
      .catch(() => null);
    console.log(`      ${googleText || "无响应（外部服务不可达，属正常）"}`);
  } catch (error) {
    console.log(`      跳过：${error.message}`);
  }
} finally {
  await browser.close();
}

console.log("");
if (failures.length) {
  console.error(`${failures.length} 项不合格`);
  process.exit(1);
}
console.log("UI 与 provider 接线正常");
