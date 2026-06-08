const DEFAULT_SETTINGS = {
  provider: "ollama",
  mode: "append",
  translationStyle: "bar",
  markStyle: "highlight",
  markHighlightColor: "#fff2a8",
  autoSendMarkedToNote: true,
  translationFontSize: 100,
  translationLineHeight: 1.4,
  autoOpenPanel: true,
  model: "qwen3.5:4b",
  baseUrl: "http://localhost:11434",
  apiKey: ""
};

const MAX_OUTPUT_TOKENS = 800;
// 实时翻译参数（qwen3.5:4b 起步，兼顾速度和质量）
const OLLAMA_NUM_CTX = 4096;    // 足够大的上下文窗口，防止输出被截断
const OLLAMA_NUM_BATCH = 512;   // 实测最优批处理大小
const OLLAMA_STREAM_NUM_CTX = 1536;
const OLLAMA_STREAM_NUM_BATCH = 128;
const OLLAMA_STREAM_TIMEOUT_MS = 22000;
const OLLAMA_TASK_TIMEOUT_MS = 45000;
const OLLAMA_PREWARM_TIMEOUT_MS = 8000;
const OLLAMA_WARM_TTL_MS = 25 * 60 * 1000;
const ollamaWarmState = new Map();

chrome.action.onClicked.addListener(async (tab) => {
  try {
    const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
    await sendContentMessage(tab, {
      type: "OPEN_ASK_PANEL",
      settings
    });
  } catch (error) {
    console.warn("[PIT] failed to open page panel", error);
  }
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  try {
    const activeTab = tab?.id ? tab : await getActiveTab();
    if (!activeTab?.id) return;
    const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
    if (command === "open_reader_panel") {
      await sendContentMessage(activeTab, { type: "OPEN_ASK_PANEL", settings });
      return;
    }
    if (command === "translate_current_page") {
      await sendContentMessage(activeTab, { type: "OPEN_ASK_PANEL", settings });
      await sendContentMessage(activeTab, { type: "TRANSLATE_PAGE", settings });
      return;
    }
    if (command === "send_selection_to_note") {
      await sendContentMessage(activeTab, { type: "APPEND_SELECTION_TO_NOTE", settings });
    }
  } catch (error) {
    console.warn("[PIT] command failed", command, error);
  }
});

// ─── 消息路由 ────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "LIST_OLLAMA_MODELS") {
    listOllamaModels(message.baseUrl)
      .then((models) => sendResponse({ ok: true, models }))
      .catch((error) => sendResponse({ ok: false, error: humanizeError(error) }));
    return true;
  }

  if (message?.type === "PREWARM_OLLAMA") {
    prewarmOllama(message.settings)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: humanizeError(error) }));
    return true;
  }

  if (message?.type === "SAVE_MARKDOWN_NOTE") {
    saveMarkdownNote(message.page, message.note, message.options)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: humanizeError(error) }));
    return true;
  }

  if (message?.type === "BUILD_ARTICLE_OVERVIEW") {
    buildArticleOverview(message.page, message.settings)
      .then((overview) => sendResponse({ ok: true, overview }))
      .catch((error) => sendResponse({ ok: false, error: humanizeError(error) }));
    return true;
  }

  if (message?.type === "ASK_ARTICLE") {
    askArticle(message.page, message.question, message.settings, message.allowWebSearch)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: humanizeError(error) }));
    return true;
  }

  if (message?.type === "GENERATE_TWEET_POST") {
    generateTweetPost(message.input, message.targetLanguage, message.settings)
      .then((text) => sendResponse({ ok: true, text }))
      .catch((error) => sendResponse({ ok: false, error: humanizeError(error) }));
    return true;
  }

  if (message?.type === "TRANSLATE_BATCH") {
    translateBatch(message.texts, message.settings)
      .then((translations) => sendResponse({ ok: true, translations }))
      .catch((error) => sendResponse({ ok: false, error: humanizeError(error) }));
    return true;
  }

  return false;
});

async function sendContentMessage(tab, message) {
  if (!tab?.id || !canInjectIntoUrl(tab.url)) return;
  try {
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch (error) {
    if (!String(error?.message || error).includes("Receiving end does not exist")) throw error;
    await chrome.scripting.insertCSS({
      target: { tabId: tab.id },
      files: ["src/content.css"]
    });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["src/content.js"]
    });
    return chrome.tabs.sendMessage(tab.id, message);
  }
}

function canInjectIntoUrl(url) {
  return /^https?:\/\//i.test(url || "") || /^file:\/\//i.test(url || "");
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "PIT_STREAM_TRANSLATE") return;

  let controller = null;

  port.onMessage.addListener((message) => {
    if (message?.type !== "START_TRANSLATION_STREAM") return;
    controller = new AbortController();
    streamTranslationToPort(message.text, message.settings, port, controller)
      .catch((error) => safePost(port, { type: "error", error: humanizeError(error) }));
  });

  port.onDisconnect.addListener(() => {
    controller?.abort();
  });
});

async function streamTranslationToPort(text, settings = {}, port, controller) {
  const resolved = { ...DEFAULT_SETTINGS, ...settings };
  if (resolved.provider === "openaiCompatible") {
    return streamOpenAICompatibleToPort(text, resolved, port, controller);
  }

  return streamOllamaToPort(text, resolved, port, controller);
}

// ─── 批量翻译（用于视口外的段落，效率优先）────────────────────
async function translateBatch(texts, settings = {}) {
  const resolved = { ...DEFAULT_SETTINGS, ...settings };
  const cleanTexts = texts.map((text) => String(text || "").trim());
  if (!cleanTexts.length) return [];

  if (resolved.provider === "openaiCompatible") {
    try {
      return await translateWithOpenAICompatible(cleanTexts, resolved);
    } catch (onlineError) {
      try {
        return await translateWithOllama(cleanTexts, { ...DEFAULT_SETTINGS, provider: "ollama" });
      } catch (localError) {
        throw new Error(
          `在线翻译失败，且本地 Ollama 兜底也失败。在线错误：${humanizeError(onlineError)} 本地错误：${humanizeError(localError)}`
        );
      }
    }
  }

  return translateWithOllama(cleanTexts, resolved);
}

// ─── 非流式批量 Ollama（视口外段落）─────────────────────────────
async function translateWithOllama(texts, settings) {
  const endpoint = joinUrl(settings.baseUrl, "/api/chat");
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: settings.model || DEFAULT_SETTINGS.model,
      stream: false,
      format: "json",
      think: false,
      keep_alive: "30m",
      options: {
        temperature: 0,
        top_k: 1,
        top_p: 1.0,
        num_predict: estimateOutputTokens(texts),
        num_ctx: OLLAMA_NUM_CTX,
        num_batch: OLLAMA_NUM_BATCH,
        num_gpu: 99
      },
      messages: buildMessages(texts)
    })
  });

  if (!response.ok) {
    throw new Error(`Ollama request failed: ${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  return parseTranslationArray(data?.message?.content, texts.length);
}

async function translateWithOpenAICompatible(texts, settings) {
  const endpoint = openAICompatibleChatEndpoint(settings.baseUrl);
  const headers = { "Content-Type": "application/json" };
  if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: settings.model,
      temperature: 0.1,
      messages: buildMessages(texts)
    })
  });

  if (!response.ok) {
    throw new Error(`API request failed: ${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  return parseTranslationArray(data?.choices?.[0]?.message?.content, texts.length);
}

async function streamOpenAICompatibleToPort(text, settings = {}, port, controller) {
  const endpoint = openAICompatibleChatEndpoint(settings.baseUrl);
  const headers = { "Content-Type": "application/json" };
  if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    signal: controller.signal,
    body: JSON.stringify({
      model: settings.model,
      stream: true,
      temperature: 0,
      messages: [
        {
          role: "system",
          content: "Translate any non-Simplified Chinese text to Simplified Chinese. Convert Traditional Chinese to Simplified Chinese. Preserve markdown formatting. Output only the translation."
        },
        {
          role: "user",
          content: String(text || "")
        }
      ]
    })
  });

  if (!response.ok) {
    throw new Error(`API request failed: ${response.status} ${await response.text()}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let accumulated = "";
  let lineBuf = "";

  while (!controller.signal.aborted) {
    const { done, value } = await reader.read();
    if (done) break;

    lineBuf += decoder.decode(value, { stream: true });
    const lines = lineBuf.split("\n");
    lineBuf = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();

      if (data === "[DONE]") {
        safePost(port, { type: "done", text: stripModelNoise(accumulated) });
        reader.cancel().catch(() => {});
        return;
      }

      try {
        const obj = JSON.parse(data);
        const chunk = obj?.choices?.[0]?.delta?.content || "";
        if (chunk) {
          accumulated += chunk;
          safePost(port, { type: "chunk", chunk });
        }
      } catch {
        // 忽略不完整 SSE 行
      }
    }
  }

  reader.cancel().catch(() => {});
  if (!controller.signal.aborted) {
    safePost(port, { type: "done", text: stripModelNoise(accumulated) });
  }
}

async function streamOllamaToPort(text, settings = {}, port, controller) {
  const endpoint = joinUrl(settings.baseUrl || DEFAULT_SETTINGS.baseUrl, "/api/chat");
  const source = String(text || "");
  const inputEst = Math.ceil(source.length / 3) + 60;
  const safePredict = Math.min(700, Math.max(80, Math.min(OLLAMA_STREAM_NUM_CTX - inputEst - 80, Math.ceil(source.length * 0.9) + 120)));
  const timer = setTimeout(() => controller.abort(), OLLAMA_STREAM_TIMEOUT_MS);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: settings.model || DEFAULT_SETTINGS.model,
        stream: true,
        think: false,
        keep_alive: "30m",
        options: {
          temperature: 0,
          top_k: 1,
          top_p: 1.0,
          num_predict: safePredict,
          num_ctx: OLLAMA_STREAM_NUM_CTX,
          num_batch: OLLAMA_STREAM_NUM_BATCH,
          num_gpu: 99
        },
        messages: [
          {
            role: "system",
            content: "Translate the text to Simplified Chinese. Convert Traditional Chinese to Simplified Chinese. Preserve markdown, line breaks, and paragraph breaks. Do not translate or alter URLs/link placeholders. Output only the translation."
          },
          {
            role: "user",
            content: `/no_think\n${source}`
          }
        ]
      })
    });

    if (!response.ok) {
      throw new Error(`Ollama request failed: ${response.status} ${await response.text()}`);
    }
    markOllamaWarm(settings);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let accumulated = "";
    let lineBuf = "";
    let done = false;

    while (!done && !controller.signal.aborted) {
      const { done: streamDone, value } = await reader.read();
      if (streamDone) break;

      lineBuf += decoder.decode(value, { stream: true });
      const lines = lineBuf.split("\n");
      lineBuf = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          const chunk = obj?.message?.content || "";
          if (chunk) {
            accumulated += chunk;
            safePost(port, { type: "chunk", chunk });
          }
          if (obj.done) {
            done = true;
            break;
          }
        } catch {
          // 忽略不完整 JSON 行
        }
      }
    }

    reader.cancel().catch(() => {});
    if (!controller.signal.aborted) {
      safePost(port, { type: "done", text: stripModelNoise(accumulated) });
    }
  } finally {
    clearTimeout(timer);
  }
}

async function listOllamaModels(baseUrl = DEFAULT_SETTINGS.baseUrl) {
  const response = await fetch(joinUrl(baseUrl, "/api/tags"));
  if (!response.ok) {
    throw new Error(`Ollama model list failed: ${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  return Array.isArray(data?.models)
    ? data.models
        .map((model) => model?.name)
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b))
    : [];
}

async function prewarmOllama(settings = {}) {
  const resolved = { ...DEFAULT_SETTINGS, ...settings };
  if (resolved.provider !== "ollama") return;
  const warmKey = getOllamaWarmKey(resolved);
  const now = Date.now();
  const existing = ollamaWarmState.get(warmKey);
  if (existing?.until > now) return;
  if (existing?.promise) return existing.promise;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OLLAMA_PREWARM_TIMEOUT_MS);

  const promise = (async () => {
    const response = await fetch(joinUrl(resolved.baseUrl, "/api/chat"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: resolved.model || DEFAULT_SETTINGS.model,
        stream: false,
        keep_alive: "30m",
        think: false,
        options: {
          temperature: 0,
          top_k: 1,
          top_p: 1.0,
          num_predict: 1,
          num_ctx: OLLAMA_STREAM_NUM_CTX,
          num_batch: OLLAMA_STREAM_NUM_BATCH,
          num_gpu: 99
        },
        messages: [
          { role: "system", content: "Translate the text to Simplified Chinese. Output only the translation." },
          { role: "user", content: "/no_think\nwarm up" }
        ]
      })
    });

    if (!response.ok) {
      throw new Error(`Ollama prewarm failed: ${response.status} ${await response.text()}`);
    }
    markOllamaWarm(resolved);
  })();

  ollamaWarmState.set(warmKey, { promise, until: 0 });
  let warmed = false;
  try {
    await promise;
    warmed = true;
  } finally {
    clearTimeout(timer);
    const latest = ollamaWarmState.get(warmKey);
    if (latest?.promise === promise) {
      if (warmed) {
        ollamaWarmState.set(warmKey, { until: Date.now() + OLLAMA_WARM_TTL_MS });
      } else {
        ollamaWarmState.delete(warmKey);
      }
    }
  }
}

function getOllamaWarmKey(settings = {}) {
  const baseUrl = settings.baseUrl || DEFAULT_SETTINGS.baseUrl;
  const model = settings.model || DEFAULT_SETTINGS.model;
  return `${baseUrl}|${model}|ctx:${OLLAMA_STREAM_NUM_CTX}|batch:${OLLAMA_STREAM_NUM_BATCH}`;
}

function markOllamaWarm(settings = {}) {
  ollamaWarmState.set(getOllamaWarmKey(settings), { until: Date.now() + OLLAMA_WARM_TTL_MS });
}

async function saveMarkdownNote(page = {}, note = "", options = {}) {
  const noteTitle = buildMeaningfulNoteTitle(page, note);
  const markdown = buildMarkdownNote(page, note, options, noteTitle);
  const saveDir = sanitizePathPart(options.saveDir || "page-notes");
  const filename = `${saveDir}/${makeMarkdownFilename(noteTitle)}`;
  const dataUrl = `data:text/markdown;charset=utf-8,${encodeURIComponent(`\uFEFF${markdown}`)}`;

  await chrome.downloads.download({
    url: dataUrl,
    filename,
    conflictAction: "uniquify",
    saveAs: false
  });

  return { filename };
}

async function buildArticleOverview(page = {}, settings = {}) {
  const isX = page.sourceType === "x" || /(^|\.)x\.com\//i.test(page.url || "") || /(^|\.)twitter\.com\//i.test(page.url || "");
  const articleText = (isX ? pageToXConversationText(page) : pageToArticleText(page)).slice(0, 18000);
  if (articleText.length < 80) throw new Error("文章内容太少，无法生成脉络。");

  const content = await chatWithLocalOllama(settings, [
    {
      role: "system",
      content: isX
        ? [
          "你是中文社交媒体阅读助手。",
          "只根据提供的 X/Twitter 内容输出，不补充外部知识。",
          "用 Markdown 输出，必须包含两个二级标题：## 发帖者主要观点、## 评论者主要观点。",
          "每个标题下用项目符号，普通人能快速看懂。",
          "评论区没有明确观点时写“评论区未提供足够明确观点”。",
          "总长度控制在260字以内。"
        ].join("")
        : [
          "你是中文阅读分析助手。",
          "只根据文章内容输出，不补充外部知识。",
          "用 Markdown 输出，包含二级标题和项目符号。",
          "用简洁中文展示：核心架构、主要观点、关键数据或事实。",
          "如果文章没有数据，就写“文章未提供明确数据”。",
          "总长度控制在220字以内。"
        ].join("")
    },
    {
      role: "user",
      content: isX
        ? `页面：${page.title || ""}\n\nX/Twitter 内容：\n${articleText}`
        : `标题：${page.title || ""}\n\n文章内容：\n${articleText}`
    }
  ], { num_predict: 520, num_ctx: 8192 });

  return stripModelNoise(content);
}

async function askArticle(page = {}, question = "", settings = {}, allowWebSearch = true) {
  const cleanedQuestion = String(question || "").trim();
  if (!cleanedQuestion) throw new Error("问题不能为空。");

  const articleText = pageToArticleText(page).slice(0, 18000);
  if (articleText.length < 80) throw new Error("文章内容太少，无法回答。");

  const draft = await askFromArticleOnly(page, articleText, cleanedQuestion, settings);
  if (!draft.needsSearch || !allowWebSearch) {
    return {
      answer: draft.answer,
      usedWebSearch: false
    };
  }

  const searchQuery = draft.searchQuery || `${page.title || ""} ${cleanedQuestion}`.trim();
  const searchResults = await searchWeb(searchQuery);
  if (!searchResults.length) {
    return {
      answer: [
        draft.answer,
        "",
        "网络补充：未找到可用搜索结果，因此没有额外补充。"
      ].join("\n"),
      usedWebSearch: true
    };
  }

  const answer = await answerWithArticleAndSearch(page, articleText, cleanedQuestion, searchResults, settings);
  return { answer, usedWebSearch: true };
}

async function askFromArticleOnly(page, articleText, question, settings) {
  const raw = await chatWithLocalOllama(settings, [
    {
      role: "system",
      content: [
        "你是严格的文章问答助手。",
        "必须只依据文章回答。",
        "回答必须简短，最多3条要点。",
        "answer 字段必须是 Markdown 字符串，每条要点用“- ”开头。",
        "如果文章能回答，needsSearch=false。",
        "如果文章不能回答或证据不足，needsSearch=true，并说明文章没有提到什么。",
        "如果需要搜索，给出简短 searchQuery。",
        "输出严格 JSON：{\"answer\":\"...\",\"needsSearch\":false,\"searchQuery\":\"\"}。"
      ].join("")
    },
    {
      role: "user",
      content: `标题：${page.title || ""}\n\n文章：\n${articleText}\n\n问题：${question}`
    }
  ], { num_predict: 700, num_ctx: 8192, format: "json" });

  try {
    const parsed = parseJsonPayload(raw);
    return {
      answer: normalizeAnswerMarkdown(parsed.answer || "文章没有提供足够信息回答这个问题。"),
      needsSearch: Boolean(parsed.needsSearch),
      searchQuery: String(parsed.searchQuery || "").trim()
    };
  } catch {
    return {
      answer: normalizeAnswerMarkdown(stripModelNoise(raw) || "文章没有提供足够信息回答这个问题。"),
      needsSearch: false,
      searchQuery: ""
    };
  }
}

async function answerWithArticleAndSearch(page, articleText, question, searchResults, settings) {
  const searchText = searchResults
    .map((item, index) => `${index + 1}. ${item.title}\n${item.snippet}\n${item.url}`)
    .join("\n\n");

  const raw = await chatWithLocalOllama(settings, [
    {
      role: "system",
      content: [
        "你是谨慎的中文问答助手。",
        "优先使用文章内容。",
        "网络搜索只作为补充，必须明确标注“网络补充”。",
        "如果是推测，必须写“这是推测”。",
        "不要编造文章或搜索结果中没有的信息。",
        "回答要简洁、普通人容易懂，最多4条 Markdown 要点。"
      ].join("")
    },
    {
      role: "user",
      content: [
        `标题：${page.title || ""}`,
        `问题：${question}`,
        `文章内容：\n${articleText}`,
        `网络搜索结果：\n${searchText}`
      ].join("\n\n")
    }
  ], { num_predict: 900, num_ctx: 10000 });

  return normalizeAnswerMarkdown(stripModelNoise(raw));
}

async function generateTweetPost(input = "", targetLanguage = "English", settings = {}) {
  const idea = String(input || "").trim();
  if (!idea) throw new Error("内容不能为空。");

  const raw = await chatWithLocalOllama(settings, [
    {
      role: "system",
      content: [
        "你是专业的 X/Twitter 文案助手。",
        "把用户想表达的内容改写成一条适合发布的社交媒体文字。",
        "必须忠实保留原意，不添加用户没有提供的事实、数据或承诺。",
        "目标语言必须严格使用用户指定的语言。",
        "语气自然、清楚、有观点，普通用户一眼能看懂。",
        "尽量控制在260个字符以内，绝对不要超过280个字符。",
        "除非用户原文需要，不要主动添加话题标签、链接或 @账号。",
        "只输出最终文案，不要标题、解释、引号或 Markdown。"
      ].join("")
    },
    {
      role: "user",
      content: `目标语言：${targetLanguage}\n\n想表达的内容：\n${idea}`
    }
  ], { num_predict: 360, num_ctx: 4096, timeoutMs: OLLAMA_TASK_TIMEOUT_MS });

  return normalizeTweetOutput(stripModelNoise(raw));
}

function normalizeTweetOutput(text) {
  const cleaned = String(text || "")
    .replace(/^\s*(?:Twitter|X)\s*(?:文案|post|tweet)\s*[:：-]\s*/i, "")
    .replace(/^["“”'`]+|["“”'`]+$/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const chars = Array.from(cleaned);
  return chars.length > 280 ? `${chars.slice(0, 277).join("").trimEnd()}...` : cleaned;
}

function normalizeAnswerMarkdown(answer) {
  const cleaned = String(answer || "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!cleaned) return "- 文章没有提供足够信息回答这个问题。";
  if (/^\s*(#{1,3}\s+|[-*]\s+|\d+[\.)]\s+)/m.test(cleaned)) return cleaned;
  return cleaned
    .split(/[。；;]\s*/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 3)
    .map((item) => `- ${item}${/[。.!?！？]$/.test(item) ? "" : "。"}`)
    .join("\n");
}

async function searchWeb(query) {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`网络搜索失败：${response.status}`);

  const data = await response.json();
  const results = [];
  if (data.AbstractText) {
    results.push({
      title: data.Heading || "DuckDuckGo 摘要",
      snippet: data.AbstractText,
      url: data.AbstractURL || ""
    });
  }

  collectDuckDuckGoTopics(data.RelatedTopics, results);
  return results
    .filter((item) => item.snippet)
    .slice(0, 5);
}

function collectDuckDuckGoTopics(topics, results) {
  if (!Array.isArray(topics)) return;
  for (const topic of topics) {
    if (results.length >= 5) return;
    if (Array.isArray(topic.Topics)) {
      collectDuckDuckGoTopics(topic.Topics, results);
      continue;
    }
    if (topic.Text) {
      results.push({
        title: topic.FirstURL || "搜索结果",
        snippet: topic.Text,
        url: topic.FirstURL || ""
      });
    }
  }
}

async function chatWithLocalOllama(settings = {}, messages, options = {}) {
  const localSettings = {
    ...DEFAULT_SETTINGS,
    baseUrl: settings.provider === "ollama" ? settings.baseUrl : DEFAULT_SETTINGS.baseUrl,
    model: settings.provider === "ollama" ? settings.model : DEFAULT_SETTINGS.model
  };

  const body = {
    model: localSettings.model || DEFAULT_SETTINGS.model,
    stream: false,
    think: false,
    keep_alive: "30m",
    options: {
      temperature: 0,
      top_k: 1,
      top_p: 1.0,
      num_predict: options.num_predict || 800,
      num_ctx: options.num_ctx || 8192,
      num_batch: OLLAMA_NUM_BATCH,
      num_gpu: 99
    },
    messages
  };
  if (options.format) body.format = options.format;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || OLLAMA_TASK_TIMEOUT_MS);

  try {
    const response = await fetch(joinUrl(localSettings.baseUrl, "/api/chat"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      throw new Error(`Ollama request failed: ${response.status} ${await response.text()}`);
    }

    const data = await response.json();
    return data?.message?.content || "";
  } finally {
    clearTimeout(timer);
  }
}

function pageToArticleText(page = {}) {
  return (Array.isArray(page.blocks) ? page.blocks : [])
    .map((block) => block.original)
    .filter(Boolean)
    .join("\n")
    .replace(/\s+/g, " ")
    .trim();
}

function pageToXConversationText(page = {}) {
  const blocks = Array.isArray(page.blocks) ? page.blocks : [];
  const author = blocks
    .filter((block) => block.role === "author")
    .map((block) => block.original)
    .filter(Boolean)
    .join("\n\n");
  const commenters = blocks
    .filter((block) => block.role !== "author")
    .map((block) => block.original)
    .filter(Boolean)
    .slice(0, 80)
    .join("\n\n");

  return [
    author ? `【发帖者内容】\n${author}` : "",
    commenters ? `【评论者内容】\n${commenters}` : ""
  ].filter(Boolean).join("\n\n");
}

function buildMarkdownNote(page, note, options, noteTitle = "") {
  const title = noteTitle || buildMeaningfulNoteTitle(page, note);
  const lines = [`# ${escapeMarkdownHeading(title)}`, ""];
  lines.push(`保存时间：${new Date().toLocaleString("zh-CN")}`, "");

  if (options.saveUrl && page.url) {
    lines.push("## 原始链接", "", page.url, "");
  }

  if (options.saveSummary && page.summary) {
    lines.push("## 总结", "", page.summary.trim(), "");
  }

  if (options.saveNote && note) {
    lines.push("## 我的笔记", "", note.trim(), "");
  }

  const blocks = Array.isArray(page.blocks) ? page.blocks : [];
  if (options.saveOriginal) {
    const original = blocks.map((block) => block.original).filter(Boolean).join("\n\n");
    if (original) lines.push("## 网页原文", "", original, "");
  }

  if (options.saveTranslation) {
    const translated = blocks.map((block) => block.translation).filter(Boolean).join("\n\n");
    if (translated) lines.push("## 中文翻译", "", translated, "");
  }

  if (!options.saveUrl && !options.saveSummary && !options.saveNote && !options.saveOriginal && !options.saveTranslation) {
    lines.push("> 未选择保存内容。", "");
  }

  return lines.join("\n").replace(/\n{4,}/g, "\n\n\n").trim() + "\n";
}

function makeMarkdownFilename(title) {
  const date = getLocalDateString();
  const slug = sanitizePathPart(String(title || "").replace(new RegExp(`^${date}\\s*[-_—]\\s*`), ""))
    .replace(/\s+/g, "-")
    .slice(0, 80) || "page-note";
  return `${date}-${slug}.md`;
}

function buildMeaningfulNoteTitle(page = {}, note = "") {
  const date = getLocalDateString();
  const blocks = Array.isArray(page.blocks) ? page.blocks : [];
  const contentSource = [
    note,
    page.title,
    blocks.map((block) => block.original).filter(Boolean).slice(0, 3).join(" "),
    blocks.map((block) => block.translation).filter(Boolean).slice(0, 2).join(" ")
  ].filter(Boolean).join(" ");
  const topic = summarizeTitleText(contentSource) || "网页笔记";
  return `${date} - ${topic}`;
}

function summarizeTitleText(text) {
  const cleaned = String(text || "")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/[\\/#*_`>|[\]{}()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";
  const sentence = cleaned.split(/[。！？.!?；;｜|]/).find((part) => part.trim().length >= 6) || cleaned;
  const compact = sentence
    .replace(/\b(?:login|sign up|subscribe|home|profile|thread|post)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  const hasCjk = /[\u3400-\u9fff]/.test(compact);
  return (hasCjk ? compact.slice(0, 34) : compact.split(/\s+/).slice(0, 10).join(" ")).trim() || "网页笔记";
}

function getLocalDateString() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function sanitizePathPart(value) {
  const raw = String(value || "").trim();
  if (/^(?:\/|~\/|[a-zA-Z]:[\\/])/.test(raw)) {
    throw new Error("保存目录不能填写绝对路径。请把 Chrome 下载位置设为 Obsidian 库，再在插件里填写子文件夹名，例如 WebNotes。");
  }
  return raw
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.\.+/g, "")
    .replace(/[<>:"|?*\x00-\x1F]/g, "")
    .replace(/\/{2,}/g, "/")
    .trim() || "page-notes";
}

function escapeMarkdownHeading(text) {
  return String(text || "").replace(/\s+/g, " ").replace(/^#+\s*/, "").trim();
}

// ─── Prompt 构建 ──────────────────────────────────────────────
// 单段落流式 prompt（更简单，减少 token）
function buildSingleMessage(text) {
  return [
    {
      role: "system",
      content: "Translate any non-Simplified Chinese text to Simplified Chinese. Convert Traditional Chinese to Simplified Chinese. Output only the translated text, nothing else."
    },
    {
      role: "user",
      content: `/no_think\n${text}`
    }
  ];
}

// 批量 JSON prompt（用于非流式批量翻译）
function buildMessages(texts) {
  return [
    {
      role: "system",
      content: "Non-Simplified Chinese→Simplified Chinese translator. Convert Traditional Chinese to Simplified Chinese. No notes or <think> blocks. Return only compact JSON: {\"translations\":[\"...\"]}."
    },
    {
      role: "user",
      content: `/no_think\nTranslate to Simplified Chinese, keep array length ${texts.length}:\n${JSON.stringify(texts)}`
    }
  ];
}

// ─── 解析工具 ────────────────────────────────────────────────
function extractSingleTranslation(content, originalText) {
  if (!content) return "";
  const cleaned = stripModelNoise(content).trim();
  // 单段落模式：直接提取文本，不需要 JSON 解析
  // 如果意外输出了 JSON，尝试解析
  if (cleaned.startsWith("{") || cleaned.startsWith("[")) {
    try {
      const parsed = parseJsonPayload(cleaned);
      const arr = Array.isArray(parsed) ? parsed : parsed?.translations;
      if (Array.isArray(arr) && arr[0]) return String(arr[0]).trim();
    } catch { /* 继续使用原始文本 */ }
  }
  return cleaned;
}

function parseTranslationArray(content, expectedLength) {
  if (!content) throw new Error("Translation response was empty.");

  const parsed = parseJsonPayload(content);
  const translations = Array.isArray(parsed) ? parsed : parsed?.translations;
  if (!Array.isArray(translations)) {
    throw new Error("Translation response did not contain a translations array.");
  }

  return Array.from({ length: expectedLength }, (_, index) => {
    const translated = translations[index];
    return typeof translated === "string" && translated.trim() ? translated.trim() : "";
  });
}

function parseJsonPayload(content) {
  const cleaned = stripModelNoise(content);
  try {
    return JSON.parse(cleaned);
  } catch {
    const objectSlice = extractBalancedJson(cleaned, "{", "}");
    if (objectSlice) return JSON.parse(objectSlice);

    const arraySlice = extractBalancedJson(cleaned, "[", "]");
    if (arraySlice) return JSON.parse(arraySlice);

    throw new Error("Could not parse JSON translation response.");
  }
}

function stripModelNoise(content) {
  return String(content)
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/```(?:json)?/gi, "")
    .replace(/```/g, "")
    .trim();
}

function extractBalancedJson(text, openChar, closeChar) {
  const start = text.indexOf(openChar);
  if (start === -1) return "";

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (escaped) { escaped = false; continue; }
    if (char === "\\") { escaped = true; continue; }
    if (char === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (char === openChar) depth += 1;
    if (char === closeChar) depth -= 1;
    if (depth === 0) return text.slice(start, index + 1);
  }

  return "";
}

function estimateOutputTokens(texts) {
  const sourceLength = texts.reduce((sum, text) => sum + text.length, 0);
  return Math.min(MAX_OUTPUT_TOKENS, Math.max(128, Math.ceil(sourceLength * 0.6)));
}

function joinUrl(baseUrl, path) {
  return `${String(baseUrl || "").replace(/\/+$/, "")}${path}`;
}

function openAICompatibleChatEndpoint(baseUrl) {
  const normalized = String(baseUrl || "").replace(/\/+$/, "");
  if (normalized.endsWith("/chat/completions")) return normalized;
  if (normalized.endsWith("/v1")) return `${normalized}/chat/completions`;
  return `${normalized}/v1/chat/completions`;
}

function humanizeError(error) {
  const message = error?.message || String(error);
  if (error?.name === "AbortError" || message.includes("aborted") || message.includes("abort")) {
    return "Ollama 响应超时。请稍后重试、重启 Ollama，或在设置中选择更小的模型。";
  }
  if (message.includes("Ollama request failed: 403")) {
    return [
      "Ollama 拒绝了 Chrome 扩展请求（403）。",
      "请放行扩展来源后重启 Ollama：",
      "launchctl setenv OLLAMA_ORIGINS 'chrome-extension://*,http://localhost:*,http://127.0.0.1:*'",
      "然后完全退出并重新打开 Ollama。"
    ].join(" ");
  }
  if (message.includes("Failed to fetch")) {
    return "无法连接翻译后端。若使用 Ollama，请确认 ollama serve 正在运行。";
  }
  return message.slice(0, 500);
}

function safePost(port, message) {
  try {
    port.postMessage(message);
  } catch {
    // 页面已关闭或用户已恢复原文。
  }
}
