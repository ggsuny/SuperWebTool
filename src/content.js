(() => {
if (window.__PIT_CONTENT_READY__) {
  return;
}
window.__PIT_CONTENT_READY__ = true;

// ─── 常量 ────────────────────────────────────────────────────
const TRANSLATION_CLASS   = "pit-translation";
const REPLACED_CLASS      = "pit-replaced";
const ASK_PANEL_CLASS     = "pit-ask-panel";
const SELECTION_TOOLBAR_CLASS = "pit-selection-toolbar";
const ORIGINAL_HTML_ATTR  = "data-pit-original-html";
const PROCESSED_ATTR      = "data-pit-processed";
const MAX_BLOCKS_PER_RUN  = 500;
const TRANSLATION_CHUNK_LENGTH = 600;
const CACHE_PREFIX        = "pit_cache_";
const NOTE_DRAFT_PREFIX   = "pit_note_draft_";
const PANEL_LAYOUT_KEY    = "pit_reader_panel_layout";
const PANEL_MIN_WIDTH     = 320;
const PANEL_MIN_HEIGHT    = 360;
const PANEL_EDGE_GAP      = 12;
const FIRST_TOKEN_TIMEOUT_MS     = 2000;
const STREAM_RENDER_INTERVAL_MS  = 40;
const OVERVIEW_TIMEOUT_MS        = 22000;
const OLLAMA_CONCURRENCY         = 1;
const ONLINE_CONCURRENCY         = 4;
const TWEET_GENERATION_TIMEOUT_MS = 45000;

const OLLAMA_PARA_TIMEOUT_MS     = 22000;  // 单段最长 22s；2s 内用等待态给用户反馈

const DEFAULT_OLLAMA = {
  provider: "ollama",
  model:    "qwen3.5:4b",
  baseUrl:  "http://localhost:11434",
  markStyle: "highlight",
  markHighlightColor: "#fff2a8",
  translationFontSize: 100,
  translationLineHeight: 1.4,
  autoOpenPanel: true
};

const BLOCK_SELECTOR = [
  '[data-testid="tweetText"]',
  'article [data-testid="tweetText"]',
  'article div[lang][dir="auto"]',
  "article p", "main p", "section p", "p",
  "article li", "main li",
  "blockquote", "figcaption", "dd", "dt", "td", "th",
  "h1", "h2", "h3", "h4", "h5", "h6"
].join(",");

const SKIP_SELECTOR = [
  "script", "style", "noscript", "svg", "canvas",
  "textarea", "input", "select", "button",
  "pre", "code", "kbd", "samp",
  "nav", "header", "footer", "aside",
  "[contenteditable='true']", "[aria-hidden='true']",
  ".pit-translation"
].join(",");

// paraId → { node, renderer, originalText }
const streamingNodes = new Map();
let lastArticleSnapshot = null;
let lastSummaryText = "";
let lastSeenUrl = location.href;
let lastMousePoint = { x: 0, y: 0 };

document.addEventListener("mouseup", (event) => {
  lastMousePoint = { x: event.clientX, y: event.clientY };
  setTimeout(showSelectionToolbar, 40);
});

document.addEventListener("mousedown", (event) => {
  if (!event.target?.closest?.(`.${SELECTION_TOOLBAR_CLASS}`)) hideSelectionToolbar();
});

setInterval(() => {
  if (lastSeenUrl === location.href) return;
  lastSeenUrl = location.href;
  document.querySelector(`.${ASK_PANEL_CLASS}`)?.remove();
  lastArticleSnapshot = null;
  lastSummaryText = "";
}, 1000);

initAutoOpenPanel();

// ─── 消息监听 ─────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "TRANSLATE_PAGE") {
    translatePage(message.settings)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err)  => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;  // 保持通道开放等待异步回包
  }

  if (message?.type === "RESTORE_PAGE") {
    if (window.__pitRun__) cancelRun(window.__pitRun__);
    restorePage();
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === "GET_PAGE_BUNDLE") {
    try {
      sendResponse({ ok: true, ...getPageBundle() });
    } catch (err) {
      sendResponse({ ok: false, error: err?.message || String(err) });
    }
    return false;
  }

  if (message?.type === "OPEN_ASK_PANEL") {
    openAskPanel(message.settings);
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === "APPEND_SELECTION_TO_NOTE") {
    const selected = normalizeSelectedText(window.getSelection()?.toString() || "");
    if (!selected) {
      const panel = openAskPanel(message.settings);
      activateReaderTab(panel, "notes");
      setPanelStatus(panel, "当前没有选中文本。");
      sendResponse({ ok: false, error: "当前没有选中文本。" });
      return false;
    }
    appendSelectionToNote(selected, message.settings);
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

// ─── 主翻译函数 ───────────────────────────────────────────────
async function translatePage(settings) {
  // 取消上一次未完成的翻译
  if (window.__pitRun__) cancelRun(window.__pitRun__);
  const run = { cancelled: false, controllers: new Set(), ports: new Set() };
  window.__pitRun__ = run;
  prewarmOllamaForSettings(settings);

  restorePage();
  streamingNodes.clear();

  const allBlocks = collectBlocks();
  if (!allBlocks.length) {
    return { translated: 0, message: "未找到适合翻译的正文段落。" };
  }
  lastArticleSnapshot = createArticleSnapshot(allBlocks);
  lastSummaryText = "";

  const style = settings.translationStyle || "bar";

  // 视口内段落排前，视口外排后
  const viewport   = [];
  const offscreen  = [];
  for (const block of allBlocks) {
    (isInViewport(block.element) ? viewport : offscreen).push(block);
  }
  const sorted = [...viewport, ...offscreen];

  // 缓存命中 → 立即渲染
  const { cachedBlocks, uncachedBlocks } = splitByCache(sorted);
  for (const { block, translation } of cachedBlocks) {
    insertTranslationNode(block, translation, settings.mode, style, settings);
  }

  // 未缓存 → 后台队列翻译。只在段落真正开始翻译时插入 DOM，避免大页面一次性重排。
  if (uncachedBlocks.length > 0) {
    streamAll(uncachedBlocks, settings, run, style)
      .then(() => {
        if (!run.cancelled) startOverviewAfterTranslation();
      })
      .catch(console.error);
  } else {
    startOverviewAfterTranslation();
  }

  return {
    translated: allBlocks.length,
    message: `已开始翻译。${cachedBlocks.length} 段来自缓存，${uncachedBlocks.length} 段流式翻译中...`
  };
}

function cancelRun(run) {
  run.cancelled = true;
  for (const controller of run.controllers || []) {
    controller.abort();
  }
  run.controllers?.clear();
  for (const port of run.ports || []) {
    port.disconnect();
  }
  run.ports?.clear();
}

// ─── 首屏优先流式翻译队列 ─────────────────────────────────────
async function streamAll(blocks, settings, run, style) {
  const resolved = { ...DEFAULT_OLLAMA, ...settings };
  const concurrency = resolved.provider === "openaiCompatible" ? ONLINE_CONCURRENCY : OLLAMA_CONCURRENCY;
  let cursor = 0;

  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (!run.cancelled && cursor < blocks.length) {
      const block = blocks[cursor];
      cursor += 1;
      if (!document.contains(block.element)) continue;
      await streamBlock(block, resolved, run, style);
    }
  }));
}

async function streamBlock(block, settings, run, style) {
  if (run.cancelled || block.element.matches(`[${PROCESSED_ATTR}]`)) return;

  const paraId = `pit_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const node = createStreamingTarget(block, settings.mode, style, settings);
  const renderer = createStreamRenderer(node, block.hasFormat);
  const linkProtection = protectLinks(block.text);
  let gotFirstToken = false;

  streamingNodes.set(paraId, { node, renderer, originalText: block.text });

  const firstTokenTimer = setTimeout(() => {
    if (!gotFirstToken && !run.cancelled && streamingNodes.has(paraId)) {
      node.dataset.state = "waiting";
      node.textContent = "模型启动中...";
    }
  }, FIRST_TOKEN_TIMEOUT_MS);

  try {
    for (const textChunk of splitTextForTranslation(linkProtection.text)) {
      if (run.cancelled) return;
      await streamOneParagraph(textChunk, settings, (chunk) => {
        if (run.cancelled) return;
        if (!gotFirstToken) {
          gotFirstToken = true;
          clearTimeout(firstTokenTimer);
          node.dataset.state = "loading";
        }
        renderer.append(restoreProtectedLinks(chunk, linkProtection.links));
      }, run);
    }

    if (run.cancelled) return;
    const finalText = restoreProtectedLinks(renderer.getText(), linkProtection.links);
    node.dataset.state = "done";
    renderer.finish(finalText);
    if (block.text && finalText) setCacheEntry(block.text, finalText);
  } catch (err) {
    if (!run.cancelled) {
      console.warn("[PIT] translation failed", err);
      node.dataset.state = "error";
      renderer.finish(renderer.getText() || humanizeStreamError(err, settings));
    }
  } finally {
    clearTimeout(firstTokenTimer);
    streamingNodes.delete(paraId);
  }
}

// ─── 单段落 Ollama 流式 fetch ─────────────────────────────────
async function streamOneParagraph(text, settings, onChunk, run) {
  return new Promise((resolve, reject) => {
    const port = chrome.runtime.connect({ name: "PIT_STREAM_TRANSLATE" });
    let settled = false;
    let accumulated = "";
    const timer = setTimeout(() => {
      finish(() => reject(new Error("API stream timeout")));
    }, OLLAMA_PARA_TIMEOUT_MS);

    function finish(callback) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      run.ports.delete(port);
      try { port.disconnect(); } catch { /* 已断开 */ }
      callback();
    }

    run.ports.add(port);

    port.onMessage.addListener((message) => {
      if (message?.type === "chunk") {
        const chunk = message.chunk || "";
        accumulated += chunk;
        onChunk(chunk);
        return;
      }

      if (message?.type === "done") {
        finish(() => resolve(stripStreamedText(message.text || accumulated)));
        return;
      }

      if (message?.type === "error") {
        finish(() => reject(new Error(message.error || "API stream failed")));
      }
    });

    port.onDisconnect.addListener(() => {
      run.ports.delete(port);
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        if (run.cancelled) resolve(stripStreamedText(accumulated));
        else reject(new Error(chrome.runtime.lastError?.message || "API stream disconnected"));
      }
    });

    port.postMessage({
      type: "START_TRANSLATION_STREAM",
      settings,
      text
    });
  });
}

// ─── DOM 工具 ─────────────────────────────────────────────────
function createStreamingNode(style, settings = {}) {
  const node = document.createElement("span");
  node.className        = TRANSLATION_CLASS;
  node.dataset.state    = "loading";
  node.dataset.pitStyle = style;
  applyTranslationTypography(node, settings);
  return node;
}

function createStreamingTarget(block, mode, style, settings = {}) {
  const node = createStreamingNode(style, settings);
  block.element.setAttribute(PROCESSED_ATTR, "true");
  removeExistingTranslationFromBlock(block.element);

  if (mode === "replace") {
    if (!block.element.hasAttribute(ORIGINAL_HTML_ATTR)) {
      block.element.setAttribute(ORIGINAL_HTML_ATTR, block.element.innerHTML);
    }
    node.classList.add(REPLACED_CLASS);
    block.element.replaceChildren(node);
  } else {
    block.element.appendChild(node);
  }

  return node;
}

function createStreamRenderer(node, hasFormat) {
  let buffer = "";
  let scheduled = false;

  function render() {
    scheduled = false;
    if (hasFormat) {
      node.innerHTML = markdownToHtml(buffer);
    } else {
      node.textContent = buffer;
    }
  }

  function scheduleRender() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => requestAnimationFrame(render), STREAM_RENDER_INTERVAL_MS);
  }

  return {
    append(chunk) {
      buffer += chunk;
      scheduleRender();
    },
    finish(finalText) {
      buffer = stripStreamedText(finalText || buffer);
      render();
    },
    getText() {
      return stripStreamedText(buffer);
    }
  };
}

function insertTranslationNode(block, translation, mode, style, settings = {}) {
  removeExistingTranslationFromBlock(block.element);
  if (mode === "replace") {
    const node = replaceBlock(block, translation);
    applyTranslationTypography(node, settings);
  } else {
    const node = createStreamingNode(style, settings);
    node.dataset.state = "done";
    if (block.hasFormat) {
      node.innerHTML = markdownToHtml(translation);
    } else {
      node.textContent = translation;
    }
    block.element.appendChild(node);
  }
  block.element.setAttribute(PROCESSED_ATTR, "true");
}

function replaceBlock(block, translation) {
  const el = block.element;
  if (!el.hasAttribute(ORIGINAL_HTML_ATTR)) {
    el.setAttribute(ORIGINAL_HTML_ATTR, el.innerHTML);
  }
  const wrapper = document.createElement("span");
  wrapper.className = REPLACED_CLASS;
  if (block.hasFormat) {
    wrapper.innerHTML = markdownToHtml(translation);
  } else {
    wrapper.textContent = translation;
  }
  el.replaceChildren(wrapper);
  return wrapper;
}

function protectLinks(text) {
  const links = [];
  const source = String(text || "");
  const protectedText = source.replace(/\[[^\]]+\]\([^)]+\)|https?:\/\/[^\s<>"')]+|www\.[^\s<>"')]+/gi, (match) => {
    const token = `PITLINK${links.length}`;
    links.push(match);
    return token;
  });
  return { text: protectedText, links };
}

function restoreProtectedLinks(text, links = []) {
  return String(text || "").replace(/PIT\s*LINK\s*(\d+)|PITLINK(\d+)/gi, (match, spacedIndex, compactIndex) => {
    const index = Number(spacedIndex || compactIndex);
    return links[index] || match;
  });
}

function applyTranslationTypography(node, settings = {}) {
  const fontSize = normalizeFontSizePercent(settings.translationFontSize);
  const lineHeight = normalizeLineHeight(settings.translationLineHeight);
  node.style.setProperty("--pit-translation-font-size", `${fontSize}%`);
  node.style.setProperty("--pit-translation-line-height", String(lineHeight));
}

function applyTranslationTypographyToPage(settings = {}) {
  document.querySelectorAll(`.${TRANSLATION_CLASS}, .${REPLACED_CLASS}`).forEach((node) => {
    applyTranslationTypography(node, settings);
  });
}

function applyMarkColorToPage(settings = {}) {
  const color = settings.markHighlightColor || DEFAULT_OLLAMA.markHighlightColor;
  document.querySelectorAll('.pit-manual-mark[data-pit-mark-style="highlight"]').forEach((node) => {
    node.style.setProperty("--pit-mark-highlight-color", color);
  });
}

function restorePage() {
  streamingNodes.clear();
  document.querySelectorAll(`.${TRANSLATION_CLASS}`).forEach((n) => n.remove());
  document.querySelectorAll(`[${ORIGINAL_HTML_ATTR}]`).forEach((el) => {
    el.innerHTML = el.getAttribute(ORIGINAL_HTML_ATTR) || "";
    el.removeAttribute(ORIGINAL_HTML_ATTR);
  });
  document.querySelectorAll(`[${PROCESSED_ATTR}]`).forEach((el) => {
    el.removeAttribute(PROCESSED_ATTR);
  });
  lastSummaryText = "";
}

function removeExistingTranslationFromBlock(element) {
  element?.querySelectorAll?.(`:scope > .${TRANSLATION_CLASS}, :scope > .${REPLACED_CLASS}`).forEach((node) => node.remove());
}

function buildArticleText(blocks) {
  return blocks
    .map((block) => block.text)
    .filter(Boolean)
    .join("\n")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 18000);
}

function createArticleSnapshot(blocks) {
  return {
    title: normalizeText(document.title),
    url: location.href,
    capturedAt: new Date().toISOString(),
    blocks: blocks.map((block) => ({
      element: block.element,
      text: block.text,
      hasFormat: block.hasFormat
    }))
  };
}

function getPageBundle() {
  const snapshot = lastArticleSnapshot?.blocks?.length
    ? lastArticleSnapshot
    : createArticleSnapshot(collectBundleBlocks());
  lastArticleSnapshot = snapshot;

  const blocks = snapshot.blocks.map((block) => ({
    original: block.text,
    translation: getTranslationForBlock(block)
  })).map((block, index) => ({
    ...block,
    role: isXPage() ? (index === 0 ? "author" : "commenter") : "content"
  }));

  return {
    title: snapshot.title || normalizeText(document.title),
    url: snapshot.url || location.href,
    sourceType: isXPage() ? "x" : "web",
    capturedAt: snapshot.capturedAt,
    summary: getAskMarkdown(document.querySelector(`.${ASK_PANEL_CLASS}`)) || lastSummaryText,
    blocks
  };
}

function getTranslationForBlock(block) {
  const cached = getCacheEntry(block.text);
  if (cached) return cached;

  const node = block.element?.querySelector?.(`.${TRANSLATION_CLASS}, .${REPLACED_CLASS}`);
  if (node?.textContent?.trim()) return translationNodeToMarkdown(node);
  return "";
}

function getVisibleSummaryText() {
  return "";
}

function translationNodeToMarkdown(node) {
  function walk(current) {
    if (current.nodeType === Node.TEXT_NODE) return current.textContent || "";
    if (!(current instanceof Element)) return "";
    const text = Array.from(current.childNodes).map(walk).join("");
    if (!current.classList.contains("pit-manual-mark")) return text;
    return wrapMarkedMarkdown(text, current.dataset.pitMarkStyle);
  }
  return normalizeTextPreserveBreaks(walk(node));
}

function wrapMarkedMarkdown(text, style) {
  const value = String(text || "").trim();
  if (!value) return "";
  if (style === "bold") return `**${value}**`;
  if (style === "italic") return `*${value}*`;
  if (style === "boldItalic") return `***${value}***`;
  if (style === "code") return `\`${value.replace(/`/g, "'")}\``;
  return `==${value}==`;
}

function getAskMarkdown(panel) {
  if (!panel) return "";
  const parts = [];
  const overview = normalizeTextPreserveBreaks(panel.querySelector(".pit-ask-overview")?.innerText || "");
  if (overview && !/正在(?:总结|读取)/.test(overview)) {
    parts.push("### 总结", "", overview);
  }
  const messages = Array.from(panel.querySelectorAll(".pit-ask-message"))
    .map((node) => {
      const role = node.classList.contains("is-user") ? "问题" : "回答";
      const body = normalizeTextPreserveBreaks(node.querySelector(".pit-ask-message-body")?.innerText || "");
      return body ? `### ${role}\n\n${body}` : "";
    })
    .filter(Boolean);
  if (messages.length) {
    parts.push("## Ask 问答", "", ...messages);
  }
  return parts.join("\n\n").trim();
}

// ─── 页面内阅读助手面板 ───────────────────────────────────────
function openAskPanel(settings = {}) {
  let panel = document.querySelector(`.${ASK_PANEL_CLASS}`);
  if (panel) {
    if (panel.dataset.pageUrl !== location.href) {
      panel.remove();
      panel = null;
    } else {
      panel.hidden = false;
      return panel;
    }
  }

  panel = document.createElement("aside");
  panel.className = ASK_PANEL_CLASS;
  panel.dataset.pageUrl = location.href;
  panel.__pitSettings = { ...DEFAULT_OLLAMA, ...settings };
  panel.innerHTML = [
    '<div class="pit-reader-header">',
    '<div><strong>页面阅读助手</strong><span class="pit-reader-status">已连接当前页面</span></div>',
    '<div class="pit-reader-header-actions"><button class="pit-panel-save-all" type="button" title="保存 Markdown" aria-label="保存 Markdown">保存</button>',
    '<button class="pit-ask-close" type="button" aria-label="关闭">×</button>',
    '</div>',
    '</div>',
    '<nav class="pit-reader-tabs" aria-label="功能">',
    '<button class="pit-reader-tab is-active" data-reader-tab="translate" type="button">🌐 翻译</button>',
    '<button class="pit-reader-tab" data-reader-tab="ask" type="button">💬 Ask</button>',
    '<button class="pit-reader-tab" data-reader-tab="tweet" type="button">✍️ 发帖</button>',
    '<button class="pit-reader-tab" data-reader-tab="notes" type="button">📝 笔记</button>',
    '<button class="pit-reader-tab" data-reader-tab="settings" type="button">⚙️ 设置</button>',
    '</nav>',
    '<section class="pit-reader-body">',
    '<div class="pit-reader-panel-section is-active" data-reader-panel="translate">',
    '<label class="pit-reader-field"><span>翻译模式</span><select class="pit-panel-mode"><option value="append">段落下方增加中文</option><option value="replace">替换原文</option></select></label>',
    '<label class="pit-reader-field"><span>译文样式</span><select class="pit-panel-style"><option value="bar">左侧竖线</option><option value="dashed-box">虚线方框</option><option value="highlight">浅色高亮</option><option value="top-line">顶部细线</option><option value="bubble">圆角气泡</option></select></label>',
    '<div class="pit-reader-actions"><button class="pit-reader-primary pit-panel-translate" type="button">翻译当前页面</button><button class="pit-reader-secondary pit-panel-restore" type="button">恢复原文</button></div>',
    '</div>',
    '<div class="pit-reader-panel-section" data-reader-panel="ask">',
    `<section class="pit-ask-overview markdown-body">${isXPage() ? "正在总结 X 内容..." : "正在读取文章脉络..."}</section>`,
    '<section class="pit-ask-messages" aria-label="对话"></section>',
    '</div>',
    '<div class="pit-reader-panel-section" data-reader-panel="tweet">',
    '<label class="pit-reader-field"><span>想表达的内容</span><textarea class="pit-tweet-source" rows="7" placeholder="输入任意语言，写下你想表达的意思"></textarea></label>',
    '<label class="pit-reader-field"><span>目标语言</span><select class="pit-tweet-language"><option value="English">English</option><option value="Simplified Chinese">简体中文</option><option value="Hindi">हिन्दी</option><option value="Spanish">Español</option><option value="French">Français</option><option value="Arabic">العربية</option><option value="Bengali">বাংলা</option><option value="Portuguese">Português</option><option value="Russian">Русский</option></select></label>',
    '<div class="pit-reader-actions"><button class="pit-reader-primary pit-tweet-generate" type="button">生成 Twitter 文案</button><button class="pit-reader-secondary pit-tweet-copy" type="button" disabled>复制结果</button></div>',
    '<div class="pit-tweet-result" aria-live="polite">生成后会显示在这里。</div>',
    '</div>',
    '<div class="pit-reader-panel-section" data-reader-panel="notes">',
    '<div class="pit-reader-field pit-note-field"><span>我的笔记 · Markdown</span><div class="pit-note-editor"><textarea class="pit-panel-note" rows="10" spellcheck="false" placeholder="支持 Markdown：# 标题、- 要点、**重点**、`代码`、[链接](url)"></textarea><div class="pit-note-render markdown-body" hidden></div></div></div>',
    '<div class="pit-reader-checks"><label><input class="pit-save-url" type="checkbox" checked> 原始链接</label><label><input class="pit-save-original" type="checkbox" checked> 网页英文</label><label><input class="pit-save-translation" type="checkbox" checked> 中文翻译</label><label><input class="pit-save-ask" type="checkbox" checked> Ask 内容</label><label><input class="pit-save-note" type="checkbox" checked> 我的笔记</label></div>',
    '</div>',
    '<div class="pit-reader-panel-section" data-reader-panel="settings">',
    '<label class="pit-reader-field"><span>翻译后端</span><select class="pit-panel-provider"><option value="ollama">本地 Ollama</option><option value="openaiCompatible">OpenAI-compatible API</option></select></label>',
    '<label class="pit-reader-field"><span>模型</span><select class="pit-panel-model-select"></select><input class="pit-panel-model-input" placeholder="qwen3.5:4b"></label>',
    '<label class="pit-reader-field"><span>API Base URL</span><input class="pit-panel-base-url" placeholder="http://localhost:11434"></label>',
    '<label class="pit-reader-field"><span>API Key</span><input class="pit-panel-api-key" type="password" placeholder="仅在线 API 需要"></label>',
    '<label class="pit-reader-field pit-reader-range-field"><span>译文字号 <strong class="pit-font-size-value">100%</strong></span><input class="pit-panel-font-size" type="range" min="80" max="130" step="1"></label>',
    '<label class="pit-reader-field pit-reader-range-field"><span>译文行距 <strong class="pit-line-height-value">1.4</strong></span><input class="pit-panel-line-height" type="range" min="1.1" max="1.9" step="0.05"></label>',
    '<label class="pit-reader-field"><span>标记样式</span><select class="pit-panel-mark-style"><option value="highlight">高亮 ==文字==</option><option value="bold">加粗 **文字**</option><option value="italic">斜体 *文字*</option><option value="boldItalic">加粗斜体 ***文字***</option><option value="code">代码 `文字`</option></select></label>',
    '<label class="pit-reader-field"><span>高亮颜色</span><input class="pit-panel-mark-color" type="color"></label>',
    '<label class="pit-reader-toggle"><input class="pit-panel-auto-open" type="checkbox"> 打开网页后自动显示操作面板</label>',
    '<label class="pit-reader-field"><span>Markdown 保存目录</span><input class="pit-panel-save-dir" placeholder="WebNotes"><small class="pit-reader-help">只能填写 Chrome 下载目录下的子文件夹，例如 WebNotes，不能填写 /Users/... 绝对路径。</small></label>',
    '</div>',
    '</section>',
    '<div class="pit-ask-composer">',
    '<textarea class="pit-ask-input" rows="1" placeholder="提问，Enter 发送"></textarea>',
    '<button class="pit-ask-send" type="button" aria-label="发送">➤</button>',
    '</div>',
    '<div class="pit-panel-resize-handle is-n" data-resize-edge="n"></div>',
    '<div class="pit-panel-resize-handle is-e" data-resize-edge="e"></div>',
    '<div class="pit-panel-resize-handle is-s" data-resize-edge="s"></div>',
    '<div class="pit-panel-resize-handle is-w" data-resize-edge="w"></div>',
    '<div class="pit-panel-resize-handle is-ne" data-resize-edge="ne"></div>',
    '<div class="pit-panel-resize-handle is-nw" data-resize-edge="nw"></div>',
    '<div class="pit-panel-resize-handle is-se" data-resize-edge="se"></div>',
    '<div class="pit-panel-resize-handle is-sw" data-resize-edge="sw"></div>'
  ].join("");

  document.body.appendChild(panel);
  hydrateReaderPanel(panel, settings);
  applySavedPanelLayout(panel).finally(() => makePanelMovableAndResizable(panel));
  isolatePanelScroll(panel);
  prewarmPanelModel(panel);
  focusWithoutPageScroll(panel.querySelector(".pit-panel-translate"));
  return panel;
}

function hydrateReaderPanel(panel, settings) {
  const close = panel.querySelector(".pit-ask-close");
  const input = panel.querySelector(".pit-ask-input");
  const send = panel.querySelector(".pit-ask-send");
  const initial = { ...DEFAULT_OLLAMA, ...settings };
  panel.querySelector(".pit-ask-composer").hidden = true;

  panel.querySelector(".pit-panel-mode").value = initial.mode || "append";
  panel.querySelector(".pit-panel-style").value = initial.translationStyle || "bar";
  panel.querySelector(".pit-panel-provider").value = initial.provider || "ollama";
  panel.querySelector(".pit-panel-model-input").value = initial.model || DEFAULT_OLLAMA.model;
  panel.querySelector(".pit-panel-base-url").value = initial.baseUrl || DEFAULT_OLLAMA.baseUrl;
  panel.querySelector(".pit-panel-api-key").value = initial.apiKey || "";
  panel.querySelector(".pit-panel-font-size").value = normalizeFontSizePercent(initial.translationFontSize);
  panel.querySelector(".pit-panel-line-height").value = normalizeLineHeight(initial.translationLineHeight);
  panel.querySelector(".pit-panel-mark-style").value = initial.markStyle || DEFAULT_OLLAMA.markStyle;
  panel.querySelector(".pit-panel-mark-color").value = normalizeColor(initial.markHighlightColor || DEFAULT_OLLAMA.markHighlightColor);
  panel.querySelector(".pit-panel-auto-open").checked = initial.autoOpenPanel !== false;
  panel.querySelector(".pit-panel-save-dir").value = initial.saveDir || "page-notes";
  updateTypographyLabels(panel);

  close.addEventListener("click", () => { panel.remove(); });
  send.addEventListener("click", () => sendPanelQuestion(panel));
  input.addEventListener("input", () => resizePanelInput(input));
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendPanelQuestion(panel);
    }
  });

  const noteInput = panel.querySelector(".pit-panel-note");
  const noteRender = panel.querySelector(".pit-note-render");
  restoreNoteDraft(panel);
  noteInput.addEventListener("input", () => persistNoteDraft(panel));
  noteInput.addEventListener("focus", () => ensureManualNotePrefix(panel));
  noteInput.addEventListener("keydown", handleMarkdownNoteKeydown);
  noteInput.addEventListener("blur", () => {
    persistNoteDraft(panel);
  });
  noteRender.addEventListener("mousedown", (event) => {
    event.preventDefault();
    editNoteMarkdown(panel);
  });

  panel.querySelectorAll(".pit-reader-tab").forEach((tab) => {
    tab.addEventListener("click", () => activateReaderTab(panel, tab.dataset.readerTab));
  });

  panel.querySelectorAll([
    ".pit-panel-mode",
    ".pit-panel-style",
    ".pit-panel-provider",
    ".pit-panel-model-select",
    ".pit-panel-model-input",
    ".pit-panel-base-url",
    ".pit-panel-api-key",
    ".pit-panel-font-size",
    ".pit-panel-line-height",
    ".pit-panel-mark-style",
    ".pit-panel-mark-color",
    ".pit-panel-auto-open",
    ".pit-panel-save-dir"
  ].join(",")).forEach((control) => {
    const update = () => {
      panel.__pitSettings = readPanelSettings(panel);
      if (control.matches(".pit-panel-font-size, .pit-panel-line-height")) {
        updateTypographyLabels(panel);
        applyTranslationTypographyToPage(panel.__pitSettings);
      }
      if (control.matches(".pit-panel-mark-color")) {
        applyMarkColorToPage(panel.__pitSettings);
      }
      persistPanelSettings(panel.__pitSettings);
    };
    control.addEventListener("input", update);
    control.addEventListener("change", () => {
      update();
      if (control.matches(".pit-panel-provider, .pit-panel-base-url")) updatePanelModelFields(panel);
    });
  });

  updatePanelModelFields(panel);

  panel.querySelector(".pit-panel-translate").addEventListener("click", async () => {
    setPanelStatus(panel, "正在翻译...");
    try {
      const result = await translatePage(readPanelSettings(panel));
      setPanelStatus(panel, result.message || "已开始翻译。");
    } catch (error) {
      setPanelStatus(panel, error?.message || String(error));
    }
  });

  panel.querySelector(".pit-panel-restore").addEventListener("click", () => {
    if (window.__pitRun__) cancelRun(window.__pitRun__);
    restorePage();
    setPanelStatus(panel, "已恢复原文。");
  });

  const saveAllButton = panel.querySelector(".pit-panel-save-all");
  saveAllButton.addEventListener("mousedown", () => {
    panel.dataset.savingNote = "true";
  });
  saveAllButton.addEventListener("click", () => savePanelMarkdown(panel));
  panel.querySelector(".pit-tweet-generate").addEventListener("click", () => generateTweetPost(panel));
  panel.querySelector(".pit-tweet-copy").addEventListener("click", () => copyTweetPost(panel));
}

function activateReaderTab(panel, target) {
  panel.querySelectorAll(".pit-reader-tab").forEach((tab) => {
    tab.classList.toggle("is-active", tab.dataset.readerTab === target);
  });
  panel.querySelectorAll(".pit-reader-panel-section").forEach((section) => {
    section.classList.toggle("is-active", section.dataset.readerPanel === target);
  });
  panel.querySelector(".pit-ask-composer").hidden = target !== "ask";
  if (target === "ask") {
    focusWithoutPageScroll(panel.querySelector(".pit-ask-input"));
    ensurePanelOverview(panel);
    scrollAskAreaToBottom(panel);
  }
}

function ensurePanelOverview(panel) {
  if (panel.dataset.overviewLoaded === "true" || panel.dataset.overviewLoading === "true") return;
  panel.dataset.overviewLoading = "true";
  loadPanelOverview(panel)
    .then(() => {
      panel.dataset.overviewLoaded = "true";
    })
    .catch((error) => {
      panel.querySelector(".pit-ask-overview").textContent = error?.message || String(error);
    })
    .finally(() => {
      panel.dataset.overviewLoading = "false";
    });
}

function startOverviewAfterTranslation() {
  const panel = document.querySelector(`.${ASK_PANEL_CLASS}`);
  if (!panel) return;
  const overview = panel.querySelector(".pit-ask-overview");
  if (overview && panel.dataset.overviewLoaded !== "true") {
    overview.textContent = isXPage() ? "正在总结 X 内容..." : "正在读取文章脉络...";
  }
  ensurePanelOverview(panel);
}

function readPanelSettings(panel) {
  const provider = panel.querySelector(".pit-panel-provider")?.value || "ollama";
  const selectedModel = provider === "ollama"
    ? panel.querySelector(".pit-panel-model-select")?.value
    : panel.querySelector(".pit-panel-model-input")?.value;
  const settings = {
    ...panel.__pitSettings,
    mode: panel.querySelector(".pit-panel-mode")?.value || "append",
    translationStyle: panel.querySelector(".pit-panel-style")?.value || "bar",
    markStyle: panel.querySelector(".pit-panel-mark-style")?.value || DEFAULT_OLLAMA.markStyle,
    markHighlightColor: normalizeColor(panel.querySelector(".pit-panel-mark-color")?.value || DEFAULT_OLLAMA.markHighlightColor),
    provider,
    model: selectedModel?.trim() || DEFAULT_OLLAMA.model,
    baseUrl: panel.querySelector(".pit-panel-base-url")?.value.trim() || DEFAULT_OLLAMA.baseUrl,
    apiKey: panel.querySelector(".pit-panel-api-key")?.value.trim() || "",
    translationFontSize: normalizeFontSizePercent(panel.querySelector(".pit-panel-font-size")?.value),
    translationLineHeight: normalizeLineHeight(panel.querySelector(".pit-panel-line-height")?.value),
    autoOpenPanel: panel.querySelector(".pit-panel-auto-open")?.checked !== false,
    saveDir: panel.querySelector(".pit-panel-save-dir")?.value.trim() || "page-notes",
    summaryPrompt: ""
  };
  panel.__pitSettings = settings;
  return settings;
}

async function updatePanelModelFields(panel) {
  const provider = panel.querySelector(".pit-panel-provider")?.value || "ollama";
  const select = panel.querySelector(".pit-panel-model-select");
  const input = panel.querySelector(".pit-panel-model-input");
  const current = panel.__pitSettings?.model || input.value || DEFAULT_OLLAMA.model;
  const isOllama = provider === "ollama";
  select.hidden = !isOllama;
  input.hidden = isOllama;
  if (!isOllama) {
    input.value = current;
    return;
  }

  select.disabled = true;
  replaceSelectOptions(select, [{ value: current, label: "正在读取 Ollama 模型..." }]);
  try {
    const response = await chrome.runtime.sendMessage({
      type: "LIST_OLLAMA_MODELS",
      baseUrl: panel.querySelector(".pit-panel-base-url")?.value.trim() || DEFAULT_OLLAMA.baseUrl
    });
    if (!response?.ok) throw new Error(response?.error || "无法读取模型列表。");
    const models = response.models || [];
    if (!models.length) {
      replaceSelectOptions(select, [{ value: current, label: "未找到本地模型" }]);
      setPanelStatus(panel, "Ollama 当前没有可用模型。");
      return;
    }
    replaceSelectOptions(select, models.map((model) => ({ value: model, label: model })));
    select.value = models.includes(current) ? current : choosePanelModel(models, current);
    panel.__pitSettings = readPanelSettings(panel);
    setPanelStatus(panel, `已读取 ${models.length} 个本地模型。`);
  } catch (error) {
    replaceSelectOptions(select, [{ value: current, label: current || "无法连接 Ollama" }]);
    setPanelStatus(panel, error?.message || String(error));
  } finally {
    select.disabled = false;
  }
}

function replaceSelectOptions(select, options) {
  select.replaceChildren(...options.map((item) => {
    const option = document.createElement("option");
    option.value = item.value;
    option.textContent = item.label;
    return option;
  }));
}

function choosePanelModel(models, preferredModel) {
  if (models.includes(preferredModel)) return preferredModel;
  return models.find((model) => /^qwen3\.5/i.test(model))
    || models.find((model) => /^qwen/i.test(model))
    || models[0];
}

function setPanelStatus(panel, text) {
  const status = panel.querySelector(".pit-reader-status");
  if (status) status.textContent = text;
}

function focusWithoutPageScroll(element) {
  if (!element?.focus) return;
  try {
    element.focus({ preventScroll: true });
  } catch {
    element.focus();
  }
}

function capturePageScrollPosition() {
  return { x: window.scrollX, y: window.scrollY };
}

function restorePageScrollPosition(position) {
  if (!position) return;
  const restore = () => window.scrollTo(position.x, position.y);
  restore();
  requestAnimationFrame(restore);
  setTimeout(restore, 0);
}

async function generateTweetPost(panel) {
  const input = panel.querySelector(".pit-tweet-source")?.value.trim() || "";
  const targetLanguage = panel.querySelector(".pit-tweet-language")?.value || "English";
  const result = panel.querySelector(".pit-tweet-result");
  const copy = panel.querySelector(".pit-tweet-copy");
  if (!input) {
    setPanelStatus(panel, "先输入想表达的内容。");
    focusWithoutPageScroll(panel.querySelector(".pit-tweet-source"));
    return;
  }

  if (result) {
    result.textContent = "正在生成...";
    result.classList.add("is-loading");
  }
  if (copy) copy.disabled = true;
  setPanelStatus(panel, "正在生成 Twitter 文案...");

  try {
    const response = await sendRuntimeMessageWithTimeout({
      type: "GENERATE_TWEET_POST",
      input,
      targetLanguage,
      settings: readPanelSettings(panel)
    }, TWEET_GENERATION_TIMEOUT_MS, "生成超时，请稍后重试或换一个更轻的本地模型。");
    if (!response?.ok) throw new Error(response?.error || "生成失败。");
    const text = normalizeTweetPost(response.text || "");
    if (result) {
      result.textContent = text || "没有生成有效内容。";
      result.classList.remove("is-loading");
    }
    if (copy) copy.disabled = !text;
    setPanelStatus(panel, text ? "已生成，可一键复制。" : "没有生成有效内容。");
  } catch (error) {
    if (result) {
      result.textContent = humanizeRuntimeError(error);
      result.classList.remove("is-loading");
    }
    setPanelStatus(panel, "Twitter 文案生成失败。");
  }
}

async function copyTweetPost(panel) {
  const text = normalizeTweetPost(panel.querySelector(".pit-tweet-result")?.textContent || "");
  if (!text || text === "生成后会显示在这里。" || text === "正在生成...") return;
  try {
    await navigator.clipboard.writeText(text);
    setPanelStatus(panel, "已复制 Twitter 文案。");
  } catch {
    setPanelStatus(panel, "复制失败，请手动选择复制。");
  }
}

async function saveAskMarkdown(panel) {
  const askMarkdown = getAskMarkdown(panel);
  if (!askMarkdown) {
    setPanelStatus(panel, "当前没有可保存的 Ask 内容。");
    return;
  }
  setPanelStatus(panel, "正在保存 Ask...");
  try {
    const settings = readPanelSettings(panel);
    const response = await sendRuntimeMessageWithTimeout({
      type: "SAVE_MARKDOWN_NOTE",
      page: { ...getPageBundle(), summary: askMarkdown },
      note: getNoteMarkdown(panel).trim(),
      options: {
        saveDir: settings.saveDir,
        saveUrl: true,
        saveOriginal: false,
        saveTranslation: false,
        saveSummary: true,
        saveNote: Boolean(getNoteMarkdown(panel).trim())
      }
    }, 30000, "保存 Ask 超时，请稍后重试。");
    if (!response?.ok) throw new Error(response?.error || "保存失败。");
    setPanelStatus(panel, `已保存：${response.filename}`);
  } catch (error) {
    setPanelStatus(panel, humanizeRuntimeError(error));
  }
}

async function savePanelMarkdown(panel) {
  panel.dataset.savingNote = "true";
  setPanelStatus(panel, "正在保存...");
  try {
    const settings = readPanelSettings(panel);
    if (isAbsoluteSavePath(settings.saveDir)) {
      setPanelStatus(panel, "保存目录只能填下载目录下的子文件夹，例如 WebNotes。");
      focusWithoutPageScroll(panel.querySelector(".pit-panel-save-dir"));
      return;
    }
    const response = await sendRuntimeMessageWithTimeout({
      type: "SAVE_MARKDOWN_NOTE",
      page: getPageBundle(),
      note: getNoteMarkdown(panel).trim(),
      options: {
        saveDir: settings.saveDir,
        saveUrl: panel.querySelector(".pit-save-url")?.checked !== false,
        saveOriginal: panel.querySelector(".pit-save-original")?.checked !== false,
        saveTranslation: panel.querySelector(".pit-save-translation")?.checked !== false,
        saveSummary: panel.querySelector(".pit-save-ask")?.checked !== false,
        saveNote: panel.querySelector(".pit-save-note")?.checked !== false
      }
    }, 30000, "保存超时，请稍后重试。");
    if (!response?.ok) throw new Error(response?.error || "保存失败。");
    clearNoteDraft(panel);
    setPanelStatus(panel, `已保存：${response.filename}`);
  } catch (error) {
    setPanelStatus(panel, humanizeRuntimeError(error));
  } finally {
    panel.dataset.savingNote = "false";
  }
}

function normalizeTweetPost(text) {
  const cleaned = String(text || "")
    .replace(/^\s*(?:Twitter|X)\s*(?:文案|post|tweet)\s*[:：-]\s*/i, "")
    .replace(/^["“”'`]+|["“”'`]+$/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const chars = Array.from(cleaned);
  return chars.length > 280 ? `${chars.slice(0, 277).join("").trimEnd()}...` : cleaned;
}

function isAbsoluteSavePath(path) {
  return /^(?:\/|~\/|[a-zA-Z]:[\\/])/.test(String(path || "").trim());
}

async function initAutoOpenPanel() {
  try {
    const settings = await chrome.storage.sync.get(DEFAULT_OLLAMA);
    if (settings.autoOpenPanel !== false) {
      openAskPanel(settings);
    }
  } catch {
    // 自动打开失败不影响手动点击插件按钮。
  }
}

function prewarmPanelModel(panel) {
  const settings = readPanelSettings(panel);
  prewarmOllamaForSettings(settings);
}

function prewarmOllamaForSettings(settings = {}) {
  if (settings.provider !== "ollama") return;
  chrome.runtime.sendMessage({
    type: "PREWARM_OLLAMA",
    settings
  }).catch(() => {
    // 预热只为缩短首段等待，不影响真正翻译。
  });
}

function isolatePanelScroll(panel) {
  const stop = (event) => event.stopPropagation();
  panel.addEventListener("wheel", stop, { passive: true });
  panel.addEventListener("touchmove", stop, { passive: true });
}

async function applySavedPanelLayout(panel) {
  try {
    const stored = await chrome.storage.local.get(PANEL_LAYOUT_KEY);
    const layout = stored?.[PANEL_LAYOUT_KEY];
    if (!layout) return;
    const width = clampNumber(layout.width, PANEL_MIN_WIDTH, Math.max(PANEL_MIN_WIDTH, window.innerWidth - PANEL_EDGE_GAP * 2));
    const height = clampNumber(layout.height, PANEL_MIN_HEIGHT, Math.max(PANEL_MIN_HEIGHT, window.innerHeight - PANEL_EDGE_GAP * 2));
    const position = clampPanelPosition(layout.left, layout.top, width, height);
    panel.style.width = `${width}px`;
    panel.style.height = `${height}px`;
    panel.style.left = `${position.left}px`;
    panel.style.top = `${position.top}px`;
    panel.style.right = "auto";
    panel.style.bottom = "auto";
  } catch {
    // 布局恢复失败时继续使用默认位置。
  }
}

function makePanelMovableAndResizable(panel) {
  const header = panel.querySelector(".pit-reader-header");
  if (!header) return;
  let drag = null;
  let resize = null;
  let resizeTimer = null;

  const resizeObserver = new ResizeObserver(() => {
    if (drag || resize) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      persistPanelLayout(panel);
    }, 160);
  });
  resizeObserver.observe(panel);

  panel.querySelectorAll(".pit-panel-resize-handle").forEach((handle) => {
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      const rect = panel.getBoundingClientRect();
      resize = {
        pointerId: event.pointerId,
        edge: handle.dataset.resizeEdge || "",
        startX: event.clientX,
        startY: event.clientY,
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height
      };
      panel.classList.add("is-resizing");
      panel.style.width = `${rect.width}px`;
      panel.style.height = `${rect.height}px`;
      panel.style.left = `${rect.left}px`;
      panel.style.top = `${rect.top}px`;
      panel.style.right = "auto";
      panel.style.bottom = "auto";
      handle.setPointerCapture?.(event.pointerId);
      event.preventDefault();
      event.stopPropagation();
    });

    handle.addEventListener("pointermove", (event) => {
      if (!resize || event.pointerId !== resize.pointerId) return;
      applyPanelResize(panel, resize, event.clientX, event.clientY);
      event.preventDefault();
    });

    const finishResize = (event) => {
      if (!resize || event.pointerId !== resize.pointerId) return;
      handle.releasePointerCapture?.(event.pointerId);
      resize = null;
      panel.classList.remove("is-resizing");
      persistPanelLayout(panel);
    };
    handle.addEventListener("pointerup", finishResize);
    handle.addEventListener("pointercancel", finishResize);
  });

  header.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    if (event.target?.closest?.("button, input, select, textarea, a, [data-reader-tab]")) return;
    const rect = panel.getBoundingClientRect();
    drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height
    };
    panel.classList.add("is-dragging");
    panel.style.width = `${rect.width}px`;
    panel.style.height = `${rect.height}px`;
    panel.style.left = `${rect.left}px`;
    panel.style.top = `${rect.top}px`;
    panel.style.right = "auto";
    panel.style.bottom = "auto";
    header.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  });

  header.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const next = clampPanelPosition(
      drag.left + event.clientX - drag.startX,
      drag.top + event.clientY - drag.startY,
      drag.width,
      drag.height
    );
    panel.style.left = `${next.left}px`;
    panel.style.top = `${next.top}px`;
  });

  const finishDrag = (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    header.releasePointerCapture?.(event.pointerId);
    drag = null;
    panel.classList.remove("is-dragging");
    persistPanelLayout(panel);
  };
  header.addEventListener("pointerup", finishDrag);
  header.addEventListener("pointercancel", finishDrag);
}

function clampPanelPosition(left, top, width, height) {
  return {
    left: clampNumber(Number(left), PANEL_EDGE_GAP, Math.max(PANEL_EDGE_GAP, window.innerWidth - width - PANEL_EDGE_GAP)),
    top: clampNumber(Number(top), PANEL_EDGE_GAP, Math.max(PANEL_EDGE_GAP, window.innerHeight - height - PANEL_EDGE_GAP))
  };
}

function persistPanelLayout(panel) {
  if (!chrome.storage?.local?.set) return;
  const rect = panel.getBoundingClientRect();
  chrome.storage.local.set({
    [PANEL_LAYOUT_KEY]: {
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      left: Math.round(rect.left),
      top: Math.round(rect.top)
    }
  }).catch(() => {});
}

function clampNumber(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function showSelectionToolbar() {
  const selection = window.getSelection();
  const text = normalizeSelectedText(selection?.toString() || "");
  if (!text || text.length < 2) {
    hideSelectionToolbar();
    return;
  }
  const anchor = selection.anchorNode instanceof Element
    ? selection.anchorNode
    : selection.anchorNode?.parentElement;
  if (anchor?.closest?.(`.${ASK_PANEL_CLASS}, .${SELECTION_TOOLBAR_CLASS}, textarea, input, select, button`)) {
    hideSelectionToolbar();
    return;
  }

  const range = selection.rangeCount ? selection.getRangeAt(0) : null;
  const rect = range?.getBoundingClientRect();
  if (!rect || (!rect.width && !rect.height)) {
    hideSelectionToolbar();
    return;
  }

  let toolbar = document.querySelector(`.${SELECTION_TOOLBAR_CLASS}`);
  if (!toolbar) {
    toolbar = document.createElement("div");
    toolbar.className = SELECTION_TOOLBAR_CLASS;
    toolbar.innerHTML = [
      '<button class="pit-selection-action is-translate" data-action="translate" type="button" aria-label="翻译选中内容" data-tooltip="翻译选中内容">',
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h9"></path><path d="M9 3v2"></path><path d="M7 5c.7 2.7 2.4 5 5 6.8"></path><path d="M12 5c-.7 2.7-2.4 5-5 6.8"></path><path d="M14 19l3.2-8 3.3 8"></path><path d="M15.2 16h4.1"></path></svg>',
      '</button>',
      '<button class="pit-selection-action is-mark" data-action="mark" type="button" aria-label="标记选中内容" data-tooltip="标记">',
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h16"></path><path d="M7 16l8.5-8.5 3 3L10 19H7z"></path><path class="pit-selection-accent" d="M14 6l3 3"></path></svg>',
      '</button>',
      '<button class="pit-selection-action is-send" data-action="note" type="button" aria-label="发送到笔记" data-tooltip="发送到笔记">',
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h14"></path><path d="M13 6l6 6-6 6"></path><path class="pit-selection-accent" d="M4 18h6"></path></svg>',
      '</button>'
    ].join("");
    toolbar.addEventListener("mousedown", (event) => event.preventDefault());
    toolbar.addEventListener("click", (event) => {
      const action = event.target?.closest?.("button")?.dataset.action;
      if (action === "translate") translateSelectionText(toolbar.dataset.selectionText || "");
      if (action === "mark") markSelectedTranslationText();
      if (action === "note") appendSelectionToNote(toolbar.dataset.selectionText || "");
    });
    document.body.appendChild(toolbar);
  }

  toolbar.dataset.selectionText = text;
  toolbar.style.left = `${Math.min(window.scrollX + lastMousePoint.x + 65, window.scrollX + window.innerWidth - 104)}px`;
  toolbar.style.top = `${Math.max(window.scrollY + lastMousePoint.y + 15, window.scrollY + 8)}px`;
  toolbar.hidden = false;
}

function hideSelectionToolbar() {
  const toolbar = document.querySelector(`.${SELECTION_TOOLBAR_CLASS}`);
  if (toolbar) toolbar.hidden = true;
}

async function translateSelectionText(text) {
  const selected = normalizeSelectedText(text);
  if (!selected || !shouldTranslateToSimplifiedChinese(selected)) {
    hideSelectionToolbar();
    return;
  }

  const settings = await getCurrentPanelSettings();
  const range = getCurrentSelectionRange();
  const target = createSelectionTranslationNode(settings);
  insertSelectionTranslationTarget(range, target);
  hideSelectionToolbar();

  const run = { cancelled: false, controllers: new Set(), ports: new Set() };
  const renderer = createStreamRenderer(target, /[*_`\[\]]/.test(selected));
  const protection = protectLinks(selected);

  try {
    for (const textChunk of splitTextForTranslation(protection.text)) {
      await streamOneParagraph(textChunk, settings, (chunk) => {
        renderer.append(restoreProtectedLinks(chunk, protection.links));
      }, run);
    }
    const finalText = restoreProtectedLinks(renderer.getText(), protection.links);
    target.dataset.state = "done";
    renderer.finish(finalText);
  } catch (error) {
    target.dataset.state = "error";
    renderer.finish(renderer.getText() || humanizeStreamError(error, settings));
  } finally {
    run.ports?.forEach((port) => port.disconnect());
    run.ports?.clear();
  }
}

async function markSelectedTranslationText() {
  const selection = window.getSelection();
  if (!selection?.rangeCount || !normalizeSelectedText(selection.toString())) {
    hideSelectionToolbar();
    return;
  }
  const range = selection.getRangeAt(0);
  const container = range.commonAncestorContainer instanceof Element
    ? range.commonAncestorContainer
    : range.commonAncestorContainer.parentElement;
  const translationRoot = container?.closest?.(`.${TRANSLATION_CLASS}, .${REPLACED_CLASS}`);
  if (!translationRoot) {
    hideSelectionToolbar();
    return;
  }
  const settings = await getCurrentPanelSettings();
  const mark = document.createElement("span");
  mark.className = "pit-manual-mark";
  mark.dataset.pitMarkStyle = settings.markStyle || DEFAULT_OLLAMA.markStyle;
  mark.style.setProperty("--pit-mark-highlight-color", settings.markHighlightColor || DEFAULT_OLLAMA.markHighlightColor);
  try {
    const content = range.extractContents();
    mark.appendChild(content);
    range.insertNode(mark);
    selection.removeAllRanges();
    setPanelStatus(document.querySelector(`.${ASK_PANEL_CLASS}`), "已标记选中译文。");
  } catch {
    setPanelStatus(document.querySelector(`.${ASK_PANEL_CLASS}`), "这段内容暂时无法标记。");
  } finally {
    hideSelectionToolbar();
  }
}

async function getCurrentPanelSettings() {
  const panel = document.querySelector(`.${ASK_PANEL_CLASS}`);
  if (panel) return readPanelSettings(panel);
  const stored = await chrome.storage.sync.get(DEFAULT_OLLAMA);
  return { ...DEFAULT_OLLAMA, ...stored };
}

function getCurrentSelectionRange() {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return null;
  return selection.getRangeAt(0).cloneRange();
}

function createSelectionTranslationNode(settings) {
  const node = createStreamingNode(settings.translationStyle || "bar", settings);
  node.dataset.state = "loading";
  node.textContent = "正在翻译选中内容...";
  return node;
}

function insertSelectionTranslationTarget(range, target) {
  if (!range) {
    document.body.appendChild(target);
    return;
  }
  const container = range.commonAncestorContainer instanceof Element
    ? range.commonAncestorContainer
    : range.commonAncestorContainer.parentElement;
  const block = container?.closest?.("p, li, blockquote, article, section, div") || container;
  if (block instanceof HTMLElement) {
    block.appendChild(target);
  } else {
    range.collapse(false);
    range.insertNode(target);
  }
}

function appendSelectionToNote(text, settings = undefined) {
  const selected = normalizeSelectedText(text);
  if (!selected) return;
  const scrollPosition = capturePageScrollPosition();
  const panel = openAskPanel(settings);
  activateReaderTab(panel, "notes");
  const input = panel.querySelector(".pit-panel-note");
  panel.dataset.appendingSelection = "true";
  editNoteMarkdown(panel);
  const summary = selected
    .split(/\n+/)
    .map((line) => `- *${escapeMarkdownInline(normalizeText(line))}*`)
    .join("\n");
  panel.dataset.appendingSelection = "false";
  const insertion = `${input.value.trim() ? "\n\n" : ""}${summary}\n`;
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  input.value = `${input.value.slice(0, start)}${insertion}${input.value.slice(end)}`;
  input.selectionStart = input.selectionEnd = start + insertion.length;
  focusWithoutPageScroll(input);
  persistNoteDraft(panel);
  setPanelStatus(panel, "已发送到笔记，草稿已自动保存。");
  hideSelectionToolbar();
  restorePageScrollPosition(scrollPosition);
}

function normalizeSelectedText(text) {
  return String(text || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

function persistPanelSettings(settings) {
  const store = chrome.storage?.sync;
  if (!store?.set) return;
  store.set({
    provider: settings.provider,
    mode: settings.mode,
    translationStyle: settings.translationStyle,
    markStyle: settings.markStyle,
    markHighlightColor: settings.markHighlightColor,
    model: settings.model,
    baseUrl: settings.baseUrl,
    apiKey: settings.apiKey,
    translationFontSize: settings.translationFontSize,
    translationLineHeight: settings.translationLineHeight,
    autoOpenPanel: settings.autoOpenPanel,
    saveDir: settings.saveDir
  }).catch(() => {
    // 页面内面板的设置保存失败不影响当前页面操作。
  });
}

function applyPanelResize(panel, state, clientX, clientY) {
  const dx = clientX - state.startX;
  const dy = clientY - state.startY;
  const edge = state.edge;
  let left = state.left;
  let top = state.top;
  let width = state.width;
  let height = state.height;

  if (edge.includes("e")) {
    width = clampNumber(state.width + dx, PANEL_MIN_WIDTH, window.innerWidth - state.left - PANEL_EDGE_GAP);
  }
  if (edge.includes("s")) {
    height = clampNumber(state.height + dy, PANEL_MIN_HEIGHT, window.innerHeight - state.top - PANEL_EDGE_GAP);
  }
  if (edge.includes("w")) {
    const maxLeft = state.left + state.width - PANEL_MIN_WIDTH;
    left = clampNumber(state.left + dx, PANEL_EDGE_GAP, maxLeft);
    width = state.width + state.left - left;
  }
  if (edge.includes("n")) {
    const maxTop = state.top + state.height - PANEL_MIN_HEIGHT;
    top = clampNumber(state.top + dy, PANEL_EDGE_GAP, maxTop);
    height = state.height + state.top - top;
  }

  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;
  panel.style.width = `${width}px`;
  panel.style.height = `${height}px`;
  panel.style.right = "auto";
  panel.style.bottom = "auto";
}

function updateTypographyLabels(panel) {
  const fontSize = normalizeFontSizePercent(panel.querySelector(".pit-panel-font-size")?.value);
  const lineHeight = normalizeLineHeight(panel.querySelector(".pit-panel-line-height")?.value);
  const fontLabel = panel.querySelector(".pit-font-size-value");
  const lineLabel = panel.querySelector(".pit-line-height-value");
  if (fontLabel) fontLabel.textContent = `${fontSize}%`;
  if (lineLabel) lineLabel.textContent = String(lineHeight);
}

function handleMarkdownNoteKeydown(event) {
  if (event.key !== "Tab") return;
  event.preventDefault();
  const input = event.currentTarget;
  const start = input.selectionStart;
  const end = input.selectionEnd;
  const insertion = "  ";
  input.value = `${input.value.slice(0, start)}${insertion}${input.value.slice(end)}`;
  input.selectionStart = input.selectionEnd = start + insertion.length;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function getNoteMarkdown(panel) {
  return panel.querySelector(".pit-panel-note")?.value || "";
}

function ensureManualNotePrefix(panel) {
  if (panel.dataset.appendingSelection === "true") return;
  const input = panel.querySelector(".pit-panel-note");
  if (!input || input.value.trim()) return;
  input.value = "# ";
  input.selectionStart = input.selectionEnd = input.value.length;
  persistNoteDraft(panel);
}

async function restoreNoteDraft(panel) {
  const input = panel.querySelector(".pit-panel-note");
  if (!input) return;
  try {
    const keys = getNoteDraftKeys();
    const stored = await chrome.storage.local.get(keys);
    const draft = keys.map((key) => stored[key]).find(Boolean);
    if (draft && !input.value) {
      input.value = draft;
      setPanelStatus(panel, "已恢复未保存的笔记草稿。");
    }
  } catch {
    // 草稿恢复失败不影响正常使用。
  }
}

function persistNoteDraft(panel) {
  const note = getNoteMarkdown(panel);
  const entries = Object.fromEntries(getNoteDraftKeys().map((key) => [key, note]));
  if (!chrome.storage?.local?.set) return;
  chrome.storage.local.set(entries).catch(() => {
    // 自动草稿失败时不打断编辑。
  });
}

function clearNoteDraft(panel) {
  chrome.storage?.local?.remove?.(getNoteDraftKeys()).catch(() => {});
  const input = panel.querySelector(".pit-panel-note");
  if (input) input.value = "";
  const render = panel.querySelector(".pit-note-render");
  if (render) {
    render.hidden = true;
    render.innerHTML = "";
  }
}

function getNoteDraftKeys() {
  const canonicalUrl = getCanonicalDraftUrl();
  const titleKey = normalizeText(document.title || "");
  return [
    `${NOTE_DRAFT_PREFIX}${hashText(location.href)}`,
    `${NOTE_DRAFT_PREFIX}${hashText(canonicalUrl)}`,
    titleKey ? `${NOTE_DRAFT_PREFIX}title_${hashText(`${location.origin}${location.pathname}:${titleKey}`)}` : ""
  ].filter(Boolean);
}

function getCanonicalDraftUrl() {
  try {
    const url = new URL(location.href);
    url.hash = "";
    url.search = "";
    return url.toString();
  } catch {
    return location.href.split("#")[0].split("?")[0];
  }
}

function renderNoteMarkdown(panel) {
  if (panel.dataset.savingNote === "true") return;
  const input = panel.querySelector(".pit-panel-note");
  const render = panel.querySelector(".pit-note-render");
  if (!input || !render) return;
  const markdown = input.value.trim();
  if (!markdown) return;
  render.innerHTML = renderMiniMarkdown(markdown);
  input.hidden = true;
  render.hidden = false;
}

function editNoteMarkdown(panel) {
  const input = panel.querySelector(".pit-panel-note");
  const render = panel.querySelector(".pit-note-render");
  if (!input || !render) return;
  render.hidden = true;
  input.hidden = false;
  focusWithoutPageScroll(input);
}

function escapeMarkdownInline(text) {
  return String(text || "").replace(/([\\*_`[\]])/g, "\\$1");
}

function normalizeFontSizePercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_OLLAMA.translationFontSize;
  return Math.min(130, Math.max(80, Math.round(number)));
}

function normalizeLineHeight(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_OLLAMA.translationLineHeight;
  return Math.min(1.9, Math.max(1.1, Math.round(number * 100) / 100));
}

function normalizeColor(value) {
  const text = String(value || "").trim();
  return /^#[0-9a-fA-F]{6}$/.test(text) ? text : DEFAULT_OLLAMA.markHighlightColor;
}

async function loadPanelOverview(panel) {
  const page = getPageBundle();
  const response = await sendRuntimeMessageWithTimeout({
    type: "BUILD_ARTICLE_OVERVIEW",
    page,
    settings: readPanelSettings(panel)
  }, OVERVIEW_TIMEOUT_MS, "文章脉络生成超时，请稍后重试或切换更小的本地模型。");
  if (!response?.ok) throw new Error(response?.error || "生成文章脉络失败。");
  panel.querySelector(".pit-ask-overview").innerHTML = renderMiniMarkdown(response.overview || "文章脉络为空。");
  scrollAskAreaToTop(panel);
}

function sendRuntimeMessageWithTimeout(message, timeoutMs, timeoutMessage) {
  let timer = null;
  return Promise.race([
    safeRuntimeMessage(message),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
    })
  ]).finally(() => clearTimeout(timer));
}

function safeRuntimeMessage(message) {
  try {
    return chrome.runtime.sendMessage(message);
  } catch (error) {
    return Promise.reject(error);
  }
}

function humanizeRuntimeError(error) {
  const message = error?.message || String(error);
  if (/Extension context invalidated/i.test(message)) {
    return "扩展刚刚重新加载，当前页面连接已失效。请刷新网页后再试。";
  }
  return message;
}

async function sendPanelQuestion(panel) {
  const input = panel.querySelector(".pit-ask-input");
  const question = input.value.trim();
  if (!question) return;

  appendPanelMessage(panel, "user", question);
  input.value = "";
  resizePanelInput(input);
  const pending = appendPanelMessage(panel, "assistant", "正在思考...");

  try {
    const response = await chrome.runtime.sendMessage({
      type: "ASK_ARTICLE",
      page: getPageBundle(),
      question,
      allowWebSearch: true,
      settings: readPanelSettings(panel)
    });
    if (!response?.ok) throw new Error(response?.error || "回答失败。");
    pending.querySelector(".pit-ask-message-body").innerHTML = renderMiniMarkdown(response.answer || "没有得到回答。");
    scrollAskAreaToBottom(panel);
  } catch (error) {
    pending.querySelector(".pit-ask-message-body").textContent = error?.message || String(error);
    scrollAskAreaToBottom(panel);
  }
}

function appendPanelMessage(panel, role, text) {
  const messages = panel.querySelector(".pit-ask-messages");
  const node = document.createElement("div");
  node.className = `pit-ask-message is-${role}`;
  const label = document.createElement("div");
  label.className = "pit-ask-message-label";
  label.textContent = role === "user" ? "你" : "助手";
  const body = document.createElement("div");
  body.className = "pit-ask-message-body markdown-body";
  body.innerHTML = role === "assistant" ? renderMiniMarkdown(text) : escapeHtml(text);
  node.append(label, body);
  messages.appendChild(node);
  scrollAskAreaToBottom(panel);
  return node;
}

function resizePanelInput(input) {
  input.style.height = "auto";
  input.style.height = `${Math.min(84, Math.max(30, input.scrollHeight))}px`;
}

function scrollAskAreaToBottom(panel) {
  const area = panel.querySelector('.pit-reader-panel-section[data-reader-panel="ask"]');
  if (area) area.scrollTop = area.scrollHeight;
}

function scrollAskAreaToTop(panel) {
  const area = panel.querySelector('.pit-reader-panel-section[data-reader-panel="ask"]');
  if (area) area.scrollTop = 0;
}

function renderMiniMarkdown(markdown) {
  const lines = String(markdown || "").split("\n");
  const html = [];
  let unordered = [];
  let ordered = [];

  function flushUnordered() {
    if (!unordered.length) return;
    html.push(`<ul>${unordered.map((item) => `<li>${renderInlineMiniMarkdown(escapeHtml(item))}</li>`).join("")}</ul>`);
    unordered = [];
  }

  function flushOrdered() {
    if (!ordered.length) return;
    html.push(`<ol>${ordered.map((item) => `<li>${renderInlineMiniMarkdown(escapeHtml(item))}</li>`).join("")}</ol>`);
    ordered = [];
  }

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      flushUnordered();
      flushOrdered();
      continue;
    }

    const bullet = line.match(/^[-*]\s+(.+)$/);
    if (bullet) {
      flushOrdered();
      unordered.push(bullet[1]);
      continue;
    }

    const number = line.match(/^\d+[\.)]\s+(.+)$/);
    if (number) {
      flushUnordered();
      ordered.push(number[1]);
      continue;
    }

    flushUnordered();
    flushOrdered();
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      const level = Math.min(3, heading[1].length);
      html.push(`<h${level}>${renderInlineMiniMarkdown(escapeHtml(heading[2]))}</h${level}>`);
    } else {
      html.push(`<p>${renderInlineMiniMarkdown(escapeHtml(line))}</p>`);
    }
  }

  flushUnordered();
  flushOrdered();
  return html.join("");
}

function renderInlineMiniMarkdown(text) {
  return text
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

function escapeHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function normalizeSummary(summary) {
  const cleaned = stripStreamedText(summary)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return cleaned || "这篇文章没有足够内容可总结。";
}

function humanizeSummaryError(error) {
  const message = error?.message || String(error);
  if (message.includes("Failed to fetch") || message.includes("无法连接")) {
    return "无法连接本地 Ollama，暂时不能生成总结。";
  }
  if (message.includes("not found")) {
    return "本地总结模型未安装，请确认 Ollama 模型可用。";
  }
  return `总结失败：${message.slice(0, 80)}`;
}

// ─── 格式转换（HTML ↔ Markdown）──────────────────────────────
function hasFormatting(element) {
  return element.querySelector("strong, b, em, i, u, code, a") !== null;
}

function htmlToMarkdown(html) {
  return normalizeText(
    html
      .replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, "**$1**")
      .replace(/<b[^>]*>([\s\S]*?)<\/b>/gi,           "**$1**")
      .replace(/<em[^>]*>([\s\S]*?)<\/em>/gi,         "*$1*")
      .replace(/<i[^>]*>([\s\S]*?)<\/i>/gi,           "*$1*")
      .replace(/<u[^>]*>([\s\S]*?)<\/u>/gi,           "_$1_")
      .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi,     "`$1`")
      .replace(/<a\s+[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)")
      .replace(/<[^>]+>/g, "")
  );
}

function markdownToHtml(md) {
  return md
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.*?)\*/g,     "<em>$1</em>")
    .replace(/_(.*?)_/g,       "<u>$1</u>")
    .replace(/`(.*?)`/g,       "<code>$1</code>")
    .replace(/\[(.*?)\]\((.*?)\)/g, '<a href="$2" target="_blank">$1</a>');
}

// ─── 段落收集 ─────────────────────────────────────────────────
function collectBlocks() {
  const seen = new Set();
  return Array.from(document.querySelectorAll(BLOCK_SELECTOR))
    .filter((el) => {
      if (seen.has(el)) return false;
      seen.add(el);
      return isCandidateBlock(el);
    })
    .map((el) => {
      const hasFormat = hasFormatting(el);
      const text      = hasFormat ? htmlToMarkdown(el.innerHTML) : normalizeTextPreserveBreaks(el.innerText);
      return { element: el, text, hasFormat };
    })
    .filter((item) => shouldTranslateToSimplifiedChinese(item.text))
    .slice(0, MAX_BLOCKS_PER_RUN);
}

function collectBundleBlocks() {
  const seen = new Set();
  return Array.from(document.querySelectorAll(BLOCK_SELECTOR))
    .filter((el) => {
      if (seen.has(el)) return false;
      seen.add(el);
      return isBundleCandidateBlock(el);
    })
    .map((el) => {
      const text = extractOriginalTextForBundle(el);
      return { element: el, text, hasFormat: hasFormatting(el) };
    })
    .filter((item) => shouldTranslateToSimplifiedChinese(item.text))
    .slice(0, MAX_BLOCKS_PER_RUN);
}

function isCandidateBlock(el) {
  if (!(el instanceof HTMLElement))     return false;
  if (el.closest(SKIP_SELECTOR))        return false;
  if (el.matches(`[${PROCESSED_ATTR}]`)) return false;
  if (!isVisible(el))                   return false;

  const text = normalizeText(el.innerText);
  if (!text || text.length < 8)         return false;
  if (el.querySelector(`.${TRANSLATION_CLASS}`)) return false;

  const rect = el.getBoundingClientRect();
  if (rect.width < 40 || rect.height < 6) return false;

  return true;
}

function isBundleCandidateBlock(el) {
  if (!(el instanceof HTMLElement)) return false;
  if (el.closest("script, style, noscript, svg, canvas, textarea, input, select, button, pre, code, kbd, samp, nav, header, footer, aside, [contenteditable='true'], [aria-hidden='true']")) return false;
  if (!isVisible(el)) return false;

  const text = extractOriginalTextForBundle(el);
  if (!text || text.length < 8) return false;

  const rect = el.getBoundingClientRect();
  if (rect.width < 40 || rect.height < 6) return false;

  return true;
}

function extractOriginalTextForBundle(el) {
  if (el.hasAttribute(ORIGINAL_HTML_ATTR)) {
    return htmlToMarkdown(el.getAttribute(ORIGINAL_HTML_ATTR) || "");
  }

  const clone = el.cloneNode(true);
  clone.querySelectorAll(`.${TRANSLATION_CLASS}, .${REPLACED_CLASS}`).forEach((node) => node.remove());
  return hasFormatting(el) ? htmlToMarkdown(clone.innerHTML) : normalizeTextPreserveBreaks(clone.innerText || clone.textContent);
}

function isInViewport(el) {
  const rect = el.getBoundingClientRect();
  const vh   = window.innerHeight || document.documentElement.clientHeight;
  return rect.bottom >= 0 && rect.top <= vh + 300;
}

function isXPage() {
  return /(^|\.)x\.com$/i.test(location.hostname) || /(^|\.)twitter\.com$/i.test(location.hostname);
}

// ─── 缓存 ────────────────────────────────────────────────────
function getCacheEntry(text) {
  return getSessionValue(CACHE_PREFIX + hashText(text));
}
function setCacheEntry(text, translation) {
  setSessionValue(CACHE_PREFIX + hashText(text), translation);
}
function getSessionValue(key) {
  try   { return sessionStorage.getItem(key) || null; }
  catch { return null; }
}
function setSessionValue(key, value) {
  try   { sessionStorage.setItem(key, value); }
  catch { /* 忽略 quota 错误 */ }
}
function hashText(text) {
  let h = 5381;
  for (let i = 0; i < Math.min(text.length, 512); i++) {
    h = ((h << 5) + h) ^ text.charCodeAt(i);
    h >>>= 0;
  }
  return h.toString(36);
}
function splitByCache(blocks) {
  const cached = [], uncached = [];
  for (const b of blocks) {
    const hit = getCacheEntry(b.text);
    if (hit) cached.push({ block: b, translation: hit });
    else     uncached.push(b);
  }
  return { cachedBlocks: cached, uncachedBlocks: uncached };
}

// ─── 文本工具 ────────────────────────────────────────────────
function normalizeText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function normalizeTextPreserveBreaks(text) {
  return String(text || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
function shouldTranslateToSimplifiedChinese(text) {
  const value = normalizeText(text);
  if (value.length < 4) return false;
  if (isMostlyNonContent(value)) return false;
  if (hasTraditionalChineseSignal(value)) return true;
  return !isLikelySimplifiedChinese(value);
}

function isLikelySimplifiedChinese(text) {
  const readableText = stripSocialNoise(text);
  const cjk = readableText.match(/[\u3400-\u9fff]/g)?.length || 0;
  if (cjk < 4) return false;
  const latin = readableText.match(/[A-Za-z]/g)?.length || 0;
  const kana = readableText.match(/[\u3040-\u30ff]/g)?.length || 0;
  const hangul = readableText.match(/[\uac00-\ud7af]/g)?.length || 0;
  const traditionalSignals = readableText.match(/[繁體臺灣香港澳門資訊資料軟體網絡後臺裏裡徵證話說讀寫開關閉門頁麵風雲龍萬與專業嚴復雜雜誌廣告發現發佈質量點擊選擇這個那個為什麼麼]/g)?.length || 0;
  const simplifiedSignals = readableText.match(/[简体台湾澳门信息资料软件网络后台里征证话说读写开关闭门页面风云龙万与专业严复杂杂志广告发现发布质量点击选择这个那个为什么么]/g)?.length || 0;
  const totalLanguageChars = cjk + latin + kana + hangul;
  if (!totalLanguageChars) return false;
  if (kana || hangul) return false;
  if (traditionalSignals > simplifiedSignals) return false;
  return cjk / totalLanguageChars >= 0.5;
}

function hasTraditionalChineseSignal(text) {
  const readableText = stripSocialNoise(text);
  const cjk = readableText.match(/[\u3400-\u9fff]/g)?.length || 0;
  if (cjk < 4) return false;
  const traditionalOnly = readableText.match(/[與專業嚴複雜雜誌廣發佈臺灣資訊資料軟體網絡後臺裏裡徵證話說讀寫開關閉門頁麵風雲龍萬為這個這些這裡那裡甚麼什麼麼於並從來過對時會還讓給無當點擊選擇處理應該問題實際開始結束內容標題學習瀏覽器插件翻譯筆記總結設置啟動啟用顯示隱藏保存檔案連結輸入輸出簡體繁體轉換優化速度質量線條寬度頁籤預覽閱讀對話發送複製獲取雲端同步]/g)?.length || 0;
  const simplifiedOnly = readableText.match(/[与专业严复杂杂志广发布台湾信息资料软件网络后台里征证话说读写开关闭门页面风云龙万为这个这些这里那里甚么什么么于并从来来过对时会还让给无当点击选择处理应该问题实际开始结束内容标题学习浏览器插件翻译笔记总结设置启动启用显示隐藏保存档案链接输入输出简体繁体转换优化速度质量线条宽度页签预览阅读对话发送复制获取云端同步]/g)?.length || 0;
  return traditionalOnly > simplifiedOnly;
}

function stripSocialNoise(text) {
  return normalizeText(text)
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/www\.\S+/gi, " ")
    .replace(/[@#][\w.-]+/g, " ")
    .replace(/\b(?:RT|via)\b/gi, " ");
}

function isMostlyNonContent(text) {
  const languageChars = text.match(/[A-Za-z\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/g)?.length || 0;
  if (languageChars < 3) return true;
  if (/^(https?:\/\/|www\.|@[\w.-]+$|#[\w.-]+$)/i.test(text)) return true;
  return languageChars / text.length < 0.28;
}
function isVisible(el) {
  const s = window.getComputedStyle(el);
  if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) return false;
  return Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
}

function splitTextForTranslation(text) {
  const source = normalizeTextPreserveBreaks(text);
  if (source.length <= TRANSLATION_CHUNK_LENGTH) return [source];

  const parts = [];
  const sentencePattern = /[^.!?。！？;；]+[.!?。！？;；”’"')\]]*\s*|[^.!?。！？;；]+$/g;
  const sentences = source.match(sentencePattern) || [source];
  let current = "";

  for (const sentence of sentences) {
    const next = `${current}${sentence}`.trim();
    if (next.length <= TRANSLATION_CHUNK_LENGTH) {
      current = `${current}${sentence}`;
      continue;
    }

    if (current.trim()) parts.push(current.trim());

    if (sentence.length > TRANSLATION_CHUNK_LENGTH) {
      parts.push(...splitLongText(sentence.trim(), TRANSLATION_CHUNK_LENGTH));
      current = "";
    } else {
      current = sentence;
    }
  }

  if (current.trim()) parts.push(current.trim());
  return parts.filter(Boolean);
}

function splitLongText(text, maxLength) {
  const parts = [];
  for (let start = 0; start < text.length; start += maxLength) {
    parts.push(text.slice(start, start + maxLength).trim());
  }
  return parts.filter(Boolean);
}

function stripStreamedText(content) {
  return String(content || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/```(?:json)?/gi, "")
    .replace(/```/g, "")
    .trim();
}

function humanizeStreamError(error, settings) {
  const message = error?.name === "AbortError"
    ? "请求超时"
    : (error?.message || String(error));

  if (message.includes("Failed to fetch")) {
    return settings.provider === "ollama"
      ? "无法连接 Ollama，请确认 ollama serve 正在运行"
      : "无法连接在线翻译 API";
  }

  if (message.includes("403")) {
    return "Ollama 拒绝了扩展请求，请检查 OLLAMA_ORIGINS";
  }

  if (message.includes("timeout") || message.includes("请求超时")) {
    return "模型响应超时，请重试、重启 Ollama 或换更小模型";
  }

  return `翻译失败：${message.slice(0, 120)}`;
}
})();
