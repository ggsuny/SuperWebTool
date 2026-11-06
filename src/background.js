const DEFAULT_SETTINGS = {
  provider: "ollama",
  mode: "append",
  translationStyle: "bar",
  shortTextReplaceMode: false,
  markStyle: "highlight",
  markHighlightColor: "#fff2a8",
  markHighlightColorLight: "#fff2a8",
  markHighlightColorDark: "#facc15",
  translationFontSize: 100,
  translationLineHeight: 1.4,
  noteSaveShortcut: "enter",
  autoOpenPanel: false,
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
const CONTEXT_MENU_ITEMS = [
  { id: "pit_open_reader_panel", title: "打开页面阅读助手", contexts: ["page", "selection"] },
  { id: "pit_translate_current_page", title: "翻译当前页面", contexts: ["page", "selection"] },
  { id: "pit_translate_selection", title: "翻译选中内容", contexts: ["selection"] },
  { id: "pit_mark_selection", title: "标记选中内容", contexts: ["selection"] }
];

chrome.runtime.onInstalled.addListener(createContextMenus);
chrome.runtime.onStartup.addListener(createContextMenus);

chrome.action.onClicked.addListener(async (tab) => {
  try {
    const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
    await runReaderAction(tab, "open_reader_panel", settings);
  } catch (error) {
    console.warn("[PIT] failed to open page panel", error);
  }
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  try {
    const activeTab = tab?.id ? tab : await getActiveTab();
    if (!activeTab?.id) return;
    const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
    await runReaderAction(activeTab, command, settings);
  } catch (error) {
    console.warn("[PIT] command failed", command, error);
  }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  try {
    const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
    const actionByMenuId = {
      pit_open_reader_panel: "open_reader_panel",
      pit_translate_current_page: "translate_current_page",
      pit_translate_selection: "translate_selection",
      pit_mark_selection: "mark_selection"
    };
    await runReaderAction(tab, actionByMenuId[info.menuItemId], settings, {
      selectionText: info.selectionText || ""
    });
  } catch (error) {
    console.warn("[PIT] context menu failed", info?.menuItemId, error);
  }
});

// ─── 消息路由 ────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "DEV_RELOAD_EXTENSION") {
    sendResponse({ ok: true });
    setTimeout(() => chrome.runtime.reload(), 40);
    return false;
  }

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

  if (message?.type === "CLEAN_NOTE_CONTENT") {
    cleanNoteContent(message.note, message.settings)
      .then((cleanedNote) => sendResponse({ ok: true, cleanedNote }))
      .catch((error) => sendResponse({ ok: false, error: humanizeError(error) }));
    return true;
  }

  if (message?.type === "BUILD_ORIGINAL_SUMMARY") {
    buildOriginalSummaryForNote(message.page, message.settings)
      .then((originalSummary) => sendResponse({ ok: true, originalSummary }))
      .catch((error) => sendResponse({ ok: false, error: humanizeError(error) }));
    return true;
  }

  if (message?.type === "BUILD_ARTICLE_OVERVIEW") {
    buildArticleOverview(message.page, message.settings)
      .then((overview) => sendResponse({ ok: true, overview }))
      .catch((error) => sendResponse({ ok: false, error: humanizeError(error) }));
    return true;
  }

  if (message?.type === "GENERATE_NOTE_TITLE") {
    generateSummaryNoteTitle(message.page, message.note, message.settings)
      .then((noteTitle) => sendResponse({ ok: true, noteTitle }))
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

  if (message?.type === "FETCH_PDF_AS_BASE64") {
    fetchPdfAsBase64(message.url)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: humanizeError(error) }));
    return true;
  }

  if (message?.type === "GET_COMMAND_SHORTCUT") {
    getCommandShortcut(message.command)
      .then((shortcut) => sendResponse({ ok: true, shortcut }))
      .catch((error) => sendResponse({ ok: false, error: humanizeError(error) }));
    return true;
  }

  return false;
});

async function getCommandShortcut(commandName) {
  const command = String(commandName || "").trim();
  if (!command || !chrome.commands?.getAll) return "";
  const commands = await chrome.commands.getAll();
  return commands.find((item) => item.name === command)?.shortcut || "";
}

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

function createContextMenus() {
  if (!chrome.contextMenus?.removeAll) return;
  chrome.contextMenus.removeAll(() => {
    for (const item of CONTEXT_MENU_ITEMS) {
      chrome.contextMenus.create({
        id: item.id,
        title: item.title,
        contexts: item.contexts,
        documentUrlPatterns: ["http://*/*", "https://*/*", "file:///*"]
      });
    }
  });
}

async function runReaderAction(tab, action, settings, options = {}) {
  if (!action) return;
  if (action === "open_reader_panel") {
    await sendContentMessage(tab, { type: "OPEN_ASK_PANEL", settings });
    return;
  }
  await sendContentMessage(tab, {
    type: "RUN_READER_ACTION",
    action,
    settings,
    selectionText: options.selectionText || ""
  });
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

function resolveProviderSettings(settings = {}) {
  const resolved = { ...DEFAULT_SETTINGS, ...settings };
  if (resolved.provider === "antLing") {
    resolved.baseUrl = settings.baseUrl?.trim() || "https://api.ant-ling.com/v1";
    resolved.model = settings.model?.trim() || "Ling-3.0-flash";
    resolved.apiKey = settings.apiKey?.trim() || "";
    if (!resolved.apiKey) throw new Error("请先在设置中填写蚂蚁百灵 API Key。");
  }
  return resolved;
}

function onlineProviderOptions(settings) {
  return settings.provider === "antLing" ? { thinking: { type: "disabled" } } : {};
}

async function streamTranslationToPort(text, settings = {}, port, controller) {
  const resolved = resolveProviderSettings(settings);
  if (["openaiCompatible", "antLing"].includes(resolved.provider)) {
    return streamOpenAICompatibleToPort(text, resolved, port, controller);
  }

  return streamOllamaToPort(text, resolved, port, controller);
}

// ─── 批量翻译（用于视口外的段落，效率优先）────────────────────
async function translateBatch(texts, settings = {}) {
  const resolved = resolveProviderSettings(settings);
  const cleanTexts = texts.map((text) => String(text || "").trim());
  if (!cleanTexts.length) return [];

  if (["openaiCompatible", "antLing"].includes(resolved.provider)) {
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

async function fetchPdfAsBase64(url) {
  const pdfUrl = String(url || "").trim();
  if (!/^https?:\/\//i.test(pdfUrl) && !/^file:\/\//i.test(pdfUrl)) {
    throw new Error("PDF 链接无效。");
  }

  const response = await fetch(pdfUrl, { credentials: "include" });
  if (!response.ok) {
    throw new Error(`PDF 下载失败：${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get("content-type") || "";
  const buffer = await response.arrayBuffer();
  return {
    base64: arrayBufferToBase64(buffer),
    contentType
  };
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
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
      ...onlineProviderOptions(settings),
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
      ...onlineProviderOptions(settings),
      stream: true,
      temperature: 0,
      messages: [
        {
          role: "system",
          content: "Translate any non-Simplified Chinese text to Simplified Chinese. Convert Traditional Chinese to Simplified Chinese. Preserve existing markdown formatting, line breaks, and paragraph breaks, but do not add new bold, italic, code, heading, or other markdown styling. Do not translate or alter PITLINK or PITTOKEN placeholders. Output only the translation."
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
  let posted = "";
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
          const next = getVisibleStreamDelta(accumulated, posted);
          posted = next.posted;
          if (next.delta) safePost(port, { type: "chunk", chunk: next.delta });
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
            content: "Translate the text to Simplified Chinese. Convert Traditional Chinese to Simplified Chinese. Preserve existing markdown, line breaks, and paragraph breaks, but do not add new bold, italic, code, heading, or other markdown styling. Do not translate or alter URLs/link placeholders. Do not translate or alter PITLINK or PITTOKEN placeholders. Output only the translation."
          },
          {
            role: "user",
            content: source
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
    let posted = "";
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
            const next = getVisibleStreamDelta(accumulated, posted);
            posted = next.posted;
            if (next.delta) safePost(port, { type: "chunk", chunk: next.delta });
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
          { role: "system", content: "Translate the text to Simplified Chinese. Do not translate or alter PITLINK or PITTOKEN placeholders. Output only the translation." },
          { role: "user", content: "warm up" }
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
  const savedNote = String(note || "").trim();
  // Never put an LLM request on the save path. Reuse a title prepared while
  // reading when possible, otherwise fall back locally so the download starts
  // immediately even when Ollama or a cloud provider is slow/offline.
  const noteTitle = normalizeGeneratedNoteTitle(page.noteTitle) || buildMeaningfulNoteTitle(page, savedNote);
  const originalSummary = options.saveOriginal
    ? String(page.originalSummary || "").trim() || buildExtractiveSummary(pageToArticleText(page))
    : "";
  const markdown = cleanMarkdownForExport(
    buildMarkdownNote({ ...page, originalSummary }, savedNote, options, noteTitle)
  );
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

async function buildOriginalSummaryForNote(page = {}, settings = {}) {
  const articleText = pageToArticleText(page).slice(0, 16000);
  if (articleText.length < 80) return "";

  try {
    const raw = await chatWithConfiguredProvider(settings, [
      {
        role: "system",
        content: [
          "你是网页笔记的原文总结助手。",
          "只依据提供的网页正文总结，不使用外部知识。",
          "忽略导航、按钮、登录、订阅、分享、相关推荐、页脚和链接列表等页面噪声。",
          "用简体中文写2到4条简短 Markdown 要点，说明文章主题、核心观点以及关键事实。",
          "不要写“本文主要讲了”等空话，不要添加标题，不要输出代码围栏。",
          "总长度控制在180字以内。"
        ].join("")
      },
      {
        role: "user",
        content: `网页标题：${page.title || ""}\n\n网页正文：\n${articleText}`
      }
    ], {
      num_predict: 360,
      num_ctx: 8192,
      timeoutMs: 18000
    });
    const summary = normalizeOriginalSummary(raw);
    if (summary) return summary;
  } catch (error) {
    console.warn("[PIT] original summary generation failed; using extractive fallback", error);
  }

  return buildExtractiveSummary(articleText);
}

function normalizeOriginalSummary(text) {
  const cleaned = stripModelNoise(text)
    .replace(/^\s*```(?:markdown|md)?\s*\n?/i, "")
    .replace(/\n?```\s*$/i, "")
    .replace(/^\s*#{1,6}\s*(?:原文总结|总结|摘要)\s*$/gim, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!cleaned) return "";
  if (/^\s*[-*]\s+/m.test(cleaned)) return cleaned;
  return cleaned
    .split(/(?<=[。！？.!?])\s+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 4)
    .map((item) => `- ${item}`)
    .join("\n");
}

function buildExtractiveSummary(articleText) {
  const sentences = String(articleText || "")
    .replace(/[#*_`>|[\]{}]/g, " ")
    .split(/(?<=[。！？.!?])\s+|\n+/)
    .map((item) => item.replace(/\s+/g, " ").trim())
    .filter((item) => item.length >= 24 && !isLikelyInterfaceText(item));
  return sentences
    .slice(0, 3)
    .map((item) => `- ${Array.from(item).slice(0, 100).join("")}`)
    .join("\n");
}

function isLikelyInterfaceText(text) {
  return /^(?:登录|注册|订阅|分享|关注|返回|首页|菜单|更多|下一页|上一页|login|sign up|subscribe|share|follow|menu|more)\b/i.test(text);
}

async function cleanNoteContent(note = "", settings = {}) {
  const original = dedupeMarkdownNoteBlocks(String(note || "").trim());
  if (!original) return "";

  try {
    const raw = await chatWithConfiguredProvider(settings, [
      {
        role: "system",
        content: [
          "你是 Markdown 笔记去重清洗器。",
          "输入是一整份当前 Markdown 笔记，不是新增片段；请把所有标题、列表、段落、引用、代码块和用户写下的 Markdown 笔记都视为同一份当前内容的一部分来处理。",
          "删除完全重复或语义高度重复的句子、段落、标题、列表项和要点，只保留信息最完整、上下文最清楚的一份。",
          "如果普通段落和 Markdown 列表项表达同一件事，也要视为重复，保留更适合当前结构的一份。",
          "保留原有事实、观点、引用、链接、代码、标题层级、列表层级和 Markdown 结构。",
          "不得删除、转义或改写用户主动使用的 Markdown 标记，例如 #、-、1.、>、```、**、`。",
          "允许整理不规范的 Markdown 空格和空行，但不要把列表拍平成段落，也不要把多行笔记合成一行。",
          "必须保留“选中内容”或“标记内容”与其后用户内容的上下文关系；如果两组上下文重复，保留带有更完整用户笔记的一组。",
          "不要总结，不要扩写，不要改写含义，不要添加任何新信息。",
          "如果没有重复内容，原样返回。",
          "只输出清洗后的 Markdown，不要解释，不要使用代码围栏。"
        ].join("")
      },
      {
        role: "user",
        content: `当前完整 Markdown 笔记如下：\n\n${original}`
      }
    ], {
      num_predict: Math.min(6000, Math.max(600, original.length + 200)),
      num_ctx: 16384,
      timeoutMs: 22000
    });

    const cleaned = dedupeMarkdownNoteBlocks(normalizeCleanedNote(raw));
    if (!cleaned || cleaned.length > original.length * 1.15) {
      throw new Error("LLM 返回的清洗结果无效。");
    }
    return cleaned;
  } catch (error) {
    console.warn("[PIT] note cleaning failed; saving original note", error);
    return original;
  }
}

async function chatWithConfiguredProvider(settings = {}, messages, options = {}) {
  const resolved = resolveProviderSettings(settings);
  if (!["openaiCompatible", "antLing"].includes(resolved.provider)) {
    return chatWithLocalOllama(resolved, messages, options);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || OLLAMA_TASK_TIMEOUT_MS);
  const headers = { "Content-Type": "application/json" };
  if (resolved.apiKey) headers.Authorization = `Bearer ${resolved.apiKey}`;

  try {
    const response = await fetch(openAICompatibleChatEndpoint(resolved.baseUrl), {
      method: "POST",
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model: resolved.model,
        ...onlineProviderOptions(resolved),
        temperature: 0,
        max_tokens: options.num_predict || 2000,
        messages
      })
    });
    if (!response.ok) {
      throw new Error(`API request failed: ${response.status} ${await response.text()}`);
    }
    const data = await response.json();
    return data?.choices?.[0]?.message?.content || "";
  } finally {
    clearTimeout(timer);
  }
}

function normalizeCleanedNote(text) {
  return stripModelNoise(text)
    .replace(/^\s*```(?:markdown|md)?\s*\n?/i, "")
    .replace(/\n?```\s*$/i, "")
    .replace(/^\s*当前完整\s*Markdown\s*笔记如下[：:]\s*/i, "")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function dedupeMarkdownNoteBlocks(markdown) {
  const source = String(markdown || "")
    .replace(/\r\n?/g, "\n")
    .replace(/\u00A0/g, " ")
    .replace(/[ \t]+$/gm, "")
    .trim();
  if (!source) return "";

  const seenBlocks = new Set();
  const chunks = splitMarkdownChunks(source);
  const cleanedChunks = [];
  for (const chunk of chunks) {
    const cleanedChunk = dedupeMarkdownChunkLines(chunk);
    const key = markdownDedupeKey(cleanedChunk);
    if (!key) continue;
    if (seenBlocks.has(key)) continue;
    seenBlocks.add(key);
    cleanedChunks.push(cleanedChunk);
  }

  return cleanedChunks
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function splitMarkdownChunks(markdown) {
  const chunks = [];
  const current = [];
  let inFence = false;

  const flush = () => {
    const chunk = current.join("\n").trim();
    current.length = 0;
    if (chunk) chunks.push(chunk);
  };

  for (const line of String(markdown || "").split("\n")) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      current.push(line);
      continue;
    }
    if (!inFence && !line.trim()) {
      flush();
      continue;
    }
    current.push(line);
  }
  flush();
  return chunks;
}

function dedupeMarkdownChunkLines(chunk) {
  if (/^\s*```/m.test(chunk)) return chunk.trim();
  const seenLines = new Set();
  return String(chunk || "")
    .split("\n")
    .filter((line) => {
      const key = markdownDedupeKey(line);
      if (!key || /^\s{2,}\S/.test(line)) return true;
      if (seenLines.has(key)) return false;
      seenLines.add(key);
      return true;
    })
    .join("\n")
    .trim();
}

function markdownDedupeKey(value) {
  return String(value || "")
    .replace(/^\s{0,3}#{1,6}\s+/, "")
    .replace(/^\s{0,3}(?:[-+*]|\d+[.)])\s+/, "")
    .replace(/^\s{0,3}>\s?/, "")
    .replace(/[*_`~[\]()#>-]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

async function generateSummaryNoteTitle(page = {}, note = "", options = {}) {
  const fallback = getWebpageTitle(page);
  const source = buildTitleSourceText(page, note);
  if (source.length < 20) return fallback;

  try {
    const raw = await chatWithConfiguredProvider(options, [
      {
        role: "system",
        content: [
          "你是网页 Markdown 笔记的标题生成器。",
          "只根据提供的网页内容总结主题，并生成适合作为文件名的简短中文标题。",
          "可使用3到6个关键词组成标题；标题要具体、有信息量，避免“文章总结”“网页笔记”等泛泛表达。",
          "不超过12个汉字。",
          "只输出标题本身，不要解释、引号、标点或 Markdown。"
        ].join("")
      },
      {
        role: "user",
        content: `页面标题：${page.title || ""}\n\n内容：\n${source}`
      }
    ], { num_predict: 40, num_ctx: 4096, timeoutMs: 12000 });
    const title = normalizeGeneratedNoteTitle(raw);
    return title || fallback;
  } catch (error) {
    console.warn("[PIT] note title generation failed", error);
    return fallback;
  }
}

function getWebpageTitle(page = {}) {
  const title = String(page.title || "")
    .replace(/\s+/g, " ")
    .trim();
  return title || "网页笔记";
}

async function buildArticleOverview(page = {}, settings = {}) {
  const isX = page.sourceType === "x" || /(^|\.)x\.com\//i.test(page.url || "") || /(^|\.)twitter\.com\//i.test(page.url || "");
  const articleText = (isX ? pageToXConversationText(page) : pageToArticleText(page)).slice(0, 18000);
  if (articleText.length < 80) throw new Error("文章内容太少，无法生成脉络。");
  const focus = String(settings.summaryPrompt || "").trim();

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
          focus ? `额外关注：${focus}。` : "",
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
  const lines = [`### **${escapeMarkdownHeading(title)}**`, ""];
  lines.push(`保存时间：${new Date().toLocaleString("zh-CN")}`, "");

  if (options.saveUrl && page.url) {
    lines.push("## 原始链接", "", page.url, "");
  }

  if (options.saveNote && note) {
    lines.push("## 我的笔记", "", note.trim(), "");
  }

  if (options.saveOriginal && page.originalSummary) {
    lines.push("## 原文总结", "", page.originalSummary.trim(), "");
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

  if (options.saveSummary && page.summary) {
    lines.push("## Ask 内容", "", page.summary.trim(), "");
  }

  if (!options.saveUrl && !options.saveSummary && !options.saveNote && !options.saveOriginal && !options.saveTranslation) {
    lines.push("> 未选择保存内容。", "");
  }

  return lines.join("\n").replace(/\n{4,}/g, "\n\n\n").trim() + "\n";
}

function cleanMarkdownForExport(markdown) {
  const cleanedLines = String(markdown || "")
    .normalize("NFKC")
    .replace(/[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFEFF\uFFA0]/g, "")
    .replace(/\uFFFC|\uFFFD/g, "")
    .replace(/\u00A0/g, " ")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .split("\n")
    .filter((line) => {
      const value = line.trim();
      if (!value) return true;
      if (/^(?:[-_*~=·•▪▫◆◇●○■□▶▷►▸→—–|]\s*){4,}$/.test(value)) return false;
      if (/^!?\[\s*]\(\s*\)$/.test(value)) return false;
      return !/^[#>*_`~=-]{1,3}$/.test(value);
    })
    .map((line) => line
      .replace(/[ \t]{2,}$/g, "")
      .replace(/([。！？!?，,；;：:])\1{2,}/g, "$1$1")
    );

  return cleanedLines
    .join("\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim() + "\n";
}

function makeMarkdownFilename(title) {
  const slug = sanitizeFilenamePart(String(title || ""))
    .replace(/\s+/g, "-")
    .slice(0, 80) || "page-note";
  return `${slug}.md`;
}

function buildMeaningfulNoteTitle(page = {}, note = "") {
  const blocks = Array.isArray(page.blocks) ? page.blocks : [];
  const contentSource = [
    note,
    page.title,
    blocks.map((block) => block.original).filter(Boolean).slice(0, 3).join(" "),
    blocks.map((block) => block.translation).filter(Boolean).slice(0, 2).join(" ")
  ].filter(Boolean).join(" ");
  const topic = summarizeTitleText(contentSource) || "网页笔记";
  return normalizeGeneratedNoteTitle(topic) || "网页笔记";
}

function buildTitleSourceText(page = {}, note = "") {
  const blocks = Array.isArray(page.blocks) ? page.blocks : [];
  return [
    page.summary,
    page.originalSummary,
    blocks.map((block) => block.original).filter(Boolean).join("\n"),
    blocks.map((block) => block.translation).filter(Boolean).join("\n"),
    note
  ].filter(Boolean).join("\n\n").slice(0, 6000);
}

function normalizeGeneratedNoteTitle(title) {
  const cleaned = stripModelNoise(title)
    .replace(/^#+\s*/gm, "")
    .replace(/^(?:标题|总结标题|文件名)\s*[:：]\s*/i, "")
    .replace(/[《》“”"'`*_#\[\](){}<>]/g, "")
    .replace(/[，。！？、；：,.!?;:|/\\]+$/g, "")
    .replace(/\s+/g, "")
    .trim();
  if (!cleaned) return "";
  const chars = Array.from(cleaned);
  return chars.slice(0, 12).join("");
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

function sanitizePathPart(value) {
  const raw = String(value || "").trim();
  if (/^(?:\/|~\/|[a-zA-Z]:[\\/])/.test(raw)) {
    throw new Error("保存目录不能填写绝对路径。请把 Chrome 下载位置设为 Obsidian 库，再在插件里填写子文件夹名，例如 WebNotes。");
  }
  const normalized = raw
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.\.+/g, "")
    .replace(/\/{2,}/g, "/");
  const cleaned = normalized
    .split("/")
    .map(sanitizeFilenamePart)
    .filter(Boolean)
    .join("/");
  return cleaned || "page-notes";
}

function sanitizeFilenamePart(value) {
  const cleaned = String(value || "")
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^\.+|\.+$/g, "")
    .trim();
  if (!cleaned || cleaned === "." || cleaned === "..") return "";
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(cleaned)) return `_${cleaned}`;
  return cleaned;
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
      content: "Translate any non-Simplified Chinese text to Simplified Chinese. Convert Traditional Chinese to Simplified Chinese. Preserve existing markdown formatting, line breaks, and paragraph breaks, but do not add new bold, italic, code, heading, or other markdown styling. Do not translate or alter PITLINK or PITTOKEN placeholders. Output only the translated text, nothing else."
    },
    {
      role: "user",
      content: text
    }
  ];
}

// 批量 JSON prompt（用于非流式批量翻译）
function buildMessages(texts) {
  return [
    {
      role: "system",
      content: "Non-Simplified Chinese→Simplified Chinese translator. Convert Traditional Chinese to Simplified Chinese. Preserve existing markdown formatting, line breaks, and paragraph breaks, but do not add new bold, italic, code, heading, or other markdown styling. Do not translate or alter PITLINK or PITTOKEN placeholders. No notes or <think> blocks. Return only compact JSON: {\"translations\":[\"...\"]}."
    },
    {
      role: "user",
      content: `Translate to Simplified Chinese, keep array length ${texts.length}:\n${JSON.stringify(texts)}`
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
    const cleaned = typeof translated === "string" ? stripModelNoise(translated) : "";
    return cleaned.trim() ? cleaned.trim() : "";
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
  let cleaned = String(content || "")
    .replace(/<think\b[^>]*>[\s\S]*?(?:<\/think>|$)/gi, "")
    .replace(/<thinking\b[^>]*>[\s\S]*?(?:<\/thinking>|$)/gi, "")
    .replace(/^\s*(?:\/?\s*no[_\s-]*think(?:ing)?|<\s*no[_\s-]*think(?:ing)?\s*\/?>)\s*[.:：。,!！,，;；-]*\s*$/gim, "")
    .replace(/^\s*(?:\/?\s*no[_\s-]*think(?:ing)?|<\s*no[_\s-]*think(?:ing)?\s*\/?>)\s*[.:：。,!！,，;；-]+\s*/i, "")
    .replace(/^\s*\/?\s*no[_\s-]*think\s+(?=\S)/i, "")
    .replace(/```(?:json)?/gi, "")
    .replace(/```/g, "")
    .trim();

  cleaned = stripLeadingReasoningBlock(cleaned);
  return cleaned.trim();
}

function getVisibleStreamDelta(content, posted) {
  if (shouldHoldLeadingControlPrefix(content)) {
    return { posted, delta: "" };
  }

  const visible = stripModelNoise(content);
  if (!visible) return { posted: "", delta: "" };

  const previous = String(posted || "");
  const delta = visible.startsWith(previous) ? visible.slice(previous.length) : visible;
  return { posted: visible, delta };
}

function shouldHoldLeadingControlPrefix(content) {
  const value = String(content || "").trimStart().toLowerCase();
  if (!value) return true;

  const markers = [
    "/no_think",
    "/no think",
    "/nothink",
    "no_think",
    "no think",
    "nothink",
    "<no_think",
    "<no think",
    "<think",
    "<thinking"
  ];

  return markers.some((marker) => marker.startsWith(value) && value.length < marker.length);
}

function stripLeadingReasoningBlock(text) {
  const value = String(text || "").trim();
  if (!value) return "";

  const finalMatch = value.match(/(?:^|\n)\s*(?:翻译|译文|结果|答案|translation|translated text|answer|final)\s*[:：]\s*/i);
  if (finalMatch && finalMatch.index !== undefined) {
    const before = value.slice(0, finalMatch.index);
    if (/^\s*(?:思考|推理|分析|reasoning|thought|thinking)\s*[:：]/i.test(before.trim())) {
      return value.slice(finalMatch.index + finalMatch[0].length);
    }
  }

  return value.replace(/^\s*(?:思考|推理|分析|reasoning|thought|thinking)\s*[:：]\s*(?:无|none|no[_\s-]*think|no thinking)?\s*[\r\n]+/i, "");
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
