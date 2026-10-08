// Translation provider registry.
//
// Translations used to be forwarded to /api/translate-text on a backend, which
// meant "support for translation services" was really "support for whatever
// that one Python file implements" — and no backend meant no translation at
// all. Providers are now called straight from the extension, so any of them
// works with no server involved; the backend remains available as one option
// among the list.
//
// Written as a classic script assigning to globalThis because the service
// worker is a classic script (importScripts). The request builders are pure so
// they can be unit-tested under Node — see deploy/check-providers.mjs.

(function (root) {
  "use strict";

  const TARGET_DEFAULT = "简体中文";

  // Shared chat prompt. LLMs are asked for a JSON array because line-splitting
  // a numbered list turned out to be the fragile part of the old backend path.
  function chatPrompt(texts, target) {
    return [
      "你是漫画翻译引擎。把下面 JSON 数组里的每一条日文翻译成" + target + "。",
      "规则：",
      "1. 只输出一个 JSON 字符串数组，不要解释、不要代码块标记。",
      "2. 数组长度必须与输入完全相同，顺序一一对应。",
      "3. 逐条独立翻译，不要合并、拆分或省略任何一条。",
      "4. 保留原有的语气词、标点和停顿感；拟声词给出对应的中文拟声词。",
      "5. 如果某条只是符号或无法识别，原样返回。",
      "",
      "输入：",
      JSON.stringify(texts),
    ].join("\n");
  }

  /** Pull an array of `count` strings out of whatever the model replied. */
  function parseChatContent(content, count) {
    if (typeof content !== "string") throw new Error("翻译服务返回了空内容");
    let text = content.trim();
    // Models like to wrap JSON in a fenced block even when told not to.
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) text = fenced[1].trim();

    const tryParse = (candidate) => {
      try {
        const parsed = JSON.parse(candidate);
        if (Array.isArray(parsed)) return parsed.map((item) => String(item));
        if (parsed && Array.isArray(parsed.translations)) return parsed.translations.map((item) => String(item));
      } catch {
        return null;
      }
      return null;
    };

    let result = tryParse(text);
    if (!result) {
      // Fall back to the outermost [...] block, which tolerates a stray
      // sentence before or after the array.
      const start = text.indexOf("[");
      const end = text.lastIndexOf("]");
      if (start !== -1 && end > start) result = tryParse(text.slice(start, end + 1));
    }
    if (!result) {
      // Last resort: one translation per non-empty line, with list markers off.
      result = text
        .split("\n")
        .map((line) => line.replace(/^\s*(?:[-*]|\d+[.、)])\s*/, "").trim())
        .filter(Boolean);
    }
    if (result.length !== count) {
      throw new Error(`翻译条数不匹配（期望 ${count} 条，收到 ${result.length} 条）`);
    }
    return result;
  }

  function joinResults(items, count) {
    if (!Array.isArray(items) || items.length !== count) {
      throw new Error(`翻译条数不匹配（期望 ${count} 条，收到 ${Array.isArray(items) ? items.length : 0} 条）`);
    }
    return items.map((item) => String(item ?? ""));
  }

  // --- adapters -------------------------------------------------------------

  /** OpenAI /v1/chat/completions shape, which most vendors now imitate. */
  function openAiCompatible(request) {
    const { endpoint, apiKey, model, texts, target } = request;
    const headers = { "Content-Type": "application/json" };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    return {
      url: endpoint,
      init: {
        method: "POST",
        headers,
        body: JSON.stringify({
          model,
          temperature: 0,
          messages: [{ role: "user", content: chatPrompt(texts, target) }],
        }),
      },
    };
  }
  const parseOpenAiCompatible = (json, count) => {
    const content = json?.choices?.[0]?.message?.content;
    if (content === undefined) {
      const detail = json?.error?.message || json?.message || "响应中没有 choices[0].message.content";
      throw new Error(detail);
    }
    return parseChatContent(content, count);
  };

  function gemini(request) {
    const { endpoint, apiKey, model, texts, target } = request;
    return {
      url: `${endpoint}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: chatPrompt(texts, target) }] }],
          generationConfig: { temperature: 0 },
        }),
      },
    };
  }
  const parseGemini = (json, count) => {
    if (json?.error) throw new Error(json.error.message || "Gemini 返回错误");
    const parts = json?.candidates?.[0]?.content?.parts || [];
    const content = parts.map((part) => part.text || "").join("");
    return parseChatContent(content, count);
  };

  function claude(request) {
    const { endpoint, apiKey, model, texts, target } = request;
    return {
      url: `${endpoint}/v1/messages`,
      init: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          // Without this the API refuses requests that originate in a browser.
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({
          model,
          max_tokens: 2048,
          temperature: 0,
          messages: [{ role: "user", content: chatPrompt(texts, target) }],
        }),
      },
    };
  }
  const parseClaude = (json, count) => {
    if (json?.error) throw new Error(json.error.message || "Claude 返回错误");
    const content = (json?.content || []).map((block) => block.text || "").join("");
    return parseChatContent(content, count);
  };

  // Google's public web endpoint: no key, no quota dashboard, and it accepts
  // one query per request, so the caller issues one call per text.
  function googleFree(request) {
    const { text, source, target } = request;
    const params = new URLSearchParams({ client: "gtx", sl: source, tl: target, dt: "t", q: text });
    return {
      url: `https://translate.googleapis.com/translate_a/single?${params.toString()}`,
      init: { method: "GET" },
    };
  }
  const parseGoogleFree = (json) => {
    const segments = json?.[0];
    if (!Array.isArray(segments)) throw new Error("Google 翻译返回了意外的格式");
    return [segments.map((segment) => (Array.isArray(segment) ? segment[0] || "" : "")).join("")];
  };

  function deepL(request) {
    const { endpoint, apiKey, texts, source, target } = request;
    return {
      url: `${endpoint}/v2/translate`,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `DeepL-Auth-Key ${apiKey}` },
        body: JSON.stringify({ text: texts, source_lang: source.toUpperCase(), target_lang: target }),
      },
    };
  }
  const parseDeepL = (json, count) => {
    if (json?.message) throw new Error(json.message);
    return joinResults((json?.translations || []).map((item) => item.text), count);
  };

  // --- hashing helpers for the signed Chinese APIs --------------------------

  /** MD5, needed because Baidu signs with it and SubtleCrypto has no MD5. */
  function md5(input) {
    const bytes = new TextEncoder().encode(input);
    const s = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
      5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
      4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
      6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
    const k = new Uint32Array(64);
    for (let i = 0; i < 64; i += 1) k[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);

    const length = bytes.length;
    const withPadding = new Uint8Array((((length + 8) >> 6) + 1) * 64);
    withPadding.set(bytes);
    withPadding[length] = 0x80;
    const view = new DataView(withPadding.buffer);
    view.setUint32(withPadding.length - 8, length * 8, true);

    let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    for (let chunk = 0; chunk < withPadding.length; chunk += 64) {
      const m = new Uint32Array(16);
      for (let i = 0; i < 16; i += 1) m[i] = view.getUint32(chunk + i * 4, true);
      let a = a0, b = b0, c = c0, d = d0;
      for (let i = 0; i < 64; i += 1) {
        let f, g;
        if (i < 16) { f = (b & c) | (~b & d); g = i; }
        else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
        else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
        else { f = c ^ (b | ~d); g = (7 * i) % 16; }
        const rotated = (a + f + k[i] + m[g]) >>> 0;
        const shift = s[i];
        const next = ((rotated << shift) | (rotated >>> (32 - shift))) >>> 0;
        a = d; d = c; c = b; b = (b + next) >>> 0;
      }
      a0 = (a0 + a) >>> 0; b0 = (b0 + b) >>> 0; c0 = (c0 + c) >>> 0; d0 = (d0 + d) >>> 0;
    }
    const out = new Uint8Array(16);
    const outView = new DataView(out.buffer);
    outView.setUint32(0, a0, true);
    outView.setUint32(4, b0, true);
    outView.setUint32(8, c0, true);
    outView.setUint32(12, d0, true);
    return [...out].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  async function sha256Hex(input) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  function baidu(request) {
    const { endpoint, appId, apiKey, texts, source, target, salt } = request;
    const query = texts.join("\n");
    const sign = md5(`${appId}${query}${salt}${apiKey}`);
    const body = new URLSearchParams({
      q: query,
      from: source,
      to: target,
      appid: appId,
      salt: String(salt),
      sign,
    });
    return {
      url: endpoint,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      },
    };
  }
  const parseBaidu = (json, count) => {
    if (json?.error_code) throw new Error(`${json.error_code}: ${json.error_msg || "百度翻译返回错误"}`);
    return joinResults((json?.trans_result || []).map((item) => item.dst), count);
  };

  async function youdao(request) {
    const { endpoint, appId, apiKey, texts, source, target } = request;
    const query = texts.join("\n");
    const salt = String(request.salt);
    const curtime = String(Math.floor(Date.now() / 1000));
    const truncated = query.length <= 20 ? query : `${query.slice(0, 10)}${query.length}${query.slice(-10)}`;
    const sign = await sha256Hex(`${appId}${truncated}${salt}${curtime}${apiKey}`);
    const body = new URLSearchParams({
      q: query,
      from: source,
      to: target,
      appKey: appId,
      salt,
      sign,
      signType: "v3",
      curtime,
    });
    return {
      url: endpoint,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      },
    };
  }
  const parseYoudao = (json, count) => {
    if (json?.errorCode && json.errorCode !== "0") throw new Error(`${json.errorCode}: 有道翻译返回错误`);
    return joinResults(json?.translation || [], count);
  };

  /**
   * The project's own backend, doing the translating itself.
   *
   * The body used to say mode "openai-compatible" with an empty endpoint, model
   * and key, and options.js pinned that mode for this provider. The backend then
   * called translate_openai_compatible with three empty strings and answered 503
   * "请配置 OpenAI-compatible 接口地址和模型" — for every request, always. The
   * provider could not translate anything, and there was no field anywhere in the
   * extension that could have filled those values in.
   *
   * "free-translate" is what this provider actually means: let the backend use
   * whatever translator it is configured with. A deployment that has that turned
   * off answers with a clear 400 instead of a 503 about missing settings the user
   * was never asked for.
   */
  function backend(request) {
    const { endpoint, texts, target } = request;
    return {
      url: `${endpoint}/api/translate-text`,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          texts,
          mode: "free-translate",
          target_language: target,
        }),
      },
    };
  }
  const parseBackend = (json, count) => {
    if (!json?.ok) throw new Error(json?.detail || json?.error || "后端翻译失败");
    return joinResults((json.items || []).map((item) => item.translated), count);
  };

  // --- the registry ---------------------------------------------------------

  // `perRequest: true` means the adapter takes one text per call.
  const PROVIDERS = [
    {
      id: "none",
      label: "关闭翻译（默认）",
      group: "其它",
      adapter: null,
      parse: null,
      target: "zh-CN",
      note: "只识别文字，不发送任何翻译请求。识别到的日文会直接显示出来。",
    },
    {
      id: "google-free",
      label: "Google 翻译（免费，无需密钥）",
      group: "翻译 API",
      adapter: googleFree,
      parse: parseGoogleFree,
      perRequest: true,
      source: "ja",
      target: "zh-CN",
      host: "https://translate.googleapis.com/*",
      note: "Google 的公开翻译端点，不需要密钥。但它并非正式 API：会限流，在部分网络下会被反爬拦截，实测中经常返回 429。国内网络通常需要代理才能访问。仅建议作为快速试用；正式使用请选择百炼、DeepSeek、百度等。",
    },
    {
      id: "deepL",
      label: "DeepL",
      group: "翻译 API",
      adapter: deepL,
      parse: parseDeepL,
      endpoint: "https://api-free.deepl.com",
      endpointChoices: [
        { value: "https://api-free.deepl.com", label: "免费版（api-free）" },
        { value: "https://api.deepl.com", label: "付费版（api）" },
      ],
      keyRequired: true,
      keyLabel: "DeepL API Key",
      source: "JA",
      target: "ZH",
      host: "https://api-free.deepl.com/*",
      extraHosts: ["https://api.deepl.com/*"],
      keyUrl: "https://www.deepl.com/pro-api",
    },
    {
      id: "baidu",
      label: "百度翻译开放平台",
      group: "翻译 API",
      adapter: baidu,
      parse: parseBaidu,
      endpoint: "https://fanyi-api.baidu.com/api/trans/vip/translate",
      keyRequired: true,
      keyLabel: "密钥（开发者密钥）",
      appIdLabel: "APP ID",
      appIdRequired: true,
      source: "jp",
      target: "zh",
      host: "https://fanyi-api.baidu.com/*",
      keyUrl: "https://fanyi-api.baidu.com/",
      note: "选用「通用文本翻译」，标准版每月有免费额度。",
    },
    {
      id: "youdao",
      label: "有道智云翻译",
      group: "翻译 API",
      adapter: youdao,
      parse: parseYoudao,
      endpoint: "https://openapi.youdao.com/api",
      keyRequired: true,
      keyLabel: "应用密钥（应用秘钥）",
      appIdLabel: "应用 ID",
      appIdRequired: true,
      source: "ja",
      target: "zh-CHS",
      host: "https://openapi.youdao.com/*",
      keyUrl: "https://ai.youdao.com/",
    },
    {
      id: "openai",
      label: "OpenAI",
      group: "AI 大模型",
      adapter: openAiCompatible,
      parse: parseOpenAiCompatible,
      endpoint: "https://api.openai.com/v1/chat/completions",
      model: "gpt-4o-mini",
      keyRequired: true,
      host: "https://api.openai.com/*",
      keyUrl: "https://platform.openai.com/api-keys",
    },
    {
      id: "deepseek",
      label: "DeepSeek",
      group: "AI 大模型",
      adapter: openAiCompatible,
      parse: parseOpenAiCompatible,
      endpoint: "https://api.deepseek.com/v1/chat/completions",
      model: "deepseek-chat",
      keyRequired: true,
      host: "https://api.deepseek.com/*",
      keyUrl: "https://platform.deepseek.com/",
    },
    {
      id: "moonshot",
      label: "月之暗面 Kimi",
      group: "AI 大模型",
      adapter: openAiCompatible,
      parse: parseOpenAiCompatible,
      endpoint: "https://api.moonshot.cn/v1/chat/completions",
      model: "moonshot-v1-8k",
      keyRequired: true,
      host: "https://api.moonshot.cn/*",
      keyUrl: "https://platform.moonshot.cn/",
    },
    {
      id: "zhipu",
      label: "智谱 GLM",
      group: "AI 大模型",
      adapter: openAiCompatible,
      parse: parseOpenAiCompatible,
      endpoint: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
      model: "glm-4-flash",
      keyRequired: true,
      host: "https://open.bigmodel.cn/*",
      keyUrl: "https://open.bigmodel.cn/",
    },
    {
      id: "dashscope",
      label: "阿里云通义千问",
      group: "AI 大模型",
      adapter: openAiCompatible,
      parse: parseOpenAiCompatible,
      endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
      model: "qwen-plus",
      keyRequired: true,
      host: "https://dashscope.aliyuncs.com/*",
      keyUrl: "https://bailian.console.aliyun.com/",
    },
    {
      id: "siliconflow",
      label: "硅基流动 SiliconFlow",
      group: "AI 大模型",
      adapter: openAiCompatible,
      parse: parseOpenAiCompatible,
      endpoint: "https://api.siliconflow.cn/v1/chat/completions",
      model: "Qwen/Qwen2.5-7B-Instruct",
      keyRequired: true,
      host: "https://api.siliconflow.cn/*",
      keyUrl: "https://cloud.siliconflow.cn/",
    },
    {
      id: "groq",
      label: "Groq",
      group: "AI 大模型",
      adapter: openAiCompatible,
      parse: parseOpenAiCompatible,
      endpoint: "https://api.groq.com/openai/v1/chat/completions",
      model: "llama-3.3-70b-versatile",
      keyRequired: true,
      host: "https://api.groq.com/*",
      keyUrl: "https://console.groq.com/keys",
    },
    {
      id: "openrouter",
      label: "OpenRouter",
      group: "AI 大模型",
      adapter: openAiCompatible,
      parse: parseOpenAiCompatible,
      endpoint: "https://openrouter.ai/api/v1/chat/completions",
      model: "google/gemini-2.0-flash-001",
      keyRequired: true,
      host: "https://openrouter.ai/*",
      keyUrl: "https://openrouter.ai/keys",
    },
    {
      id: "gemini",
      label: "Google Gemini",
      group: "AI 大模型",
      adapter: gemini,
      parse: parseGemini,
      endpoint: "https://generativelanguage.googleapis.com/v1beta",
      model: "gemini-2.0-flash",
      keyRequired: true,
      host: "https://generativelanguage.googleapis.com/*",
      keyUrl: "https://aistudio.google.com/app/apikey",
      note: "有免费额度，适合个人使用。",
    },
    {
      id: "claude",
      label: "Anthropic Claude",
      group: "AI 大模型",
      adapter: claude,
      parse: parseClaude,
      endpoint: "https://api.anthropic.com",
      model: "claude-3-5-haiku-latest",
      keyRequired: true,
      host: "https://api.anthropic.com/*",
      keyUrl: "https://console.anthropic.com/settings/keys",
    },
    {
      id: "ollama",
      label: "本机 Ollama（无需密钥）",
      group: "AI 大模型",
      adapter: openAiCompatible,
      parse: parseOpenAiCompatible,
      endpoint: "http://127.0.0.1:11434/v1/chat/completions",
      model: "qwen2.5:7b",
      host: "http://127.0.0.1:11434/*",
      note: "需要本机已运行 Ollama，且模型已拉取。",
    },
    {
      id: "custom",
      label: "自定义 OpenAI 兼容接口",
      group: "AI 大模型",
      adapter: openAiCompatible,
      parse: parseOpenAiCompatible,
      endpoint: "",
      model: "",
      endpointEditable: true,
      keyRequired: false,
      host: null,
      note: "任何兼容 /chat/completions 的服务都可以，例如自建网关或中转服务。保存时会请求该域名的访问权限。",
    },
    {
      id: "backend",
      label: "自建后端（backend/）",
      group: "其它",
      adapter: backend,
      parse: parseBackend,
      endpoint: "http://127.0.0.1:8001",
      endpointEditable: true,
      target: "zh-CN",
      host: "http://127.0.0.1:8001/*",
      extraHosts: ["http://localhost:8001/*"],
      note: "把翻译交给本机或自托管的 Python 后端，需要先启动 backend/。",
    },
  ];

  const byId = (id) => PROVIDERS.find((provider) => provider.id === id) || null;

  // Chat-based providers are told the target language in words ("简体中文"),
  // while the dedicated translation APIs take a language *code* ("zh-CN", "ZH",
  // "zh-CHS"). Filling this in here keeps every entry from repeating it.
  for (const provider of PROVIDERS) {
    const chatBased = provider.adapter === openAiCompatible ||
      provider.adapter === gemini ||
      provider.adapter === claude;
    if (chatBased) {
      provider.target = provider.target || "简体中文";
      provider.targetKind = "name";
    } else {
      provider.targetKind = "code";
    }
  }

  root.MAS_providers = {
    list: PROVIDERS,
    byId,
    chatPrompt,
    parseChatContent,
    md5,
    sha256Hex,
    defaultTarget: TARGET_DEFAULT,
    /** Every host the fixed providers talk to, for the manifest. */
    hosts() {
      const out = [];
      for (const provider of PROVIDERS) {
        if (provider.host) out.push(provider.host);
        for (const extra of provider.extraHosts || []) out.push(extra);
      }
      return [...new Set(out)];
    },
  };
})(typeof globalThis !== "undefined" ? globalThis : self);
