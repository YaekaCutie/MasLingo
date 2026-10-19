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

  // Languages the paragraph translator offers in its menus. `zh` is what a chat
  // prompt calls the language; `google` is the generic tag; bing / mymemory /
  // deepl / baidu / youdao spell it their own way, so the mapping lives here
  // rather than in the content script — one place decides what a language name
  // means for whichever provider is selected.
  const AUTO_SOURCE = "自动识别";
  const LANGUAGES = [
    { name: "简体中文", zh: "中文", google: "zh-CN", bing: "zh-Hans", mymemory: "zh-CN", deepl: "ZH", baidu: "zh", youdao: "zh-CHS" },
    { name: "繁體中文", zh: "繁体中文", google: "zh-TW", bing: "zh-Hant", mymemory: "zh-TW", deepl: "ZH-HANT", baidu: "cht", youdao: "zh-CHT" },
    { name: "English", zh: "英文", google: "en", bing: "en", mymemory: "en", deepl: "EN", baidu: "en", youdao: "en" },
    { name: "日本語", zh: "日文", google: "ja", bing: "ja", mymemory: "ja", deepl: "JA", baidu: "jp", youdao: "ja" },
    { name: "한국어（朝鲜语）", zh: "韩文（朝鲜语）", google: "ko", bing: "ko", mymemory: "ko", deepl: "KO", baidu: "kor", youdao: "ko" },
    { name: "Русский（俄语）", zh: "俄文", google: "ru", bing: "ru", mymemory: "ru", deepl: "RU", baidu: "ru", youdao: "ru" },
    { name: "Español（西班牙语）", zh: "西班牙文", google: "es", bing: "es", mymemory: "es", deepl: "ES", baidu: "spa", youdao: "es" },
    { name: "हिन्दी（印地语）", zh: "印地文", google: "hi", bing: "hi", mymemory: "hi", deepl: "HI", baidu: "hi", youdao: "hi" },
    { name: "العربية（阿拉伯语）", zh: "阿拉伯文", google: "ar", bing: "ar", mymemory: "ar", deepl: "AR", baidu: "ara", youdao: "ar" },
    { name: "Français（法语）", zh: "法文", google: "fr", bing: "fr", mymemory: "fr", deepl: "FR", baidu: "fra", youdao: "fr" },
    { name: "Deutsch（德语）", zh: "德文", google: "de", bing: "de", mymemory: "de", deepl: "DE", baidu: "de", youdao: "de" },
    { name: "Português（葡萄牙语）", zh: "葡萄牙文", google: "pt", bing: "pt", mymemory: "pt", deepl: "PT", baidu: "pt", youdao: "pt" },
    { name: "Italiano（意大利语）", zh: "意大利文", google: "it", bing: "it", mymemory: "it", deepl: "IT", baidu: "it", youdao: "it" },
    { name: "ไทย（泰语）", zh: "泰文", google: "th", bing: "th", mymemory: "th", deepl: "TH", baidu: "th", youdao: "th" },
    { name: "Tiếng Việt（越南语）", zh: "越南文", google: "vi", bing: "vi", mymemory: "vi", deepl: "VI", baidu: "vie", youdao: "vi" },
    { name: "Bahasa Indonesia（印尼语）", zh: "印尼文", google: "id", bing: "id", mymemory: "id", deepl: "ID", baidu: "id", youdao: "id" },
    { name: "Türkçe（土耳其语）", zh: "土耳其文", google: "tr", bing: "tr", mymemory: "tr", deepl: "TR", baidu: "tr", youdao: "tr" },
  ];

  // Domain term bases. Selecting one appends a compact style-and-terms rule to
  // the chat prompt; dedicated translation APIs cannot accept it, so the UI
  // only offers this for chat models. The list is deliberately small: one
  // screen of choices is more useful than a taxonomy nobody reads.
  const GLOSSARIES = [
    { id: "general", label: "通用", hint: "不限定专业领域", rule: "" },
    {
      id: "medical",
      label: "医学",
      hint: "临床、药品、解剖",
      rule: "医学术语使用规范临床译名，例如 myocardial infarction→心肌梗死、hypertension→高血压、contraindication→禁忌证、adverse reaction→不良反应；同一术语全篇一致。",
    },
    {
      id: "legal",
      label: "法律",
      hint: "合同、法条、诉讼",
      rule: "法律术语按中国大陆法律文本惯用译名，例如 force majeure→不可抗力、jurisdiction→管辖权、burden of proof→举证责任、liquidated damages→违约金；保持条文语气严谨。",
    },
    {
      id: "technology",
      label: "计算机",
      hint: "软件、网络、AI",
      rule: "技术术语使用开发者通行译名；API、SDK 等缩写保留，token 按语境译为令牌/词元、prompt 译为提示词；同一术语全篇一致。",
    },
    {
      id: "finance",
      label: "金融",
      hint: "投资、银行、财报",
      rule: "金融术语使用规范译名，例如 liquidity→流动性、derivative→衍生品、principal→本金、yield→收益率；金额、比率与日期保持准确。",
    },
    {
      id: "gaming",
      label: "游戏",
      hint: "机制、UI、技能",
      rule: "游戏术语使用玩家社区通行译名；技能名、职业名、装备名保持统一，UI 动词简短直接。",
    },
    {
      id: "anime",
      label: "动漫",
      hint: "角色、技能、拟声词",
      rule: "动漫语境优先采用官方或通行译名；角色称呼、技能名、组织名全篇统一；保留语气词和拟声词的表现力。",
    },
    {
      id: "military",
      label: "军事",
      hint: "战术、装备、编制",
      rule: "军事术语使用规范译名，例如 infantry→步兵、artillery→炮兵、flanking→侧翼包抄；装备型号保留原文编号。",
    },
    {
      id: "academic",
      label: "学术",
      hint: "论文、教材、研究",
      rule: "学术文本使用严谨书面语；专业术语采用该学科通行译名，首次出现可保留原文缩写。",
    },
    {
      id: "business",
      label: "商务",
      hint: "邮件、合同、财务",
      rule: "商务文本语气正式简洁；职位、部门、合同条款使用企业惯用译名，数字与日期保持准确。",
    },
    {
      id: "automotive",
      label: "汽车",
      hint: "车辆、维修、驾驶",
      rule: "汽车术语使用行业通行译名，例如 suspension→悬架、torque→扭矩、powertrain→动力总成；车型与零件编号保留原文。",
    },
  ];

  const glossaryById = (id) =>
    GLOSSARIES.find((glossary) => glossary.id === id) || GLOSSARIES[0];

  /** The prompt line for a glossary; 通用 adds nothing. */
  function glossaryPrompt(id) {
    const glossary = glossaryById(id);
    if (!glossary || glossary.id === "general" || !glossary.rule) return "";
    return `术语库（${glossary.label}）：${glossary.rule} 这些示例以中文为目标语言；若目标语言不是中文，请改用该语言中对应的规范术语。专业术语优先于一般译法，同一术语在整批译文中必须保持一致。`;
  }

  // Shared chat prompt. LLMs are asked for a JSON array because line-splitting
  // a numbered list turned out to be the fragile part of the old backend path.
  //
  // `strength` (Low / High / Max, see STRENGTHS) appends one extra rule line.
  // Every tier carries the same proper-noun consistency rule: the same name
  // must read the same way across the whole batch, which is what "前后文专有
  // 名词一致" asks for. The tiers differ in how hard the model is told to work
  // (light polish without web lookup → web-assisted polish → web-assisted
  // perfection pass).
  function chatPrompt(texts, target, strength = 0, source = "日文", glossary = "general") {
    const sourcePhrase = source === AUTO_SOURCE || source === "auto"
      ? "下面 JSON 数组里的每一条文本（自动判断源语言）"
      : "下面 JSON 数组里的每一条" + source;
    const rules = [
      "你是翻译引擎。把" + sourcePhrase + "翻译成" + target + "。",
      "规则：",
      "1. 只输出一个 JSON 字符串数组，不要解释、不要代码块标记。",
      "2. 数组长度必须与输入完全相同，顺序一一对应。",
      "3. 逐条独立翻译，不要合并、拆分或省略任何一条。",
      "4. 保留原有的语气词、标点和停顿感；拟声词给出对应的中文拟声词。",
      "5. 如果某条只是符号或无法识别，原样返回。",
      "6. 人名、地名、技能名、组织名等专有名词必须在整批上下文中前后一致：同一个名词只使用同一个译名，不要在不同条目里换译法。",
    ];
    const extra = STRENGTHS[normalizeStrength(strength)].rule;
    if (extra) rules.push(extra);
    const terms = glossaryPrompt(glossary);
    if (terms) rules.push(terms);
    rules.push("", "输入：", JSON.stringify(texts));
    return rules.join("\n");
  }

  /**
   * The selection popup's dictionary request.
   *
   * One short word in, a structured entry out: every common sense, its part of
   * speech, an example with a translation, and which sense fits the sentence
   * the word was selected in. Asking for JSON keeps the popup renderable; the
   * contextSense index is what lets it highlight "本文义项".
   */
  function dictionaryPrompt(text, context, target, glossary = "general") {
    const lines = [
      "你是严谨的词典编纂助手。请按权威辞典（日语用《広辞苑》《新明解国語辞典》《大辞林》，中文用《现代汉语词典》《辞海》，英语用《牛津》《朗文》，韩语用《표준국어대사전》，俄语用《Ожегов》，西语用《RAE》，法语用《Le Robert》，德语用《Duden》，其他语言用该语言最权威的现代词典）整理下面这个词的义项。",
      "词：" + text,
      "上下文句子：" + (context || "（无）"),
      "规则：",
      "1. 只输出一个 JSON 对象，不要解释、不要代码块标记。",
      '2. 结构：{"word":"…","reading":"…","dictionary":"依据的辞典名","senses":[{"pos":"词性","meaning":"…","example":"…","exampleTranslation":"…"}],"contextSense":1}',
      "3. senses 要覆盖该词的常见义项（包括不同词性下的义项），按常用程度排序；不能只给一个最贴合上下文的解释。词性用标准名称（名词 / 动词 / 形容词 / 副词 / 助词 / 接续词等）。",
      "4. 同一个词的每种不同词性都要单独列出义项；如果同一个词性有多个含义，也分别列出。",
      "5. meaning、词性和 exampleTranslation 用" + target + "；example 用原词的语言。每个义项给一个简短、自然的例句。",
      "6. contextSense：根据上下文句子判断最贴合本文的义项序号（从 1 开始）；无法判断时为 0。必须结合上下文判断词性和含义，不能只按最常见义项填写。",
      "7. dictionary 填写释义所参照的权威辞典（如《広辞苑》《新明解国語辞典》《现代汉语词典》），不要声称逐字引用；不确定时留空。",
      "8. 不得编造生僻义项或例句；不确定的义项不要输出。",
    ];
    const terms = glossaryPrompt(glossary);
    if (terms) {
      lines.push("9. 判断本文义项时，如果上下文属于下面的专业领域，优先选择该领域的专业义项。" + terms);
    }
    return lines.join("\n");
  }

  /**
   * Pull the dictionary object out of whatever the model replied.
   *
   * Models wrap JSON in fences or prose often enough that a bare JSON.parse is
   * not worth the failure; the first `{...}` block is the entry.
   */
  function parseDictionary(content) {
    if (typeof content !== "string" || !content.trim()) throw new Error("AI 返回了空内容");
    let text = content.trim();
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) text = fenced[1].trim();
    // Take the first balanced object. `lastIndexOf("}")` also swallowed prose
    // after the entry, and a stray brace in that prose made JSON.parse fail on
    // an otherwise valid answer.
    const start = text.indexOf("{");
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let index = start; start >= 0 && index < text.length; index += 1) {
      const char = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          end = index;
          break;
        }
      }
    }
    if (start < 0 || end <= start) throw new Error("AI 没有返回词典 JSON");
    const json = text.slice(start, end + 1);
    let parsed;
    try {
      parsed = JSON.parse(json);
    } catch {
      // A trailing comma is the one malformed-JSON habit worth repairing here:
      // several chat gateways emit it even when asked for strict JSON.
      parsed = JSON.parse(json.replace(/,\s*([}\]])/g, "$1"));
    }
    const rawSenses = parsed?.senses || parsed?.definitions || parsed?.meanings;
    if (!parsed || !Array.isArray(rawSenses) || !rawSenses.length) {
      throw new Error("AI 没有返回可用义项");
    }
    const normalized = rawSenses
      .slice(0, 24)
      .map((sense, index) => ({
        index,
        pos: String(sense?.pos || sense?.partOfSpeech || sense?.type || "").trim().slice(0, 24),
        meaning: String(sense?.meaning || sense?.definition || sense?.gloss || "").trim().slice(0, 500),
        example: String(sense?.example || sense?.sentence || "").trim().slice(0, 300),
        exampleTranslation: String(
          sense?.exampleTranslation || sense?.example_translation ||
          sense?.exampleZh || sense?.example_zh || "",
        ).trim().slice(0, 300),
      }))
      .filter((sense) => sense.meaning);
    if (!normalized.length) throw new Error("AI 没有返回可用义项");
    const senses = normalized.map(({ index, ...sense }) => sense);

    // contextSense is 1-based. It was computed against the model's original
    // list, so map it through the entries that survived validation rather than
    // indexing the filtered array directly.
    const rawContext = parsed.contextSense ?? parsed.context_sense ??
      parsed.contextSenseIndex ?? parsed.context_sense_index ?? 0;
    const contextDigits = String(rawContext).match(/\d+/);
    const wanted = contextDigits ? Math.round(Number(contextDigits[0])) : 0;
    const matched = wanted > 0
      ? normalized.find((sense) => sense.index === wanted - 1)
      : null;
    const contextSense = matched ? normalized.indexOf(matched) + 1 : 0;

    return {
      word: String(parsed.word || "").trim(),
      reading: String(parsed.reading || parsed.pronunciation || parsed.pinyin || "").trim(),
      dictionary: String(parsed.dictionary || parsed.source || "").trim().slice(0, 120),
      senses,
      contextSense: contextSense > 0 && contextSense <= senses.length ? contextSense : 0,
    };
  }

  /**
   * Translation strength — how hard the chat model is asked to work.
   *
   * A word-level knob rather than a second model picker: every provider in the
   * AI group speaks the same prompt, so effort is the one lever that works for
   * all of them. There is no "off" tier any more: choosing an AI source means
   * translating, and the three levels are light polish without web lookup
   * (Low), web-assisted polish (High) and a web-assisted perfection pass (Max).
   * An old profile that stored 0 (the removed Off) normalises to Low.
   */
  const STRENGTHS = [
    {
      value: 0,
      label: "Low",
      hint: "不联网轻度润色",
      rule: "7. 强度 Low（不联网轻度润色）：先理解整句语境再翻译，润色得自然、口语化，不逐字硬译；不要联网检索，专有名词沿用通行译名，并在整批上下文中保持一致。",
      visionRule: "6. 强度 Low（不联网轻度润色）：不要联网检索；在已有知识范围内轻度润色，译文自然、口语化，不逐字硬译；专有名词用通行译名，并在整页内保持一致。",
    },
    {
      value: 1,
      label: "High",
      hint: "联网润色",
      rule: "7. 强度 High（联网润色）：结合前后文与角色语气润色用词；技能、人名、地名等专有名词尽量联网核对官方译名（不能联网时用通行译名，不确定的人名不要臆造）；专有名词在整批上下文中必须前后一致；输出前自查一遍是否通顺、准确。",
      visionRule: "6. 强度 High（联网润色）：可以联网核对技能、人名、地名等专有名词的官方译名（不能联网时用通行译名，不确定的人名不要臆造）；结合前后文与角色语气润色，全页译名必须一致。",
    },
    {
      value: 2,
      label: "Max",
      hint: "联网完美翻译",
      rule: "7. 强度 Max（联网完美翻译）：逐条反复推敲，结合前后文与漫画语境选择最自然准确的表达；技能、人名、地名等专有名词尽量联网逐一核对官方译名（不能联网时用通行译名，不确定的人名保留原文）；同一专有名词在全批上下文中必须使用同一译名；输出前逐条自查准确性、通顺度与长度，必要时意译。",
      visionRule: "6. 强度 Max（联网完美翻译）：可以联网逐一核对专有名词的官方译名（不能联网时用通行译名，不确定的保留原文）；结合整页语境反复推敲，选择最自然准确的表达，输出前逐条自查；全页译名必须一致。",
    },
  ];

  /** Clamp anything storage or a caller hands over onto a real level. */
  function normalizeStrength(value) {
    // "Not set" means Low now: the removed Off tier used to be the default,
    // and choosing an AI source always means translating.
    if (value === null || value === undefined || value === "") return 0;
    const level = Math.round(Number(value));
    if (!Number.isFinite(level)) return 0;
    return Math.min(STRENGTHS.length - 1, Math.max(0, level));
  }

  const strengthLabel = (value) => STRENGTHS[normalizeStrength(value)].label;
  const strengthHint = (value) => STRENGTHS[normalizeStrength(value)].hint;


  /**
   * A provider's model list, normalised to `{ id, label }`.
   *
   * Entries are usually bare ids; a vendor whose current api id no longer
   * matches its marketing name (DeepSeek's `deepseek-flash` IS the V4.1-Flash
   * model) adds a label so the picker can show the concrete model while the
   * request still carries the id the api expects.
   */
  function modelsOf(provider) {
    return (provider?.models || []).map((entry) =>
      typeof entry === "string"
        ? { id: entry, label: entry }
        : { id: entry.id, label: entry.label || entry.id });
  }

  /**
   * The model id a request should ask for.
   *
   * `translationModel` is one storage key shared by every provider, so a model
   * picked for one vendor used to be sent to the next one the moment the user
   * switched sources — DeepSeek's id posted to Gemini's endpoint, answered
   * with a 404 about a model that does not exist. The companion key
   * `translationModelProvider` records who the override was chosen for, and
   * the override only applies back to that provider. A profile that predates
   * the marker has no `translationModelProvider` and keeps the old behaviour:
   * the stored model applies wherever it is.
   */
  function resolveModel(provider, cfg = {}) {
    const stored = typeof cfg.translationModel === "string" ? cfg.translationModel.trim() : "";
    const owner = cfg.translationModelProvider;
    const legacyOwnerless = owner === undefined || owner === null || owner === "";
    if (stored && (legacyOwnerless || owner === provider?.id)) return stored;
    return provider?.model || "";
  }

  /**
   * The single text of a one-text-per-request adapter.
   *
   * Callers pass `texts` (a batch of one); the panel's connectivity probe used
   * to pass only that, and Bing read `request.text` straight into its form —
   * URLSearchParams stringifies `undefined`, so Bing was asked to translate the
   * literal word "undefined" and dutifully answered 未定义. Reading both fields
   * here makes that class of caller error unable to produce a bogus success.
   */
  function firstText(request) {
    return request.text ?? request.texts?.[0] ?? "";
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
    const { endpoint, apiKey, model, texts, target, strength, sourceName, prompt, glossary } = request;
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
          messages: [{
            role: "user",
            content: prompt || chatPrompt(texts, target, strength, sourceName, glossary),
          }],
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
    const { endpoint, apiKey, model, texts, target, strength, sourceName, prompt, glossary } = request;
    return {
      url: `${endpoint}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{
            parts: [{ text: prompt || chatPrompt(texts, target, strength, sourceName, glossary) }],
          }],
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
    const { endpoint, apiKey, model, texts, target, strength, sourceName, prompt, maxTokens, glossary } = request;
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
          max_tokens: maxTokens || 2048,
          temperature: 0,
          messages: [{
            role: "user",
            content: prompt || chatPrompt(texts, target, strength, sourceName, glossary),
          }],
        }),
      },
    };
  }
  const parseClaude = (json, count) => {
    if (json?.error) throw new Error(json.error.message || "Claude 返回错误");
    const content = (json?.content || []).map((block) => block.text || "").join("");
    return parseChatContent(content, count);
  };

  /**
   * The raw assistant text from a chat provider, without assuming an array.
   *
   * Ordinary translation wants `parseChatContent`; the dictionary path wants
   * the JSON object the prompt asked for, so it cannot go through a parser that
   * insists on a top-level array. OpenAI-compatible gateways occasionally send
   * `content` as an array of parts rather than one string, so both shapes are
   * accepted here.
   */
  function extractChatText(provider, json) {
    if (typeof provider?.extractText === "function") {
      const custom = provider.extractText(json);
      if (typeof custom === "string" && custom.trim()) return custom;
      throw new Error("AI 返回了空内容");
    }
    if (json?.error) throw new Error(json.error.message || "AI 服务返回错误");

    let content;
    if (provider?.adapter === gemini) {
      const parts = json?.candidates?.[0]?.content?.parts || [];
      content = parts.map((part) => part.text || "").join("");
    } else if (provider?.adapter === claude) {
      content = (json?.content || []).map((block) => block.text || "").join("");
    } else {
      content = json?.choices?.[0]?.message?.content;
      if (Array.isArray(content)) {
        content = content.map((part) => {
          if (typeof part === "string") return part;
          return part?.text || part?.content || "";
        }).join("");
      }
      if (content === undefined || content === null) {
        content = json?.output_text ?? json?.response;
      }
    }
    if (typeof content !== "string" || !content.trim()) {
      const detail = json?.error?.message || json?.message ||
        "响应中没有可读取的 AI 文本";
      throw new Error(detail);
    }
    return content;
  }

  /** Whether this provider speaks a chat prompt and can answer a dictionary query. */
  const isChatProvider = (provider) =>
    Boolean(provider && (provider.chat || typeof provider.extractText === "function"));

  // Google's public web endpoint: no key, no quota dashboard, and it accepts
  // one query per request, so the caller issues one call per text.
  function googleFree(request) {
    const { source, target } = request;
    const text = firstText(request);
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
    const body = { text: texts, target_lang: target };
    // Omitted source means "detect it": the paragraph translator's 自动识别.
    if (source) body.source_lang = source.toUpperCase();
    return {
      url: `${endpoint}/v2/translate`,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `DeepL-Auth-Key ${apiKey}` },
        body: JSON.stringify(body),
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

  // --- keyless web endpoints ------------------------------------------------
  //
  // No key, no account, and reachable from networks where the Google endpoint
  // is not (which is the whole point of having them). Both are unofficial web
  // interfaces — they can rate-limit or change shape — which is what their
  // notes warn about. Both were measured working from mainland China.

  /** Bing's session tokens, refreshed when they go stale. */
  let bingTokens = null;
  const BING_TOKEN_TTL_MS = 25 * 60 * 1000;

  /**
   * Bing's free web translator.
   *
   * The translator page hands out an IG plus a [key, token] pair that its own
   * script posts to /ttranslatev3; a plain fetch of the page is enough to
   * obtain them — no cookies are needed, measured — and they last about an
   * hour. Cached so a batch of texts does not re-download the page per line.
   */
  async function bingFree(request) {
    const { source, target } = request;
    const text = firstText(request);
    const tokens = await bingSession();
    const body = new URLSearchParams({
      fromLang: source, text, to: target, token: tokens.token, key: tokens.key,
    });
    return {
      url: `https://cn.bing.com/ttranslatev3?isVertical=1&&IG=${tokens.ig}&IID=translator.5023.1`,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      },
    };
  }

  async function bingSession() {
    const now = Date.now();
    if (bingTokens && now - bingTokens.fetchedAt < BING_TOKEN_TTL_MS) return bingTokens;
    const response = await fetch("https://cn.bing.com/translator", { credentials: "omit" });
    if (!response.ok) throw new Error(`必应翻译页面加载失败（${response.status}）`);
    const html = await response.text();
    const ig = (html.match(/IG:"([0-9A-F]+)"/) || [])[1];
    const helper = html.match(/params_AbusePreventionHelper\s*=\s*\[\s*(\d+)\s*,\s*"([^"]+)"/) || [];
    if (!ig || !helper[2]) throw new Error("必应翻译页面格式已变化，请改用其它翻译来源。");
    bingTokens = { ig, key: helper[1], token: helper[2], fetchedAt: now };
    return bingTokens;
  }

  const parseBing = (json, count) => {
    const text = Array.isArray(json) ? json[0]?.translations?.[0]?.text : undefined;
    if (text === undefined) {
      // 401/429 come back as an object; drop the cache so the next attempt
      // fetches a fresh pair instead of reusing a rejected one.
      bingTokens = null;
      const detail = json?.statusCode || json?.message || "必应翻译返回了意外的格式";
      throw new Error(String(detail).slice(0, 80));
    }
    return [String(text)];
  };

  /**
   * MyMemory, the free translation-memory service.
   *
   * Keyless with a per-day anonymous quota — the note says so — and nothing
   * to prepare beyond the query string.
   */
  function myMemory(request) {
    const { source, target } = request;
    const text = firstText(request);
    const params = new URLSearchParams({ q: text, langpair: `${source}|${target}` });
    return {
      url: `https://api.mymemory.translated.net/get?${params.toString()}`,
      init: { method: "GET" },
    };
  }
  const parseMyMemory = (json, count) => {
    const status = Number(json?.responseStatus);
    const text = json?.responseData?.translatedText;
    if (!text || (Number.isFinite(status) && status >= 400)) {
      throw new Error(
        String(json?.responseDetails || `MyMemory 返回错误（${status || "?"}）`).slice(0, 80),
      );
    }
    return [String(text)
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, "&")];
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
      id: "bing-free",
      label: "必应翻译（免费，无需密钥）",
      group: "翻译 API",
      adapter: bingFree,
      parse: parseBing,
      perRequest: true,
      source: "ja",
      target: "zh-Hans",
      host: "https://cn.bing.com/*",
      note: "微软必应翻译的公开网页接口，不需要密钥，国内可直连（实测可用）。非正式 API：会话令牌会自动刷新；如遇限流请稍后再试或换用其它来源。",
    },
    {
      id: "mymemory",
      label: "MyMemory（免费，无需密钥）",
      group: "翻译 API",
      adapter: myMemory,
      parse: parseMyMemory,
      perRequest: true,
      source: "ja",
      target: "zh-CN",
      host: "https://api.mymemory.translated.net/*",
      note: "免费公共翻译记忆库：不需要密钥，有每日匿名配额（超限暂时报错，通常次日恢复），实测国内可直连。",
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
      // The product users know is ChatGPT; "OpenAI" alone reads like the
      // company, and the brief asked for the product name.
      label: "ChatGPT（OpenAI）",
      group: "AI 大模型",
      adapter: openAiCompatible,
      parse: parseOpenAiCompatible,
      endpoint: "https://api.openai.com/v1/chat/completions",
      // Verified against OpenRouter's live model directory (2026-10): the 4o
      // generation is gone from the api; current ids are the GPT-6 family
      // (Sol / Luna / Astra, ±pro) with GPT-6.1 Sol the newest.
      model: "gpt-6.1-sol",
      models: [
        { id: "gpt-6.1-sol", label: "GPT-6.1 Sol" },
        { id: "gpt-6-luna", label: "GPT-6 Luna" },
        { id: "gpt-6-astra", label: "GPT-6 Astra" },
      ],
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
      // Taken from DeepSeek's own pricing page: the current api names are
      // `deepseek-flash` (the V4.1-Flash model) and `deepseek-v4-pro`
      // (V4-Pro-0813); `deepseek-chat` / `deepseek-reasoner` are the previous
      // generation's names.
      model: "deepseek-flash",
      models: [
        { id: "deepseek-flash", label: "DeepSeek V4.1 Flash" },
        { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro" },
      ],
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
      model: "kimi-k3",
      models: [
        { id: "kimi-k3", label: "Kimi K3" },
        { id: "kimi-k2.6", label: "Kimi K2.6" },
      ],
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
      model: "glm-5.3",
      models: [
        { id: "glm-5.3", label: "GLM-5.3" },
        { id: "glm-5.3-flash", label: "GLM-5.3 Flash" },
      ],
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
      model: "qwen3.8-max",
      models: [
        { id: "qwen3.8-max", label: "Qwen3.8 Max" },
        { id: "qwen3.8-flash", label: "Qwen3.8 Flash" },
        { id: "qwen3.7-plus", label: "Qwen3.7 Plus" },
      ],
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
      // Verified against models.dev's siliconflow catalogue (2026-10).
      model: "deepseek-ai/DeepSeek-V4-Flash",
      models: [
        { id: "deepseek-ai/DeepSeek-V4-Flash", label: "DeepSeek V4 Flash" },
        { id: "deepseek-ai/DeepSeek-V4-Pro", label: "DeepSeek V4 Pro" },
        { id: "Qwen/Qwen3.6-27B", label: "Qwen3.6 27B" },
      ],
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
      // Groq is a US inference service (not xAI's Grok): it hosts open models
      // on its own fast hardware. Verified against models.dev (2026-10).
      model: "qwen/qwen3.8-27b",
      models: [
        { id: "qwen/qwen3.8-27b", label: "Qwen3.8 27B" },
        { id: "openai/gpt-oss-120b", label: "GPT-OSS 120B" },
        { id: "llama-3.3-70b-versatile", label: "Llama 3.3 70B" },
      ],
      keyRequired: true,
      host: "https://api.groq.com/*",
      keyUrl: "https://console.groq.com/keys",
      note: "Groq 是美国的高速推理服务（名字和 xAI 的 Grok 不是一回事），托管 Qwen、GPT-OSS、Llama 等开源模型，速度快、有免费额度；国内网络直连通常需要代理。",
    },
    {
      id: "openrouter",
      label: "OpenRouter",
      group: "AI 大模型",
      adapter: openAiCompatible,
      parse: parseOpenAiCompatible,
      endpoint: "https://openrouter.ai/api/v1/chat/completions",
      model: "google/gemini-3.8-flash",
      models: [
        { id: "google/gemini-3.8-flash", label: "Gemini 3.8 Flash（OpenRouter）" },
        { id: "openai/gpt-6-luna", label: "GPT-6 Luna（OpenRouter）" },
        { id: "deepseek/deepseek-v4.1-flash", label: "DeepSeek V4.1 Flash（OpenRouter）" },
      ],
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
      model: "gemini-3.8-flash",
      models: [
        { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash" },
        { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash Lite" },
        { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro（预览）" },
      ],
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
      // The api ids use hyphens (claude-sonnet-5-5), not the version dots the
      // marketing name shows — verified against models.dev (2026-10).
      model: "claude-sonnet-5-5",
      models: [
        { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
        { id: "claude-haiku-5-5", label: "Claude Haiku 5.5" },
        { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
      ],
      keyRequired: true,
      host: "https://api.anthropic.com/*",
      keyUrl: "https://console.anthropic.com/settings/keys",
    },
    {
      id: "xai",
      // The product name first, like ChatGPT（OpenAI）— and the note spells out
      // the difference from the Groq entry two rows up.
      label: "Grok（xAI）",
      group: "AI 大模型",
      adapter: openAiCompatible,
      parse: parseOpenAiCompatible,
      endpoint: "https://api.x.ai/v1/chat/completions",
      // Verified against models.dev's xai catalogue (2026-10).
      model: "grok-4.7",
      models: [
        { id: "grok-4.7", label: "Grok 4.7" },
        { id: "grok-4.6", label: "Grok 4.6" },
        { id: "grok-4.5", label: "Grok 4.5" },
      ],
      keyRequired: true,
      host: "https://api.x.ai/*",
      keyUrl: "https://console.x.ai/",
      note: "xAI 的 Grok（和上面的「Groq」不是一回事：那家是做推理硬件的）；国内网络直连通常需要代理。",
    },
    {
      id: "ollama",
      label: "本机 Ollama（无需密钥）",
      group: "AI 大模型",
      adapter: openAiCompatible,
      parse: parseOpenAiCompatible,
      endpoint: "http://127.0.0.1:11434/v1/chat/completions",
      // Tags verified against ollama.com/library (2026-10).
      model: "gemma4:12b",
      models: [
        { id: "gemma4:12b", label: "Gemma 4 12B（本机）" },
        { id: "qwen3.6:27b", label: "Qwen3.6 27B（本机）" },
      ],
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

  const LANGUAGE_HINTS = [
    ["简体中文", "zh"], ["繁體中文", "zh"], ["中文", "zh"], ["chinese", "zh"],
    ["english", "en"], ["英文", "en"],
    ["日本語", "ja"], ["日文", "ja"], ["japanese", "ja"],
    ["한국어", "ko"], ["朝鲜语", "ko"], ["korean", "ko"],
    ["русский", "ru"], ["俄语", "ru"], ["russian", "ru"],
    ["español", "es"], ["西班牙语", "es"], ["spanish", "es"],
    ["हिन्दी", "hi"], ["印地语", "hi"], ["hindi", "hi"],
    ["العربية", "ar"], ["阿拉伯语", "ar"], ["arabic", "ar"],
    ["français", "fr"], ["法语", "fr"], ["french", "fr"],
    ["deutsch", "de"], ["德语", "de"], ["german", "de"],
    ["português", "pt"], ["葡萄牙语", "pt"], ["portuguese", "pt"],
    ["italiano", "it"], ["意大利语", "it"], ["italian", "it"],
    ["ไทย", "th"], ["泰语", "th"], ["thai", "th"],
    ["tiếng việt", "vi"], ["越南语", "vi"], ["vietnamese", "vi"],
    ["bahasa indonesia", "id"], ["印尼语", "id"], ["indonesian", "id"],
    ["türkçe", "tr"], ["土耳其语", "tr"], ["turkish", "tr"],
  ];
  const CODE_ALIASES = {
    jp: "ja", kor: "ko", spa: "es", ara: "ar", fra: "fr",
    vie: "vi", cht: "zh", chs: "zh",
  };

  /**
   * Reduce a language name or a provider code to its base ISO-639 language.
   *
   * The translation menus say "繁體中文", DeepL says ZH-HANT, Google says
   * zh-TW and DeepSeek gets a natural-language name. Same-language suppression
   * has to see through all of those spellings, so it compares this base code
   * rather than the strings the user happened to select.
   */
  function languageBase(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    const lower = raw.toLowerCase();
    if (/^(auto|auto-detect|autodetect|自动识别|unknown)$/.test(lower)) return "";
    const hint = LANGUAGE_HINTS.find(([name]) => lower.includes(name.toLowerCase()));
    if (hint) return hint[1];
    const code = lower.split(/[-_\s（(]/)[0];
    if (CODE_ALIASES[code]) return CODE_ALIASES[code];
    if (/^[a-z]{2,3}$/.test(code)) return code;
    return "";
  }

  /**
   * A high-confidence script guess, used before the asynchronous Chrome
   * detector and as its fallback. Latin is left as "latin" rather than guessed
   * as English: French and German are also Latin, and a wrong skip is worse
   * than one redundant translation.
   */
  function detectScriptLanguage(text) {
    const value = String(text || "");
    if (/[\u3040-\u30ff]/u.test(value)) return "ja";
    if (/[\uac00-\ud7af]/u.test(value)) return "ko";
    if (/[\u0600-\u06ff]/u.test(value)) return "ar";
    if (/[\u0400-\u04ff]/u.test(value)) return "ru";
    if (/[\u0900-\u097f]/u.test(value)) return "hi";
    if (/[\u0e00-\u0e7f]/u.test(value)) return "th";
    if (/[\u4e00-\u9fff]/u.test(value)) return "zh";
    if (/[A-Za-z]/.test(value)) return "latin";
    return "";
  }

  /**
   * A cheap same-language check for content scripts before they spend a
   * request. It deliberately only claims the scripts it can tell apart; the
   * service worker runs Chrome's detector for the ambiguous Latin cases.
   */
  function likelySameLanguage(text, target, context = "") {
    const targetBase = languageBase(target);
    if (!targetBase) return false;
    const sample = String(context || text || "");
    const detected = detectScriptLanguage(sample);
    if (!detected || detected === "latin") return false;
    return detected === targetBase;
  }

  /**
   * The target language for a provider, resolved in exactly one place.
   *
   * Chat-based providers are told the language in words ("简体中文") because
   * that is what their prompts need, while the dedicated translation APIs take
   * vendor language *codes* ("ZH", "zh-CN"). The stored `targetLanguage` is
   * whatever the settings page last saved for the chat box, so a code-based
   * provider must never inherit it: switching from an LLM source to DeepL used
   * to send `target_lang=繁體中文` and fail every request, while the
   * connectivity probe — which resolved the value the other way round — still
   * reported success. Both paths call this, so they cannot disagree again.
   */
  function resolveTarget(provider, cfg = {}) {
    if (provider?.targetKind === "code") {
      return provider.target || cfg?.targetLanguage || "zh-CN";
    }
    return cfg?.targetLanguage || provider?.target || TARGET_DEFAULT;
  }

  const languageByName = (name) =>
    LANGUAGES.find((language) => language.name === String(name || "").trim()) || null;

  /** The code this provider expects for a language entry. */
  function codeFor(provider, language) {
    if (provider?.id === "deepL") return language.deepl;
    if (provider?.id === "baidu") return language.baidu;
    if (provider?.id === "youdao") return language.youdao;
    if (provider?.id === "bing-free") return language.bing;
    if (provider?.id === "mymemory") return language.mymemory;
    return language.google;
  }

  /**
   * Translate a language *name* ("English") into what this provider expects.
   *
   * Chat models get the readable name back; code-speaking APIs get their own
   * dialect (DeepL's ZH, 百度's jp, 有道's zh-CHS). An unknown name is passed
   * through unchanged so a hand-typed target still works.
   */
  function targetForLanguage(provider, name) {
    const wanted = String(name || "").trim();
    if (!wanted) return "";
    const language = languageByName(wanted);
    if (!language) return wanted;
    if (provider?.targetKind !== "code") return language.name;
    return codeFor(provider, language);
  }

  /**
   * The source side of the same menu, including 自动识别.
   *
   * Auto detection is spelled differently by each API: Google / 百度 / 有道
   * say "auto", Bing says "auto-detect", MyMemory says "Autodetect", and DeepL
   * detects when source_lang is omitted (empty string here).
   */
  function sourceForLanguage(provider, name) {
    const wanted = String(name || "").trim();
    if (!wanted || wanted === AUTO_SOURCE) {
      if (provider?.id === "deepL") return "";
      if (provider?.id === "bing-free") return "auto-detect";
      if (provider?.id === "mymemory") return "Autodetect";
      return "auto";
    }
    const language = languageByName(wanted);
    if (!language) return wanted;
    if (provider?.targetKind !== "code") return language.name;
    return codeFor(provider, language);
  }

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
      provider.chat = true;
    } else {
      provider.targetKind = "code";
      provider.chat = false;
    }
    // Whether the settings page offers a free-text model box for this provider
    // (only the OpenAI-compatible adapter reads one). The panel's model picker
    // uses the same flag to decide whether "自定义…" can be honoured.
    provider.modelEditable = provider.adapter === openAiCompatible;
  }

  root.MAS_providers = {
    list: PROVIDERS,
    byId,
    resolveTarget,
    targetForLanguage,
    sourceForLanguage,
    languageByName,
    languages: LANGUAGES,
    autoSource: AUTO_SOURCE,
    glossaries: GLOSSARIES,
    glossaryById,
    glossaryPrompt,
    languageBase,
    detectScriptLanguage,
    likelySameLanguage,
    strengths: STRENGTHS,
    normalizeStrength,
    strengthLabel,
    strengthHint,
    modelsOf,
    resolveModel,
    chatPrompt,
    dictionaryPrompt,
    parseDictionary,
    parseChatContent,
    extractChatText,
    isChatProvider,
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
