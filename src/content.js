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
const PDF_SECTION_CLASS   = "pit-pdf-content";
const PDF_BLOCK_CLASS     = "pit-pdf-block";
const ORIGINAL_HTML_ATTR  = "data-pit-original-html";
const PROCESSED_ATTR      = "data-pit-processed";
const EMPTY_PARAGRAPH_ATTR = "data-pit-empty-paragraph";
const PDF_SOURCE_ATTR     = "data-pit-pdf-source";
const MAX_BLOCKS_PER_RUN  = 500;
const MAX_PDFS_PER_PAGE   = 3;
const MAX_PDF_PARAGRAPHS_PER_FILE = 120;
const TRANSLATION_CHUNK_LENGTH = 600;
const SHORT_TEXT_REPLACE_MAX_WORDS = 4;
const MISSING_TRANSLATION_MIN_WORDS = 10;
const MAX_TRANSLATION_ATTEMPTS = 3;
const MAX_MISSING_TRANSLATION_PASSES = 5;
const PROTECTED_INLINE_TOKEN_PATTERN = /(?<![\p{L}\p{N}_])(?:[@#][\p{L}\p{N}_][\p{L}\p{N}_.-]{0,63}|\$[A-Za-z][A-Za-z0-9._-]{0,15}|[A-Z]{2,8}\/[A-Z]{2,8}|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})(?![\p{L}\p{N}_])/gu;
const COMMON_UNTRANSLATED_TERM_PATTERN = /\b(?:ETF|ETFs|SPY|QQQ|DIA|IWM|VIX|CPI|PCE|FOMC|Fed|GDP|CME|NYSE|NASDAQ|IPO|EPS|PE|P\/E|AI|API|GPU|CPU|LLM|SaaS|BTC|ETH|SOL|USDT|USDC|DeFi|NFT|Bearish|Bullish|Triple\s+Witching)\b/giu;
const CACHE_PREFIX        = "pit_cache_";
const NOTE_DRAFT_PREFIX   = "pit_note_draft_";
const HOVER_NOTE_PROMPT   = "- 记一下";
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
const DEV_RELOAD_POLL_MS = 1200;

const OLLAMA_PARA_TIMEOUT_MS     = 22000;  // 单段最长 22s；2s 内用等待态给用户反馈

const DEFAULT_OLLAMA = {
  provider: "ollama",
  providerConfigs: {},
  model:    "qwen3.5:4b",
  baseUrl:  "http://localhost:11434",
  markStyle: "highlight",
  markHighlightColor: "#fff2a8",
  markHighlightColorLight: "#fff2a8",
  markHighlightColorDark: "#facc15",
  translationFontSize: 100,
  translationLineHeight: 1.4,
  noteSaveShortcut: "enter",
  shortTextReplaceMode: false,
  autoOpenPanel: false,
  summaryPrompt: "",
  allowWebSearch: true,
  localQaUrl: "http://localhost:3218",
  localQaNotesDir: ""
};

const BLOCK_SELECTOR = [
  '[data-testid="tweetText"]',
  'article [data-testid="tweetText"]',
  'article div[lang][dir="auto"]',
  "article", "main", '[role="main"]', "main article", "main section",
  "article p", "main p", "section p", "p",
  "article li", "main li", "article span[lang]", "main span[lang]",
  "blockquote", "figcaption", "dd", "dt", "td", "th",
  `.${PDF_BLOCK_CLASS}`,
  "h1", "h2", "h3", "h4", "h5", "h6"
].join(",");

const PARAGRAPH_BOUNDARY_TAGS = new Set([
  "ARTICLE", "ASIDE", "BLOCKQUOTE", "DD", "DETAILS", "DIV", "DL", "DT",
  "FIGCAPTION", "FIGURE", "FOOTER", "H1", "H2", "H3", "H4", "H5", "H6",
  "HEADER", "LI", "MAIN", "OL", "P", "PRE", "SECTION", "TABLE", "TBODY",
  "TD", "TFOOT", "TH", "THEAD", "TR", "UL"
]);

const TEXT_FALLBACK_CONTAINER_SELECTOR = [
  "p", "li", "blockquote", "figcaption", "dd", "dt", "td", "th",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "div"
].join(",");

const INLINE_TEXT_OWNER_SELECTOR = "span, a, strong, b, em, i, u, small, mark, time, cite, label";

const SKIP_SELECTOR = [
  "script", "style", "noscript", "svg", "canvas",
  "textarea", "input", "select", "button",
  "pre", "code", "kbd", "samp",
  "nav", "header", "footer", "aside",
  "[contenteditable='true']", "[aria-hidden='true']",
  ".pit-translation"
].join(",");

const CONTENT_NOISE_SELECTOR = [
  "nav", "header", "footer", "aside", "button", "input", "select", "textarea",
  "[role='navigation']", "[role='banner']", "[role='contentinfo']", "[role='complementary']",
  "[role='button']", "[aria-hidden='true']", "[hidden]",
  ".nav", ".navbar", ".navigation", ".menu", ".sidebar", ".footer", ".header",
  ".breadcrumb", ".breadcrumbs", ".pagination", ".pager", ".toolbar",
  ".share", ".sharing", ".social", ".social-share", ".related", ".recommend",
  ".recommendations", ".comments", ".comment-form", ".newsletter", ".subscribe",
  ".advertisement", ".advert", ".ads", ".ad", "[class*='cookie']", "[id*='cookie']",
  "[class*='paywall']", "[class*='promo']", "[class*='share']"
].join(",");

// paraId → { node, renderer, originalText }
const streamingNodes = new Map();
let translationAttemptCounts = new WeakMap();
let lastArticleSnapshot = null;
let lastSummaryText = "";
let lastNoteTitle = "";
let lastOriginalSummary = "";
let originalSummaryPromise = null;
let lastSeenUrl = location.href;
let lastMousePoint = { x: 0, y: 0 };
let hoverNoteCommandPressed = false;
let hasHoverNotePointer = false;
let lastDetectedPageTheme = "";
let lastPageSelection = null;
let lastKnownSettings = { ...DEFAULT_OLLAMA };
let pdfExtractorFramePromise = null;
let hoverNoteTarget = null;
let hoverNoteComposer = null;
let hoverNoteHideTimer = null;
let hoverNoteShowTimer = null;
let hoverNotePositionFrame = 0;
let hoverNoteComposers = new Map();
const HOVER_NOTE_HIDE_DELAY_MS = 1100;
const HOVER_NOTE_SHOW_DELAY_MS = 100;
const hoverNoteResizeObserver = typeof ResizeObserver === "function"
  ? new ResizeObserver(() => scheduleHoverNotePositionSync())
  : null;

startDevelopmentAutoReload();

async function startDevelopmentAutoReload() {
  let lastStamp = "";
  const check = async () => {
    try {
      const response = await fetch(chrome.runtime.getURL(`dev-reload.txt?t=${Date.now()}`), { cache: "no-store" });
      if (!response.ok) return;
      const stamp = (await response.text()).trim();
      if (!stamp) return;
      if (!lastStamp) {
        lastStamp = stamp;
        return;
      }
      if (stamp === lastStamp) return;
      lastStamp = stamp;
      chrome.runtime.sendMessage({ type: "DEV_RELOAD_EXTENSION" }).catch(() => {});
      setTimeout(() => location.reload(), 80);
    } catch {
      // 开发辅助功能失败不影响页面功能。
    }
  };
  await check();
  setInterval(check, DEV_RELOAD_POLL_MS);
}

document.addEventListener("mouseup", (event) => {
  lastMousePoint = { x: event.clientX, y: event.clientY };
  setTimeout(showSelectionToolbar, 40);
});

document.addEventListener("selectionchange", () => {
  capturePageSelectionSnapshot();
  showSelectionToolbar();
});

document.addEventListener("contextmenu", () => {
  capturePageSelectionSnapshot();
});

document.addEventListener("mousedown", (event) => {
  if (!event.target?.closest?.(`.${SELECTION_TOOLBAR_CLASS}`)) hideSelectionToolbar();
});

document.addEventListener("pointerover", handleHoverNotePointerOver);
document.addEventListener("pointerout", handleHoverNotePointerOut);
document.addEventListener("pointermove", (event) => {
  if (event.pointerType === "touch") return;
  lastMousePoint = { x: event.clientX, y: event.clientY };
  hasHoverNotePointer = true;
  // Track the pointer for Command presses without scanning blocks on every move.
  if (event.metaKey || hoverNoteCommandPressed) handleHoverNotePointerOver(event);
});
document.addEventListener("keydown", handleHoverNoteModifierChange);
document.addEventListener("keyup", handleHoverNoteModifierChange);
window.addEventListener("blur", () => {
  hoverNoteCommandPressed = false;
  hasHoverNotePointer = false;
  syncHoverNoteAddTriggers(null);
  cancelHoverNoteShow();
  hideSelectionToolbar();
});
window.addEventListener("scroll", scheduleHoverNotePositionSync, true);
window.addEventListener("resize", scheduleHoverNotePositionSync);

setInterval(() => {
  if (lastSeenUrl === location.href) return;
  lastSeenUrl = location.href;
  removeHoverNoteComposer(true);
  hoverNoteResizeObserver?.disconnect();
  hoverNoteComposers = new Map();
  syncMarkedNotesForCurrentUrl();
  document.querySelector(`.${ASK_PANEL_CLASS}`)?.remove();
  document.querySelectorAll(`.${PDF_SECTION_CLASS}`).forEach((node) => node.remove());
  hideSelectionToolbar();
  lastPageSelection = null;
  lastArticleSnapshot = null;
  lastSummaryText = "";
  lastNoteTitle = "";
  lastOriginalSummary = "";
  originalSummaryPromise = null;
}, 1000);

initAutoOpenPanel();
initMarkThemeWatcher();
initSettingsSyncWatcher();

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

  if (message?.type === "SUMMARY_PAGE") {
    summarizePageForPopup(message.settings)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }

  if (message?.type === "OPEN_ASK_PANEL") {
    openAskPanel(message.settings);
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === "RUN_READER_ACTION") {
    runReaderActionFromMessage(message)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }

  if (message?.type === "MARK_SELECTION") {
    markSelectedTranslationText()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
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
  hideEmptyParagraphs();
  streamingNodes.clear();
  translationAttemptCounts = new WeakMap();

  const pdfResult = await ensurePdfContentSections();
  const allBlocks = collectBlocks();
  if (!allBlocks.length) {
    return { translated: 0, message: pdfResult.message || "未找到适合翻译的正文段落。" };
  }
  lastArticleSnapshot = createArticleSnapshot(allBlocks);
  lastSummaryText = "";
  lastNoteTitle = "";
  lastOriginalSummary = "";
  originalSummaryPromise = null;

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
    const render = resolveTranslationRender(block, settings, style);
    insertTranslationNode(block, translation, render.mode, render.style, settings);
  }

  const finishTranslationRun = async () => {
    await auditAndTranslateMissingBlocks(settings, run, style);
    if (!run.cancelled) startOverviewAfterTranslation();
  };

  // 未缓存 → 后台队列翻译。只在段落真正开始翻译时插入 DOM，避免大页面一次性重排。
  if (uncachedBlocks.length > 0) {
    streamAll(uncachedBlocks, settings, run, style)
      .then(finishTranslationRun)
      .catch(console.error);
  } else {
    finishTranslationRun().catch(console.error);
  }

  return {
    translated: allBlocks.length,
    message: [
      pdfResult.loaded ? `已读取 ${pdfResult.loaded} 个 PDF。` : "",
      `已开始翻译。${cachedBlocks.length} 段来自缓存，${uncachedBlocks.length} 段流式翻译中...`
    ].filter(Boolean).join(" ")
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
  const concurrency = resolved.provider !== "ollama" ? ONLINE_CONCURRENCY : OLLAMA_CONCURRENCY;
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

async function auditAndTranslateMissingBlocks(settings, run, style) {
  for (let pass = 0; pass < MAX_MISSING_TRANSLATION_PASSES && !run.cancelled; pass += 1) {
    const missingBlocks = collectMissingLongBlocks()
      .filter((block) => (translationAttemptCounts.get(block.element) || 0) < MAX_TRANSLATION_ATTEMPTS)
      .slice(0, MAX_BLOCKS_PER_RUN);

    if (!missingBlocks.length) return;
    console.info(`[PIT] 漏译检查第 ${pass + 1} 轮：补译 ${missingBlocks.length} 个长段落`);
    await streamAll(prioritizeBlocksByViewport(missingBlocks), settings, run, style);
  }
}

function collectMissingLongBlocks() {
  const root = findBestArticleContentRoot() || document.body;
  if (!(root instanceof Element)) return [];

  const selector = "p, li, blockquote, figcaption, dd, dt, td, th, h1, h2, h3, h4, h5, h6, div[lang], [role='paragraph'], [data-testid='tweetText']";
  const candidates = Array.from(root.querySelectorAll(selector));
  if (root.matches?.(selector)) candidates.unshift(root);

  return removeOverlappingCandidateBlocks(candidates)
    .filter((element) => element instanceof HTMLElement && !element.closest(SKIP_SELECTOR))
    .filter((element) => isVisible(element) || hasVisibleTextRange(element))
    .filter((element) => !hasValidCompletedTranslation(element))
    .map((element) => {
      restoreStaleReplacementBeforeRetry(element);
      return {
        element,
        text: extractBlockText(element),
        hasFormat: hasFormatting(element)
      };
    })
    .filter((block) => {
      const words = normalizeText(block.text).match(/[A-Za-z]+(?:[-'][A-Za-z]+)*/g) || [];
      return words.length > MISSING_TRANSLATION_MIN_WORDS
        && shouldTranslateToSimplifiedChinese(block.text);
    });
}

function hasValidCompletedTranslation(element) {
  const sourceText = extractOriginalTextForBundle(element);
  const candidates = [
    element.querySelector(`:scope > .${TRANSLATION_CLASS}[data-state="done"], :scope .${REPLACED_CLASS}[data-state="done"]`),
    element.nextElementSibling?.matches?.(`.${TRANSLATION_CLASS}[data-state="done"]`)
      ? element.nextElementSibling
      : null
  ].filter(Boolean);

  return candidates.some((node) => (
    isUsableTranslationResult(sourceText, node.innerText || node.textContent || "")
  ));
}

function restoreStaleReplacementBeforeRetry(element) {
  if (element.hasAttribute(ORIGINAL_HTML_ATTR)) {
    element.innerHTML = element.getAttribute(ORIGINAL_HTML_ATTR) || "";
    element.removeAttribute(ORIGINAL_HTML_ATTR);
  }
  element.removeAttribute(PROCESSED_ATTR);
  removeExistingTranslationFromBlock(element);
}

function prioritizeBlocksByViewport(blocks) {
  return [...blocks].sort((left, right) => {
    const leftVisible = isInViewport(left.element) ? 0 : 1;
    const rightVisible = isInViewport(right.element) ? 0 : 1;
    return leftVisible - rightVisible;
  });
}

async function streamBlock(block, settings, run, style) {
  if (run.cancelled || isAlreadyHandledBlock(block.element)) return;
  const attempts = translationAttemptCounts.get(block.element) || 0;
  if (attempts >= MAX_TRANSLATION_ATTEMPTS) return;
  translationAttemptCounts.set(block.element, attempts + 1);

  const paraId = `pit_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const render = resolveTranslationRender(block, settings, style);
  // 标出当前正在请求的原文，避免用户在并行翻译时失去上下文。
  block.element.setAttribute("data-pit-translating", "true");
  const node = createStreamingTarget(block, render.mode, render.style, settings);
  const renderer = createStreamRenderer(node, block.hasFormat);
  const protectedSource = protectInlineTokens(protectLinks(block.text));
  let gotFirstToken = false;
  let completedTranslation = "";

  streamingNodes.set(paraId, { node, renderer, originalText: block.text });

  const firstTokenTimer = setTimeout(() => {
    if (!gotFirstToken && !run.cancelled && streamingNodes.has(paraId)) {
      node.dataset.state = "waiting";
      node.textContent = "模型启动中...";
    }
  }, FIRST_TOKEN_TIMEOUT_MS);

  try {
    for (const textChunk of splitTextForTranslation(protectedSource.text)) {
      if (run.cancelled) return;
      if (textChunk.text) {
        if (isProtectedPlaceholderOnly(textChunk.text)) {
          const restoredChunk = restoreInlineTokens(textChunk.text, protectedSource);
          renderer.append(restoredChunk);
          completedTranslation += restoredChunk;
        } else {
          const beforeChunk = renderer.getText();
          const completedChunk = await streamOneParagraph(textChunk.text, settings, (chunk) => {
            if (run.cancelled) return;
            if (!gotFirstToken) {
              gotFirstToken = true;
              clearTimeout(firstTokenTimer);
              node.dataset.state = "loading";
            }
            renderer.append(restoreInlineTokens(chunk, protectedSource));
          }, run);
          const restoredCompletedChunk = restoreInlineTokens(completedChunk, protectedSource);
          appendMissingStreamResult(renderer, beforeChunk, restoredCompletedChunk);
          completedTranslation += restoredCompletedChunk;
        }
      }
      if (textChunk.separator) {
        renderer.append(textChunk.separator);
        completedTranslation += textChunk.separator;
      }
    }

    if (run.cancelled) return;
    const finalText = formatTranslationResult(completedTranslation || restoreInlineTokens(renderer.getText(), protectedSource));
    if (!isUsableTranslationResult(block.text, finalText)) {
      throw new Error("模型没有返回有效的中文译文");
    }
    renderer.finish(finalText);
    if (!isRenderedTranslationUsable(node, block.text)) {
      throw new Error("译文没有成功写入页面");
    }
    node.dataset.state = "done";
    if (block.text && finalText) setCacheEntry(block.text, finalText);
  } catch (err) {
    if (!run.cancelled) {
      console.warn("[PIT] translation failed", err);
      if (!restoreOriginalBlockAfterFailedReplacement(block, node)) {
        node.dataset.state = "error";
        const partialText = renderer.getText();
        renderer.finish(
          partialText && !hasUnresolvedProtectedPlaceholder(partialText)
            ? partialText
            : humanizeStreamError(err, settings)
        );
      }
    }
  } finally {
    clearTimeout(firstTokenTimer);
    streamingNodes.delete(paraId);
    block.element.removeAttribute("data-pit-translating");
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
function createStreamingNode(style, settings = {}, sourceElement = null) {
  const node = document.createElement("span");
  node.className        = TRANSLATION_CLASS;
  node.dataset.state    = "loading";
  node.dataset.pitStyle = style;
  applyStardustMotion(node);
  applyTranslationTypography(node, settings, sourceElement);
  return node;
}

function applyStardustMotion(element, motion = null) {
  const random = (min, max, decimals = 2) => Number((min + Math.random() * (max - min)).toFixed(decimals));
  const values = motion || {
    "--pit-stardust-before-duration": `${random(1.7, 2.8)}s`,
    "--pit-stardust-after-duration": `${random(2.3, 3.9)}s`,
    "--pit-stardust-before-delay": `${random(-2.8, -0.1)}s`,
    "--pit-stardust-after-delay": `${random(-3.8, -0.2)}s`,
    "--pit-star-drift-x-start": `${random(-5, -1)}px`,
    "--pit-star-drift-y-start": `${random(1, 4)}px`,
    "--pit-star-drift-x-mid": `${random(-1, 4)}px`,
    "--pit-star-drift-y-mid": `${random(-3, 1)}px`,
    "--pit-star-drift-x-end": `${random(3, 8)}px`,
    "--pit-star-drift-y-end": `${random(-6, -2)}px`,
    "--pit-star-peak-opacity": `${random(0.62, 0.86)}`
  };

  Object.entries(values).forEach(([name, value]) => element.style.setProperty(name, value));
  return values;
}

function createStreamingTarget(block, mode, style, settings = {}) {
  const node = createStreamingNode(style, settings, block.element);
  block.element.setAttribute(PROCESSED_ATTR, "true");
  removeExistingTranslationFromBlock(block.element);

  if (mode === "replace") {
    node.classList.add(REPLACED_CLASS);
    createCurtainReplaceTarget(block, node);
  } else {
    placeTranslationNode(block.element, node);
  }

  return node;
}

function createStreamRenderer(node, hasFormat) {
  let buffer = "";
  let scheduled = false;

  function render() {
    scheduled = false;
    const visibleText = stripStreamedText(buffer);
    if (hasFormat) {
      node.innerHTML = markdownToHtml(visibleText);
    } else {
      node.textContent = visibleText;
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
      buffer = formatTranslationResult(finalText || buffer);
      render();
    },
    getText() {
      return stripStreamedText(buffer);
    }
  };
}

function appendMissingStreamResult(renderer, beforeChunk, completedChunk) {
  const completed = formatTranslationResult(completedChunk);
  if (!completed) return;

  const before = String(beforeChunk || "");
  const after = renderer.getText();
  const streamedChunk = after.startsWith(before) ? after.slice(before.length).trimStart() : "";
  if (!streamedChunk) {
    renderer.append(completed);
  } else if (completed.startsWith(streamedChunk)) {
    renderer.append(completed.slice(streamedChunk.length));
  }
}

function isUsableTranslationResult(sourceText, translatedText) {
  const source = normalizeText(sourceText);
  const translated = normalizeText(translatedText);
  if (!translated || translated === source || hasUnresolvedProtectedPlaceholder(translated)) return false;

  const sourceLatinLetters = source.match(/[A-Za-z]/g)?.length || 0;
  const sourceCjk = source.match(/[\u3400-\u9fff]/g)?.length || 0;
  if (sourceLatinLetters >= 20 && sourceCjk === 0) {
    return (translated.match(/[\u3400-\u9fff]/g)?.length || 0) >= 2;
  }
  return true;
}

function isRenderedTranslationUsable(node, sourceText) {
  if (!(node instanceof HTMLElement) || !node.isConnected) return false;
  return isUsableTranslationResult(sourceText, node.innerText || node.textContent || "");
}

function restoreOriginalBlockAfterFailedReplacement(block, translationNode) {
  if (!translationNode?.classList?.contains(REPLACED_CLASS)) return false;
  const element = block?.element;
  if (!(element instanceof HTMLElement) || !element.hasAttribute(ORIGINAL_HTML_ATTR)) return false;
  element.innerHTML = element.getAttribute(ORIGINAL_HTML_ATTR) || "";
  element.removeAttribute(ORIGINAL_HTML_ATTR);
  element.removeAttribute(PROCESSED_ATTR);
  return true;
}

function insertTranslationNode(block, translation, mode, style, settings = {}) {
  if (isAlreadyHandledBlock(block.element)) return;
  const formattedTranslation = formatTranslationResult(translation);
  if (!isUsableTranslationResult(block.text, formattedTranslation)) return;
  removeExistingTranslationFromBlock(block.element);
  if (mode === "replace") {
    const node = replaceBlock(block, formattedTranslation);
    applyTranslationTypography(node, settings, block.element);
  } else {
    const node = createStreamingNode(style, settings, block.element);
    node.dataset.state = "done";
    if (block.hasFormat) {
      node.innerHTML = markdownToHtml(formattedTranslation);
    } else {
      node.textContent = formattedTranslation;
    }
    placeTranslationNode(block.element, node);
  }
  block.element.setAttribute(PROCESSED_ATTR, "true");
}

function placeTranslationNode(sourceElement, translationNode) {
  removeExistingTranslationFromBlock(sourceElement);
  if (shouldPlaceTranslationAfterElement(sourceElement)) {
    sourceElement.insertAdjacentElement("afterend", translationNode);
  } else {
    sourceElement.appendChild(translationNode);
  }
}

function shouldPlaceTranslationAfterElement(element) {
  if (!(element instanceof HTMLElement)) return false;
  if (isParagraphBoundaryElement(element)) return false;
  const display = getElementDisplayStyle(element).display;
  return /^(inline|inline-block|inline-flex|inline-grid)$/.test(display || "");
}

function resolveTranslationRender(block, settings = {}, fallbackStyle = "bar") {
  if (settings.shortTextReplaceMode && isShortTextBlock(block?.text)) {
    return { mode: "replace", style: "none" };
  }

  return {
    mode: settings.mode || "append",
    style: settings.translationStyle || fallbackStyle || "bar"
  };
}

function isShortTextBlock(text) {
  const normalized = normalizeText(text);
  if (!normalized) return false;
  const words = normalized.match(/[A-Za-z0-9]+(?:[-'][A-Za-z0-9]+)?/g) || [];
  return words.length > 0 && words.length <= SHORT_TEXT_REPLACE_MAX_WORDS;
}

function replaceBlock(block, translation) {
  const el = block.element;
  if (!el.hasAttribute(ORIGINAL_HTML_ATTR)) {
    el.setAttribute(ORIGINAL_HTML_ATTR, el.innerHTML);
  }
  const wrapper = document.createElement("span");
  wrapper.className = REPLACED_CLASS;
  wrapper.dataset.state = "done";
  if (block.hasFormat) {
    wrapper.innerHTML = markdownToHtml(translation);
  } else {
    wrapper.textContent = translation;
  }
  createCurtainReplaceTarget(block, wrapper);
  return wrapper;
}

function createCurtainReplaceTarget(block, translationNode) {
  const el = block.element;
  if (!el.hasAttribute(ORIGINAL_HTML_ATTR)) {
    el.setAttribute(ORIGINAL_HTML_ATTR, el.innerHTML);
  }

  const original = document.createElement("span");
  original.className = "pit-curtain-original";
  original.innerHTML = el.getAttribute(ORIGINAL_HTML_ATTR) || "";

  const stage = document.createElement("span");
  stage.className = "pit-curtain-stage";
  // 替换模式的星尘由舞台承载；沿用这一次翻译的随机节奏，避免两种模式观感不同。
  applyStardustMotion(stage, Object.fromEntries(
    Array.from(translationNode.style)
      .filter((name) => name.startsWith("--pit-star"))
      .map((name) => [name, translationNode.style.getPropertyValue(name)])
  ));
  stage.style.setProperty("--pit-curtain-min-height", `${Math.max(1, Math.ceil(el.getBoundingClientRect().height))}px`);
  stage.append(original, translationNode);
  el.replaceChildren(stage);
}

function protectLinks(text) {
  const links = [];
  const source = String(text || "");
  const protectedText = source.replace(/\[([^\]]+)\]\(([^)]+)\)|https?:\/\/[^\s<>"')]+|www\.[^\s<>"')]+/gi, (match, label, destination) => {
    const token = `PITLINK${links.length}`;
    // Markdown 链接只保护地址，链接文字仍应交给模型翻译。
    // 之前把整个 [label](url) 替换成占位符，会直接造成链接文字漏译。
    if (label !== undefined && destination !== undefined) {
      links.push(destination);
      return `[${label}](${token})`;
    }
    const trailingPunctuation = match.match(/[.,!?;:。！？；：]+$/)?.[0] || "";
    links.push(trailingPunctuation ? match.slice(0, -trailingPunctuation.length) : match);
    return `${token}${trailingPunctuation}`;
  });
  return { text: protectedText, links };
}

function protectInlineTokens(protection) {
  const tokens = [];
  const source = String(protection?.text || "");
  const protectedText = source
    .replace(PROTECTED_INLINE_TOKEN_PATTERN, (match) => {
      const token = `PITTOKEN${tokens.length}`;
      tokens.push(match);
      return token;
    })
    .replace(COMMON_UNTRANSLATED_TERM_PATTERN, (match) => {
      const token = `PITTOKEN${tokens.length}`;
      tokens.push(match);
      return token;
    });
  return {
    ...protection,
    text: protectedText,
    tokens
  };
}

function restoreProtectedLinks(text, links = []) {
  let fallbackIndex = 0;
  const usedIndexes = new Set();
  return String(text || "").replace(/PIT[\s_`*－-]*LINK(?:[\s_`*:：#＃－-]*([0-9０-９]+))?/gi, (match, rawIndex) => {
    const index = rawIndex === undefined
      ? nextUnusedProtectionIndex(usedIndexes, fallbackIndex)
      : Number(toAsciiDigits(rawIndex));
    const restored = links[index];
    if (!restored) return match;
    usedIndexes.add(index);
    fallbackIndex = Math.max(fallbackIndex, index + 1);
    return restored;
  });
}

function restoreInlineTokens(text, protection = {}) {
  let fallbackIndex = 0;
  const usedIndexes = new Set();
  const withTokens = String(text || "").replace(/PIT[\s_`*－-]*TOKEN(?:[\s_`*:：#＃－-]*([0-9０-９]+))?/gi, (match, rawIndex) => {
    const index = rawIndex === undefined
      ? nextUnusedProtectionIndex(usedIndexes, fallbackIndex)
      : Number(toAsciiDigits(rawIndex));
    const restored = protection.tokens?.[index];
    if (!restored) return match;
    usedIndexes.add(index);
    fallbackIndex = Math.max(fallbackIndex, index + 1);
    return restored;
  });
  return restoreProtectedLinks(withTokens, protection.links);
}

function nextUnusedProtectionIndex(usedIndexes, startIndex = 0) {
  let index = startIndex;
  while (usedIndexes.has(index)) index += 1;
  return index;
}

function toAsciiDigits(value) {
  return String(value || "").replace(/[０-９]/g, (digit) => String(digit.charCodeAt(0) - 0xFF10));
}

function hasUnresolvedProtectedPlaceholder(text) {
  return /PIT[\s_`*－-]*(?:LINK|TOKEN)(?:[\s_`*:：#＃－-]*[0-9０-９]+)?/i.test(String(text || ""));
}

function isProtectedPlaceholderOnly(text) {
  const value = String(text || "").trim();
  if (!value) return false;
  const stripped = value
    .replace(/PIT[\s_`*－-]*(?:TOKEN|LINK)[\s_`*:：#＃－-]*[0-9０-９]+/gi, "")
    .replace(/\s+/g, "")
    .trim();
  return stripped === "";
}

function applyTranslationTypography(node, settings = {}, sourceElement = null) {
  const fontSize = normalizeFontSizePercent(settings.translationFontSize);
  const lineHeight = normalizeLineHeight(settings.translationLineHeight);
  node.style.setProperty("--pit-translation-font-size", `${fontSize}%`);
  node.style.setProperty("--pit-translation-line-height", String(lineHeight));

  if (sourceElement instanceof Element) {
    copySourceFontStyle(node, sourceElement);
  }
}

function applyTranslationTypographyToPage(settings = {}) {
  document.querySelectorAll(`.${TRANSLATION_CLASS}, .${REPLACED_CLASS}`).forEach((node) => {
    applyTranslationTypography(node, settings);
  });
}

function copySourceFontStyle(node, sourceElement) {
  const computed = window.getComputedStyle(sourceElement);
  [
    "font-family",
    "font-weight",
    "font-style",
    "font-stretch",
    "font-variant",
    "letter-spacing",
    "text-transform",
    "text-rendering"
  ].forEach((property) => {
    node.style.setProperty(property, computed.getPropertyValue(property));
  });
}

function applyMarkColorToPage(settings = {}) {
  const color = getMarkHighlightColor(settings);
  document.querySelectorAll(".pit-manual-mark").forEach((node) => {
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
  document.querySelectorAll(`[${EMPTY_PARAGRAPH_ATTR}]`).forEach((el) => {
    el.removeAttribute(EMPTY_PARAGRAPH_ATTR);
  });
  lastSummaryText = "";
}

function hideEmptyParagraphs(root = document.body) {
  if (!(root instanceof Element)) return;
  root.querySelectorAll("p").forEach((paragraph) => {
    if (paragraph.closest(SKIP_SELECTOR) || !isEmptyParagraph(paragraph)) return;
    paragraph.setAttribute(EMPTY_PARAGRAPH_ATTR, "true");
  });
}

function isEmptyParagraph(paragraph) {
  if (!(paragraph instanceof HTMLParagraphElement)) return false;
  if (paragraph.querySelector("img, picture, svg, video, audio, iframe, canvas, object, embed, input, textarea, select, button, hr, math")) {
    return false;
  }
  return String(paragraph.textContent || "")
    .replace(/[\s\u00A0\u200B-\u200D\u2060\uFEFF]/g, "") === "";
}

function removeExistingTranslationFromBlock(element) {
  element?.querySelectorAll?.(`:scope > .${TRANSLATION_CLASS}, :scope > .${REPLACED_CLASS}`).forEach((node) => node.remove());
  if (element?.nextElementSibling?.classList?.contains(TRANSLATION_CLASS)
    || element?.nextElementSibling?.classList?.contains(REPLACED_CLASS)) {
    element.nextElementSibling.remove();
  }
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
    noteTitle: lastNoteTitle,
    url: snapshot.url || location.href,
    sourceType: isXPage() ? "x" : "web",
    capturedAt: snapshot.capturedAt,
    summary: getAskMarkdown(document.querySelector(`.${ASK_PANEL_CLASS}`)) || lastSummaryText,
    originalSummary: lastOriginalSummary,
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
function getReaderPanels() {
  return Array.from(document.querySelectorAll(`.${ASK_PANEL_CLASS}`))
    .filter((node) => node instanceof HTMLElement);
}

function getActiveReaderPanel() {
  const panels = getReaderPanels();
  if (!panels.length) return null;
  return panels.find((panel) => panel.dataset.pageUrl === location.href && panel.hidden !== true)
    || panels.find((panel) => panel.dataset.pageUrl === location.href)
    || panels.find((panel) => panel.hidden !== true)
    || panels[0];
}

function mergePanelNotes(targetPanel, sourcePanel) {
  if (!(targetPanel instanceof HTMLElement) || !(sourcePanel instanceof HTMLElement) || targetPanel === sourcePanel) return;
  const targetInput = targetPanel.querySelector(".pit-panel-note");
  const sourceInput = sourcePanel.querySelector(".pit-panel-note");
  if (!targetInput || !sourceInput) return;
  const targetNote = String(targetInput.value || "").trim();
  const sourceNote = String(sourceInput.value || "").trim();
  if (!sourceNote || targetNote.includes(sourceNote)) return;
  if (!targetNote) {
    targetInput.value = `${sourceNote}\n`;
  } else {
    targetInput.value = `${targetNote}\n\n${sourceNote}\n`;
  }
  persistNoteDraft(targetPanel);
}

function normalizeReaderPanelSingleton(preferredPanel = null) {
  const panels = getReaderPanels();
  if (!panels.length) return null;
  const currentPagePanels = panels.filter((panel) => panel.dataset.pageUrl === location.href);
  const candidates = currentPagePanels.length ? currentPagePanels : panels;
  const survivor = preferredPanel && candidates.includes(preferredPanel)
    ? preferredPanel
    : candidates.find((panel) => panel.hidden !== true) || candidates[0];

  for (const panel of panels) {
    if (panel === survivor) continue;
    if (!panel.dataset.pageUrl || panel.dataset.pageUrl === location.href) {
      mergePanelNotes(survivor, panel);
    }
    panel.remove();
  }

  if (!survivor.dataset.pageUrl || survivor.dataset.pageUrl === location.href) {
    survivor.dataset.pageUrl = location.href;
  }
  return survivor;
}

function openAskPanel(settings = {}, options = {}) {
  const resolvedSettings = { ...DEFAULT_OLLAMA, ...lastKnownSettings, ...settings };
  lastKnownSettings = resolvedSettings;
  const shouldShow = options.visible !== false;
  let panel = normalizeReaderPanelSingleton(getActiveReaderPanel());
  if (panel) {
    if (panel.dataset.pageUrl !== location.href) {
      panel.remove();
      panel = null;
    } else {
      panel = normalizeReaderPanelSingleton(panel) || panel;
      applyExternalSettingsToPanel(panel, resolvedSettings);
      if (shouldShow) panel.hidden = false;
      return panel;
    }
  }

  panel = document.createElement("aside");
  panel.className = ASK_PANEL_CLASS;
  panel.hidden = !shouldShow;
  panel.dataset.pageUrl = location.href;
  panel.__pitSettings = resolvedSettings;
  panel.innerHTML = [
    '<div class="pit-reader-header">',
    '<div><strong>页面阅读助手</strong></div>',
    '<div class="pit-reader-header-actions"><button class="pit-panel-translate pit-panel-translate-header" type="button" title="翻译当前页面" aria-label="翻译当前页面">翻译</button>',
    '<button class="pit-panel-mark-selection" type="button" title="标记当前选中内容" aria-label="标记当前选中内容">标记</button>',
    '<button class="pit-panel-save-all" type="button" title="保存 Markdown" aria-label="保存 Markdown">保存</button>',
    '<button class="pit-ask-close" type="button" aria-label="关闭">×</button>',
    '</div>',
    '</div>',
    '<nav class="pit-reader-tabs" aria-label="功能">',
    '<button class="pit-reader-tab is-active" data-reader-tab="notes" type="button">✎ 笔记</button>',
    '<button class="pit-reader-tab" data-reader-tab="ask" type="button">💬 Ask</button>',
    '<button class="pit-reader-tab" data-reader-tab="localQa" type="button">📚 问笔记</button>',
    '<button class="pit-reader-tab" data-reader-tab="tweet" type="button">✍️ 发帖</button>',
    '<button class="pit-reader-tab" data-reader-tab="settings" type="button">⚙️ 设置</button>',
    '</nav>',
    '<section class="pit-reader-body">',
    '<div class="pit-reader-panel-section is-active" data-reader-panel="notes">',
    '<div class="pit-reader-field pit-note-field"><span>我的笔记 · Markdown</span><div class="pit-note-editor"><textarea class="pit-panel-note" rows="10" spellcheck="false" placeholder="支持 Markdown：# 标题、- 要点、**重点**、`代码`、[链接](url)"></textarea><div class="pit-note-render markdown-body" hidden></div></div></div>',
    '<div class="pit-reader-checks"><label><input class="pit-save-url" type="checkbox" checked> 原始链接</label><label><input class="pit-save-original" type="checkbox" checked> 网页英文</label><label><input class="pit-save-translation" type="checkbox" checked> 中文翻译</label><label><input class="pit-save-ask" type="checkbox" checked> Ask 内容</label><label><input class="pit-save-note" type="checkbox" checked> 我的笔记</label></div>',
    '</div>',
    '<div class="pit-reader-panel-section" data-reader-panel="ask">',
    `<section class="pit-ask-overview markdown-body">${isXPage() ? "正在总结 X 内容..." : "正在读取文章脉络..."}</section>`,
    '<section class="pit-ask-messages" aria-label="对话"></section>',
    '<label class="pit-reader-toggle pit-ask-search-toggle"><input class="pit-panel-allow-web-search" type="checkbox"> 文章不足时允许联网搜索</label>',
    '</div>',
    '<div class="pit-reader-panel-section" data-reader-panel="localQa">',
    '<label class="pit-reader-field"><span>本地问答服务</span><input class="pit-panel-local-qa-url" placeholder="http://localhost:3218"></label>',
    '<label class="pit-reader-field"><span>Markdown 笔记目录</span><div class="pit-local-qa-path"><input class="pit-panel-local-qa-dir" placeholder="点击选择目录"><button class="pit-reader-secondary pit-panel-local-qa-pick" type="button">选择</button></div></label>',
    '<div class="pit-reader-actions"><button class="pit-reader-secondary pit-panel-local-qa-open" type="button">打开网页</button><button class="pit-reader-secondary pit-panel-local-qa-index" type="button">重新索引</button></div>',
    '<div class="pit-local-qa-status">打开本地服务后可连接。</div>',
    '<section class="pit-local-qa-messages" aria-label="本地笔记问答记录"></section>',
    '<div class="pit-local-qa-composer"><textarea class="pit-local-qa-input" rows="1" placeholder="问问你的本地 Markdown 笔记，Enter 发送"></textarea><button class="pit-reader-primary pit-panel-local-qa-ask" type="button">提问</button></div>',
    '</div>',
    '<div class="pit-reader-panel-section" data-reader-panel="tweet">',
    '<label class="pit-reader-field"><span>想表达的内容</span><textarea class="pit-tweet-source" rows="7" placeholder="输入任意语言，写下你想表达的意思"></textarea></label>',
    '<label class="pit-reader-field"><span>目标语言</span><select class="pit-tweet-language"><option value="English">English</option><option value="Simplified Chinese">简体中文</option><option value="Hindi">हिन्दी</option><option value="Spanish">Español</option><option value="French">Français</option><option value="Arabic">العربية</option><option value="Bengali">বাংলা</option><option value="Portuguese">Português</option><option value="Russian">Русский</option></select></label>',
    '<div class="pit-reader-actions"><button class="pit-reader-primary pit-tweet-generate" type="button">生成 Twitter 文案</button><button class="pit-reader-secondary pit-tweet-copy" type="button" disabled>复制结果</button></div>',
    '<div class="pit-tweet-result" aria-live="polite">生成后会显示在这里。</div>',
    '</div>',
    '<div class="pit-reader-panel-section" data-reader-panel="settings">',
    '<h2 class="pit-reader-section-title">翻译设置</h2>',
    '<label class="pit-reader-field"><span>翻译模式</span><select class="pit-panel-mode"><option value="append">段落下方增加中文</option><option value="replace">替换原文</option></select></label>',
    '<label class="pit-reader-field"><span>译文样式</span><select class="pit-panel-style"><option value="none">无</option><option value="bar">左侧竖线</option><option value="dashed-box">虚线方框</option><option value="highlight">浅色高亮</option><option value="top-line">顶部细线</option><option value="bubble">圆角气泡</option></select></label>',
    '<label class="pit-reader-toggle"><input class="pit-panel-short-replace" type="checkbox"> 短句自动替换原文</label>',
    '<div class="pit-reader-actions pit-reader-settings-action"><button class="pit-reader-secondary pit-panel-restore" type="button">恢复原文</button></div>',
    '<h2 class="pit-reader-section-title">模型与阅读</h2>',
    '<label class="pit-reader-field"><span>翻译后端</span><select class="pit-panel-provider"><option value="ollama">本地 Ollama</option><option value="openaiCompatible">OpenAI-compatible API</option><option value="antLing">蚂蚁百灵 AI</option></select></label>',
    '<label class="pit-reader-field"><span>模型</span><select class="pit-panel-model-select"></select><input class="pit-panel-model-input" placeholder="qwen3.5:4b"></label>',
    '<label class="pit-reader-field"><span>API Base URL</span><input class="pit-panel-base-url" placeholder="http://localhost:11434"></label>',
    '<label class="pit-reader-field"><span>API Key</span><input class="pit-panel-api-key" type="password" placeholder="仅在线 API 需要"></label>',
    '<label class="pit-reader-field pit-reader-range-field"><span>译文字号 <strong class="pit-font-size-value">100%</strong></span><input class="pit-panel-font-size" type="range" min="80" max="130" step="1"></label>',
    '<label class="pit-reader-field pit-reader-range-field"><span>译文行距 <strong class="pit-line-height-value">1.4</strong></span><input class="pit-panel-line-height" type="range" min="1.1" max="1.9" step="0.05"></label>',
    '<label class="pit-reader-field"><span>标记样式</span><select class="pit-panel-mark-style"><option value="highlight">高亮 ==文字==</option><option value="bold">加粗 **文字**</option><option value="italic">斜体 *文字*</option><option value="boldItalic">加粗斜体 ***文字***</option><option value="code">代码 `文字`</option></select></label>',
    '<div class="pit-reader-color-grid">',
    '<label class="pit-reader-field"><span>浅色网页标记色</span><input class="pit-panel-mark-color-light" type="color"></label>',
    '<label class="pit-reader-field"><span>深色网页标记色</span><input class="pit-panel-mark-color-dark" type="color"></label>',
    '</div>',
    '<label class="pit-reader-toggle"><input class="pit-panel-auto-open" type="checkbox"> 打开网页后自动显示面板</label>',
    '<label class="pit-reader-field"><span>总结注意点</span><textarea class="pit-panel-summary-prompt" rows="4" placeholder="例如：重点关注市场观点、风险、作者给出的建议。"></textarea></label>',
    '<label class="pit-reader-field"><span>Markdown 保存目录</span><input class="pit-panel-save-dir" placeholder="WebNotes"><small class="pit-reader-help">只能填写 Chrome 下载目录下的子文件夹，例如 WebNotes，不能填写 /Users/... 绝对路径。</small></label>',
    '</div>',
    '</section>',
    '<div class="pit-ask-composer">',
    '<textarea class="pit-ask-input" rows="1" placeholder="提问，Enter 发送"></textarea>',
    '<button class="pit-ask-send" type="button" aria-label="发送">➤</button>',
    '</div>',
    '<div class="pit-reader-status" aria-live="polite">已连接当前页面</div>',
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
  normalizeReaderPanelSingleton(panel);
  hydrateReaderPanel(panel, resolvedSettings);
  applySavedPanelSize(panel).finally(() => makePanelMovableAndResizable(panel));
  isolatePanelScroll(panel);
  prewarmPanelModel(panel);
  if (options.focus !== false) {
    focusWithoutPageScroll(panel.querySelector(".pit-panel-note"));
  }
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
  panel.querySelector(".pit-panel-short-replace").checked = Boolean(initial.shortTextReplaceMode);
  panel.querySelector(".pit-panel-provider").value = initial.provider || "ollama";
  panel.querySelector(".pit-panel-model-input").value = initial.model || DEFAULT_OLLAMA.model;
  panel.querySelector(".pit-panel-base-url").value = initial.baseUrl || DEFAULT_OLLAMA.baseUrl;
  panel.querySelector(".pit-panel-api-key").value = initial.apiKey || "";
  panel.querySelector(".pit-panel-font-size").value = normalizeFontSizePercent(initial.translationFontSize);
  panel.querySelector(".pit-panel-line-height").value = normalizeLineHeight(initial.translationLineHeight);
  panel.querySelector(".pit-panel-mark-style").value = initial.markStyle || DEFAULT_OLLAMA.markStyle;
  panel.querySelector(".pit-panel-mark-color-light").value = getStoredMarkColor(initial, "light");
  panel.querySelector(".pit-panel-mark-color-dark").value = getStoredMarkColor(initial, "dark");
  panel.querySelector(".pit-panel-auto-open").checked = initial.autoOpenPanel !== false;
  panel.querySelector(".pit-panel-save-dir").value = initial.saveDir || "page-notes";
  panel.querySelector(".pit-panel-summary-prompt").value = initial.summaryPrompt || "";
  panel.querySelector(".pit-panel-allow-web-search").checked = initial.allowWebSearch !== false;
  panel.querySelector(".pit-panel-local-qa-url").value = initial.localQaUrl || DEFAULT_OLLAMA.localQaUrl;
  panel.querySelector(".pit-panel-local-qa-dir").value = initial.localQaNotesDir || "";
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
  // Keep the restoration promise on the panel. A command shortcut can create a
  // hidden panel and request a save before storage has returned the draft.
  panel.__pitDraftRestorePromise = restoreNoteDraft(panel);
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
    ".pit-panel-short-replace",
    ".pit-panel-provider",
    ".pit-panel-model-select",
    ".pit-panel-model-input",
    ".pit-panel-base-url",
    ".pit-panel-api-key",
    ".pit-panel-font-size",
    ".pit-panel-line-height",
    ".pit-panel-mark-style",
    ".pit-panel-mark-color-light",
    ".pit-panel-mark-color-dark",
    ".pit-panel-auto-open",
    ".pit-panel-save-dir",
    ".pit-panel-summary-prompt",
    ".pit-panel-allow-web-search",
    ".pit-panel-local-qa-url",
    ".pit-panel-local-qa-dir"
  ].join(",")).forEach((control) => {
    const update = () => {
      panel.__pitSettings = readPanelSettings(panel);
      if (control.matches(".pit-panel-font-size, .pit-panel-line-height")) {
        updateTypographyLabels(panel);
        applyTranslationTypographyToPage(panel.__pitSettings);
      }
      if (control.matches(".pit-panel-mark-color-light, .pit-panel-mark-color-dark")) {
        applyMarkColorToPage(panel.__pitSettings);
      }
      persistPanelSettings(panel.__pitSettings);
    };
    control.addEventListener("input", () => {
      if (!control.matches(".pit-panel-provider")) update();
    });
    control.addEventListener("change", () => {
      if (control.matches(".pit-panel-provider")) {
        const previous = panel.__pitSettings;
        const configs = { ...previous.providerConfigs };
        configs[previous.provider] = { baseUrl: previous.baseUrl, model: previous.model, apiKey: previous.apiKey || "" };
        const config = configs[control.value] || { ...getPanelProviderDefaults(control.value), apiKey: "" };
        panel.querySelector(".pit-panel-base-url").value = config.baseUrl;
        panel.querySelector(".pit-panel-model-input").value = config.model;
        replaceSelectOptions(panel.querySelector(".pit-panel-model-select"), [{ value: config.model, label: config.model }]);
        panel.querySelector(".pit-panel-api-key").value = config.apiKey || "";
        panel.__pitSettings = { ...previous, ...config, provider: control.value, providerConfigs: configs };
      }
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

  panel.querySelector(".pit-panel-mark-selection").addEventListener("click", async () => {
    try {
      const marked = await markSelectedTranslationText("", readPanelSettings(panel));
      setPanelStatus(panel, marked
        ? "已标记选中内容，并已发送到笔记草稿。"
        : "请先在网页中选中要标记的内容，再点击“标记”。");
    } catch (error) {
      setPanelStatus(panel, error?.message || "标记失败，请重新选择文本后再试。");
    }
  });

  panel.querySelector(".pit-panel-restore").addEventListener("click", () => {
    if (window.__pitRun__) cancelRun(window.__pitRun__);
    restorePage();
    setPanelStatus(panel, "已恢复原文。");
  });

  panel.querySelector(".pit-panel-local-qa-open").addEventListener("click", () => openPanelLocalQa(panel));
  panel.querySelector(".pit-panel-local-qa-pick").addEventListener("click", () => pickPanelLocalQaDirectory(panel));
  panel.querySelector(".pit-panel-local-qa-index").addEventListener("click", () => reindexPanelLocalQa(panel));
  panel.querySelector(".pit-panel-local-qa-ask").addEventListener("click", () => askPanelLocalNotes(panel));
  panel.querySelector(".pit-local-qa-input").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      askPanelLocalNotes(panel);
    }
  });

  const saveAllButton = panel.querySelector(".pit-panel-save-all");
  saveAllButton.addEventListener("mousedown", () => {
    panel.dataset.savingNote = "true";
  });
  saveAllButton.addEventListener("click", () => savePanelMarkdown(panel));
  panel.querySelector(".pit-tweet-generate").addEventListener("click", () => generateTweetPost(panel));
  panel.querySelector(".pit-tweet-copy").addEventListener("click", () => copyTweetPost(panel));
}

function applyExternalSettingsToPanel(panel, settings = {}) {
  if (!(panel instanceof HTMLElement) || !settings || !Object.keys(settings).length) return;
  const next = { ...DEFAULT_OLLAMA, ...panel.__pitSettings, ...settings };
  lastKnownSettings = { ...lastKnownSettings, ...next };
  panel.__pitSettings = next;

  const assignments = [
    [".pit-panel-mode", next.mode || "append"],
    [".pit-panel-style", next.translationStyle || "bar"],
    [".pit-panel-provider", next.provider || "ollama"],
    [".pit-panel-model-input", next.model || DEFAULT_OLLAMA.model],
    [".pit-panel-base-url", next.baseUrl || DEFAULT_OLLAMA.baseUrl],
    [".pit-panel-api-key", next.apiKey || ""],
    [".pit-panel-font-size", normalizeFontSizePercent(next.translationFontSize)],
    [".pit-panel-line-height", normalizeLineHeight(next.translationLineHeight)],
    [".pit-panel-mark-style", next.markStyle || DEFAULT_OLLAMA.markStyle],
    [".pit-panel-mark-color-light", getStoredMarkColor(next, "light")],
    [".pit-panel-mark-color-dark", getStoredMarkColor(next, "dark")],
    [".pit-panel-save-dir", next.saveDir || "page-notes"],
    [".pit-panel-summary-prompt", next.summaryPrompt || ""],
    [".pit-panel-local-qa-url", next.localQaUrl || DEFAULT_OLLAMA.localQaUrl],
    [".pit-panel-local-qa-dir", next.localQaNotesDir || ""]
  ];

  for (const [selector, value] of assignments) {
    const control = panel.querySelector(selector);
    if (control && String(control.value) !== String(value)) control.value = value;
  }

  const shortReplace = panel.querySelector(".pit-panel-short-replace");
  if (shortReplace) shortReplace.checked = Boolean(next.shortTextReplaceMode);
  const autoOpen = panel.querySelector(".pit-panel-auto-open");
  if (autoOpen) autoOpen.checked = next.autoOpenPanel !== false;
  const allowWebSearch = panel.querySelector(".pit-panel-allow-web-search");
  if (allowWebSearch) allowWebSearch.checked = next.allowWebSearch !== false;

  updateTypographyLabels(panel);
  applyMarkColorToPage(next);
  updatePanelModelFields(panel);
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

async function summarizePageForPopup(settings = {}) {
  const page = getPageBundle();
  const response = await sendRuntimeMessageWithTimeout({
    type: "BUILD_ARTICLE_OVERVIEW",
    page,
    settings
  }, OVERVIEW_TIMEOUT_MS, "总结生成超时，请稍后重试或切换更小的本地模型。");
  if (!response?.ok) throw new Error(response?.error || "总结失败。");

  const summary = response.overview || "文章脉络为空。";
  lastSummaryText = summary;
  prepareNoteTitle({ ...page, summary }, "", settings);
  return { summary, message: "已生成总结，标题正在准备。" };
}

function normalizePanelLocalQaUrl(value) {
  return (String(value || DEFAULT_OLLAMA.localQaUrl).trim() || DEFAULT_OLLAMA.localQaUrl).replace(/\/+$/, "");
}

function setPanelLocalQaStatus(panel, text) {
  const status = panel.querySelector(".pit-local-qa-status");
  if (status) status.textContent = text;
}

async function panelLocalQaRequest(panel, path, options = {}) {
  const response = await fetch(`${normalizePanelLocalQaUrl(panel.querySelector(".pit-panel-local-qa-url")?.value)}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options
  });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.error || "本地问答服务请求失败。");
  return data;
}

async function persistPanelLocalQaConfig(panel) {
  const settings = readPanelSettings(panel);
  persistPanelSettings(settings);
  await panelLocalQaRequest(panel, "/api/config", {
    method: "POST",
    body: JSON.stringify({
      notesDir: settings.localQaNotesDir,
      provider: settings.provider === "antLing" ? "openaiCompatible" : settings.provider,
      baseUrl: settings.baseUrl,
      model: settings.model,
      apiKey: settings.apiKey
    })
  });
}

async function openPanelLocalQa(panel) {
  const url = normalizePanelLocalQaUrl(panel.querySelector(".pit-panel-local-qa-url")?.value);
  window.open(url, "_blank", "noopener");
}

async function pickPanelLocalQaDirectory(panel) {
  setPanelLocalQaStatus(panel, "正在打开目录选择器...");
  try {
    const response = await panelLocalQaRequest(panel, "/api/pick-directory", { method: "POST", body: "{}" });
    if (response.cancelled) {
      setPanelLocalQaStatus(panel, "已取消选择。");
      return;
    }
    panel.querySelector(".pit-panel-local-qa-dir").value = response.path || "";
    await persistPanelLocalQaConfig(panel);
    await reindexPanelLocalQa(panel);
  } catch (error) {
    setPanelLocalQaStatus(panel, error?.message || String(error));
  }
}

async function reindexPanelLocalQa(panel) {
  setPanelLocalQaStatus(panel, "正在更新本地笔记索引...");
  try {
    await persistPanelLocalQaConfig(panel);
    const response = await panelLocalQaRequest(panel, "/api/index", { method: "POST", body: "{}" });
    const index = response.index || {};
    setPanelLocalQaStatus(panel, `已索引 ${index.fileCount || 0} 个文件、${index.chunkCount || 0} 个片段。`);
  } catch (error) {
    setPanelLocalQaStatus(panel, error?.message || String(error));
  }
}

async function askPanelLocalNotes(panel) {
  const input = panel.querySelector(".pit-local-qa-input");
  const question = input?.value.trim();
  if (!question) return;
  appendPanelLocalQaMessage(panel, "user", question);
  input.value = "";
  const pending = appendPanelLocalQaMessage(panel, "assistant", "正在检索本地笔记...");
  try {
    await persistPanelLocalQaConfig(panel);
    const response = await panelLocalQaRequest(panel, "/api/ask", { method: "POST", body: JSON.stringify({ question }) });
    pending.querySelector(".pit-local-qa-message-body").innerHTML = renderMiniMarkdown(formatPanelLocalQaAnswer(panel, response.answer, response.sources));
    setPanelStatus(panel, "已基于本地笔记回答。");
  } catch (error) {
    pending.querySelector(".pit-local-qa-message-body").textContent = error?.message || String(error);
    setPanelLocalQaStatus(panel, error?.message || String(error));
  }
}

function appendPanelLocalQaMessage(panel, role, text) {
  const messages = panel.querySelector(".pit-local-qa-messages");
  const node = document.createElement("div");
  node.className = `pit-local-qa-message is-${role}`;
  node.innerHTML = `<div class="pit-ask-message-label">${role === "user" ? "你" : "笔记助手"}</div><div class="pit-local-qa-message-body markdown-body">${role === "assistant" ? renderMiniMarkdown(text) : escapeHtml(text)}</div>`;
  messages.appendChild(node);
  messages.scrollTop = messages.scrollHeight;
  return node;
}

function formatPanelLocalQaAnswer(panel, answer, sources = []) {
  const baseUrl = normalizePanelLocalQaUrl(panel.querySelector(".pit-panel-local-qa-url")?.value);
  const sourceLines = (sources || []).slice(0, 6).map((source) => {
    const label = `${source.relativePath || source.file} · ${source.title || ""}`.trim();
    const link = source.sourceUrl ? `[${label}](${baseUrl}${source.sourceUrl})` : label;
    return `- ${link} · 材料时间：${source.sourceTime?.label || "未知"}`;
  }).join("\n");
  return sourceLines ? `${answer || "没有得到回答。"}\n\n来源\n${sourceLines}` : (answer || "没有得到回答。");
}

function getPanelProviderDefaults(provider) {
  if (provider === "antLing") return { baseUrl: "https://api.ant-ling.com/v1", model: "Ling-3.0-flash" };
  if (provider === "openaiCompatible") return { baseUrl: "https://api.groq.com/openai/v1", model: "llama-3.1-8b-instant" };
  return { baseUrl: DEFAULT_OLLAMA.baseUrl, model: DEFAULT_OLLAMA.model };
}

function readPanelSettings(panel) {
  const provider = panel.querySelector(".pit-panel-provider")?.value || "ollama";
  const defaults = getPanelProviderDefaults(provider);
  const selectedModel = provider === "ollama"
    ? panel.querySelector(".pit-panel-model-select")?.value
    : panel.querySelector(".pit-panel-model-input")?.value;
  const settings = {
    ...panel.__pitSettings,
    mode: panel.querySelector(".pit-panel-mode")?.value || "append",
    translationStyle: panel.querySelector(".pit-panel-style")?.value || "bar",
    shortTextReplaceMode: panel.querySelector(".pit-panel-short-replace")?.checked === true,
    markStyle: panel.querySelector(".pit-panel-mark-style")?.value || DEFAULT_OLLAMA.markStyle,
    markHighlightColorLight: normalizeColor(panel.querySelector(".pit-panel-mark-color-light")?.value, DEFAULT_OLLAMA.markHighlightColorLight),
    markHighlightColorDark: normalizeColor(panel.querySelector(".pit-panel-mark-color-dark")?.value, DEFAULT_OLLAMA.markHighlightColorDark),
    noteSaveShortcut: "auto",
    provider,
    model: selectedModel?.trim() || defaults.model,
    baseUrl: panel.querySelector(".pit-panel-base-url")?.value.trim() || defaults.baseUrl,
    apiKey: panel.querySelector(".pit-panel-api-key")?.value.trim() || "",
    translationFontSize: normalizeFontSizePercent(panel.querySelector(".pit-panel-font-size")?.value),
    translationLineHeight: normalizeLineHeight(panel.querySelector(".pit-panel-line-height")?.value),
    autoOpenPanel: panel.querySelector(".pit-panel-auto-open")?.checked !== false,
    saveDir: panel.querySelector(".pit-panel-save-dir")?.value.trim() || "page-notes",
    summaryPrompt: panel.querySelector(".pit-panel-summary-prompt")?.value.trim() || "",
    allowWebSearch: panel.querySelector(".pit-panel-allow-web-search")?.checked !== false,
    localQaUrl: normalizePanelLocalQaUrl(panel.querySelector(".pit-panel-local-qa-url")?.value),
    localQaNotesDir: panel.querySelector(".pit-panel-local-qa-dir")?.value.trim() || ""
  };
  settings.providerConfigs = {
    ...settings.providerConfigs,
    [provider]: { baseUrl: settings.baseUrl, model: settings.model, apiKey: settings.apiKey }
  };
  settings.markHighlightColor = getMarkHighlightColor(settings);
  panel.__pitSettings = settings;
  return settings;
}

async function updatePanelModelFields(panel) {
  const provider = panel.querySelector(".pit-panel-provider")?.value || "ollama";
  const select = panel.querySelector(".pit-panel-model-select");
  const input = panel.querySelector(".pit-panel-model-input");
  const current = panel.__pitSettings?.model || input.value || DEFAULT_OLLAMA.model;
  const isOllama = provider === "ollama";
  const defaults = getPanelProviderDefaults(provider);
  panel.querySelector(".pit-panel-base-url").placeholder = defaults.baseUrl;
  input.placeholder = defaults.model;
  const apiKey = panel.querySelector(".pit-panel-api-key");
  apiKey.closest("label").hidden = isOllama;
  apiKey.placeholder = provider === "antLing" ? "填写百灵控制台创建的 API Key" : "仅在线 API 需要";
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
  if (!panel) return;
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
        provider: settings.provider,
        model: settings.model,
        baseUrl: settings.baseUrl,
        apiKey: settings.apiKey,
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
  const isVisiblePanel = panel.hidden !== true;
  if (isVisiblePanel) setPanelStatus(panel, "正在保存...");
  try {
    const settings = readPanelSettings(panel);
    if (isAbsoluteSavePath(settings.saveDir)) {
      if (isVisiblePanel) {
        setPanelStatus(panel, "保存目录只能填下载目录下的子文件夹，例如 WebNotes。");
        focusWithoutPageScroll(panel.querySelector(".pit-panel-save-dir"));
      }
      return;
    }
    // All save entry points (header button, unsaved-note prompt and extension
    // shortcut) pass through here. Wait for the same draft before building the
    // payload so a newly-created hidden panel cannot export an empty note.
    const note = await getNoteMarkdownForSave(panel);
    // Saving must stay on a fast, local path. Use a summary/title that was
    // prepared earlier when available; the background has deterministic
    // fallbacks and must not make the user wait for a model request here.
    const response = await sendRuntimeMessageWithTimeout({
      type: "SAVE_MARKDOWN_NOTE",
      page: getPageBundle(),
      note,
      options: {
        provider: settings.provider,
        model: settings.model,
        baseUrl: settings.baseUrl,
        apiKey: settings.apiKey,
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
    if (isVisiblePanel) setPanelStatus(panel, `已保存：${response.filename}`);
  } catch (error) {
    if (isVisiblePanel) setPanelStatus(panel, humanizeRuntimeError(error));
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

async function applySavedPanelSize(panel) {
  try {
    const stored = await chrome.storage.local.get(PANEL_LAYOUT_KEY);
    const layout = stored?.[PANEL_LAYOUT_KEY];
    if (!layout) return;
    const width = clampNumber(layout.width, PANEL_MIN_WIDTH, Math.max(PANEL_MIN_WIDTH, window.innerWidth - PANEL_EDGE_GAP * 2));
    const height = clampNumber(layout.height, PANEL_MIN_HEIGHT, Math.max(PANEL_MIN_HEIGHT, window.innerHeight - PANEL_EDGE_GAP * 2));
    panel.style.width = `${width}px`;
    panel.style.height = `${height}px`;
  } catch {
    // 尺寸恢复失败时继续使用默认大小。
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
      height: Math.round(rect.height)
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
  if (!selection?.rangeCount || selection.isCollapsed || !text) {
    hideSelectionToolbar();
    return;
  }
  const anchor = selection.anchorNode instanceof Element
    ? selection.anchorNode
    : selection.anchorNode?.parentElement;
  if (anchor?.closest?.(`.${ASK_PANEL_CLASS}, .${SELECTION_TOOLBAR_CLASS}, .pit-mark-note-composer, textarea, input, select, button`)) {
    hideSelectionToolbar();
    return;
  }

  const range = selection.rangeCount ? selection.getRangeAt(0) : null;
  const rect = range?.getBoundingClientRect();
  if (!rect || (!rect.width && !rect.height)) {
    hideSelectionToolbar();
    return;
  }

  capturePageSelectionSnapshot();

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
      '</button>'
    ].join("");
    toolbar.addEventListener("mousedown", (event) => event.preventDefault());
    toolbar.addEventListener("click", (event) => {
      const action = event.target?.closest?.("button")?.dataset.action;
      if (action === "translate") translateSelectionText(toolbar.dataset.selectionText || "");
      if (action === "mark") markSelectedTranslationText(toolbar.dataset.selectionText || "");
    });
    document.body.appendChild(toolbar);
  }

  toolbar.dataset.selectionText = text;
  toolbar.style.left = `${Math.max(8, Math.min(lastMousePoint.x + 65, window.innerWidth - 112))}px`;
  toolbar.style.top = `${Math.max(8, Math.min(lastMousePoint.y + 15, window.innerHeight - 38))}px`;
  toolbar.hidden = false;
}

function hideSelectionToolbar() {
  const toolbar = document.querySelector(`.${SELECTION_TOOLBAR_CLASS}`);
  if (toolbar) toolbar.hidden = true;
}

async function runReaderActionFromMessage(message) {
  const action = message?.action;
  const settings = { ...DEFAULT_OLLAMA, ...(message?.settings || {}) };
  const selectedText = normalizeSelectedText(message?.selectionText || window.getSelection()?.toString() || "");
  const panel = openAskPanel(settings, { focus: false, visible: false });

  if (action === "translate_current_page") {
    activateReaderTab(panel, "translate");
    setPanelStatus(panel, "正在翻译...");
    const result = await translatePage(readPanelSettings(panel));
    setPanelStatus(panel, result.message || "已开始翻译。");
    return result;
  }

  if (action === "translate_selection") {
    if (!selectedText) {
      activateReaderTab(panel, "translate");
      setPanelStatus(panel, "当前没有选中文本。");
      return { message: "当前没有选中文本。" };
    }
    activateReaderTab(panel, "translate");
    setPanelStatus(panel, "正在翻译选中内容...");
    await translateSelectionText(selectedText);
    setPanelStatus(panel, "已开始翻译选中内容。");
    return { message: "已开始翻译选中内容。" };
  }

  if (action === "mark_selection") {
    activateReaderTab(panel, "notes");
    if (!selectedText) {
      setPanelStatus(panel, "当前没有选中文本。");
      return { message: "当前没有选中文本。" };
    }
    const marked = await markSelectedTranslationText(selectedText, readPanelSettings(panel));
    const message = marked ? "已标记选中内容。" : "当前选区无法标记，请重新选择文本后再试。";
    setPanelStatus(panel, message);
    return { message };
  }

  if (action === "save_page") {
    activateReaderTab(panel, "notes");
    await savePanelMarkdown(panel);
    return { message: "正在保存..." };
  }

  return { message: "未识别的操作。" };
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
  const protection = protectInlineTokens(protectLinks(selected));
  let completedTranslation = "";

  try {
    for (const textChunk of splitTextForTranslation(protection.text)) {
      if (textChunk.text) {
        if (isProtectedPlaceholderOnly(textChunk.text)) {
          const restoredChunk = restoreInlineTokens(textChunk.text, protection);
          renderer.append(restoredChunk);
          completedTranslation += restoredChunk;
        } else {
          const beforeChunk = renderer.getText();
          const completedChunk = await streamOneParagraph(textChunk.text, settings, (chunk) => {
            renderer.append(restoreInlineTokens(chunk, protection));
          }, run);
          const restoredCompletedChunk = restoreInlineTokens(completedChunk, protection);
          appendMissingStreamResult(renderer, beforeChunk, restoredCompletedChunk);
          completedTranslation += restoredCompletedChunk;
        }
      }
      if (textChunk.separator) {
        renderer.append(textChunk.separator);
        completedTranslation += textChunk.separator;
      }
    }
    const finalText = formatTranslationResult(completedTranslation || restoreInlineTokens(renderer.getText(), protection));
    if (!isUsableTranslationResult(selected, finalText)) {
      throw new Error("模型没有返回有效的中文译文");
    }
    target.dataset.state = "done";
    renderer.finish(finalText);
  } catch (error) {
    target.dataset.state = "error";
    const partialText = renderer.getText();
    renderer.finish(
      partialText && !hasUnresolvedProtectedPlaceholder(partialText)
        ? partialText
        : humanizeStreamError(error, settings)
    );
  } finally {
    run.ports?.forEach((port) => port.disconnect());
    run.ports?.clear();
  }
}

async function markSelectedTranslationText(fallbackText = "", explicitSettings = null) {
  const scrollPosition = capturePageScrollPosition();
  const selection = window.getSelection();
  const currentText = normalizeSelectedText(selection?.toString() || "");
  const selectedText = currentText || normalizeSelectedText(fallbackText || lastPageSelection?.text || "");
  const range = getMarkableSelectionRange(selection, selectedText);
  const sourceRect = getRangeVisualRect(range);
  const toolbarMarkButton = document.querySelector(`.${SELECTION_TOOLBAR_CLASS} .pit-selection-action.is-mark`);
  let didMark = false;
  if (!range || !selectedText) {
    hideSelectionToolbar();
    return false;
  }
  const container = range.commonAncestorContainer instanceof Element
    ? range.commonAncestorContainer
    : range.commonAncestorContainer.parentElement;
  if (container?.closest?.(`.${ASK_PANEL_CLASS}, .${SELECTION_TOOLBAR_CLASS}, .pit-mark-note-composer, textarea, input, select, button`)) {
    hideSelectionToolbar();
    return false;
  }
  const settings = explicitSettings
    ? { ...DEFAULT_OLLAMA, ...explicitSettings, noteSaveShortcut: normalizeNoteSaveShortcut(explicitSettings.noteSaveShortcut) }
    : await getCurrentPanelSettings();
  const mark = document.createElement("span");
  mark.className = "pit-manual-mark";
  mark.dataset.pitPageUrl = location.href;
  mark.dataset.pitMarkStyle = settings.markStyle || DEFAULT_OLLAMA.markStyle;
  mark.style.setProperty("--pit-mark-highlight-color", getMarkHighlightColor(settings));
  try {
    const content = range.extractContents();
    mark.appendChild(content);
    range.insertNode(mark);
    selection.removeAllRanges();
    lastPageSelection = null;
    didMark = true;
    setPanelStatus(document.querySelector(`.${ASK_PANEL_CLASS}`), "已标记选中内容。");
    const noteTarget = appendMarkedTextToNote(selectedText, settings);
    showMarkedTextFeedback({
      markedNode: mark,
      sourceRect,
      selectedText,
      panel: noteTarget?.panel,
      input: noteTarget?.input
    });
    showMarkButtonSuccess(toolbarMarkButton);
    return true;
  } catch {
    setPanelStatus(document.querySelector(`.${ASK_PANEL_CLASS}`), "这段内容暂时无法标记。");
    return false;
  } finally {
    if (didMark && toolbarMarkButton) {
      setTimeout(hideSelectionToolbar, 420);
    } else {
      hideSelectionToolbar();
    }
    restorePageScrollPosition(scrollPosition);
  }
}

function getRangeVisualRect(range) {
  if (!range) return null;
  const rects = Array.from(range.getClientRects ? range.getClientRects() : []);
  const visibleRect = rects.find((rect) => rect.width > 0 && rect.height > 0);
  if (visibleRect) return visibleRect;
  const rect = range.getBoundingClientRect?.();
  return rect && (rect.width || rect.height) ? rect : null;
}

function getMarkableSelectionRange(selection, selectedText) {
  if (selection?.rangeCount && normalizeSelectedText(selection.toString() || "")) {
    const currentRange = selection.getRangeAt(0);
    lastPageSelection = { text: selectedText, range: currentRange.cloneRange() };
    return currentRange;
  }

  const snapshot = lastPageSelection;
  if (!snapshot?.range || !document.contains(snapshot.range.commonAncestorContainer)) return null;
  if (selectedText && snapshot.text && selectedText !== snapshot.text) return null;
  return snapshot.range.cloneRange();
}

function capturePageSelectionSnapshot() {
  const selection = window.getSelection();
  const text = normalizeSelectedText(selection?.toString() || "");
  if (!selection?.rangeCount || !text) return;
  const range = selection.getRangeAt(0);
  const container = range.commonAncestorContainer instanceof Element
    ? range.commonAncestorContainer
    : range.commonAncestorContainer.parentElement;
  if (container?.closest?.(`.${ASK_PANEL_CLASS}, .${SELECTION_TOOLBAR_CLASS}, .pit-mark-note-composer, textarea, input, select, button`)) return;
  lastPageSelection = { text, range: range.cloneRange() };
}

function appendMarkedTextToNote(text, settings = undefined) {
  const selected = normalizeSelectedText(text);
  if (!selected) return null;
  return appendMarkdownLineToNote(formatMarkedTextMarkdown(selected), settings, "已标记并发送到笔记，草稿已自动保存。");
}

function hasHoverNoteContent(composer) {
  return Boolean(composer?.dataset.savedNote
    || normalizeHoverNoteMarkdown(composer?.querySelector(".pit-mark-note-input")?.value || ""));
}

function syncHoverNoteAddTriggers(node) {
  const target = hoverNoteCommandPressed ? getHoverNoteTarget(node) : null;
  const activeComposer = hoverNoteCommandPressed ? node?.closest?.(".pit-mark-note-composer") : null;
  hoverNoteComposers.forEach((composer, candidate) => {
    composer.classList.toggle("is-add-trigger-enabled", candidate === target || composer === activeComposer);
  });
  if (!target) cancelHoverNoteShow();
  return target;
}

function handleHoverNoteModifierChange(event) {
  const wasPressed = hoverNoteCommandPressed;
  hoverNoteCommandPressed = event.metaKey;
  if (wasPressed === hoverNoteCommandPressed) return;
  const node = hasHoverNotePointer
    ? document.elementFromPoint(lastMousePoint.x, lastMousePoint.y)
    : null;
  syncHoverNoteAddTriggers(node);
  if (hoverNoteCommandPressed && node) {
    handleHoverNotePointerOver({ target: node, metaKey: true });
  }
}

function handleHoverNotePointerOver(event) {
  if (event.pointerType === "touch") return;
  if (Number.isFinite(event.clientX) && Number.isFinite(event.clientY)) {
    lastMousePoint = { x: event.clientX, y: event.clientY };
    hasHoverNotePointer = true;
  }
  hoverNoteCommandPressed = Boolean(event.metaKey);
  syncHoverNoteAddTriggers(event.target);
  const composerUnderPointer = event.target?.closest?.(".pit-mark-note-composer");
  if (composerUnderPointer) {
    if (!hoverNoteCommandPressed && !hasHoverNoteContent(composerUnderPointer)
      && !composerUnderPointer.matches(":focus-within")) return;
    cancelHoverNoteHide();
    activateHoverNoteHotZone(composerUnderPointer);
    return;
  }
  const target = getHoverNoteTarget(event.target);
  clearInactiveHoverNoteTargets(target);
  if (!target) {
    if (event.target?.closest?.(".pit-mark-note-composer")) cancelHoverNoteHide();
    return;
  }
  cancelHoverNoteHide();
  const savedComposer = hoverNoteComposers.get(target);
  if (!hoverNoteCommandPressed && !hasHoverNoteContent(savedComposer)) return;
  if (savedComposer?.isConnected) {
    cancelHoverNoteShow();
    hoverNoteTarget = target;
    hoverNoteComposer = savedComposer;
    savedComposer.classList.add("is-target-hovered");
    savedComposer.classList.remove("is-hiding");
    savedComposer.classList.toggle("is-open", !savedComposer.classList.contains("is-closed"));
    savedComposer.hidden = false;
    savedComposer.classList.add("is-visible");
    positionHoverNoteComposer(savedComposer, target);
    return;
  }
  if (target === hoverNoteTarget && hoverNoteComposer?.isConnected) {
    hoverNoteComposer.classList.add("is-target-hovered");
    positionHoverNoteComposer(hoverNoteComposer, target);
    return;
  }
  if (hoverNoteComposer?.matches(":focus-within") || normalizeHoverNoteMarkdown(hoverNoteComposer?.querySelector(".pit-mark-note-input")?.value || "")) {
    return;
  }
  scheduleHoverNoteShow(target);
}

function handleHoverNotePointerOut(event) {
  if (event.pointerType === "touch") return;
  hoverNoteCommandPressed = Boolean(event.metaKey);
  syncHoverNoteAddTriggers(event.relatedTarget);
  const fromTarget = getHoverNoteTarget(event.target);
  if (!fromTarget && !event.target?.closest?.(".pit-mark-note-composer")) return;
  const next = event.relatedTarget instanceof Element ? event.relatedTarget : null;
  const nextTarget = getHoverNoteTarget(next);
  if (fromTarget && nextTarget === fromTarget) return;
  const composer = fromTarget ? hoverNoteComposers.get(fromTarget) : hoverNoteComposer;
  if (next?.closest?.(".pit-mark-note-composer")) {
    composer?.classList.add("is-target-hovered");
    return;
  }
  cancelHoverNoteShow();
  scheduleHoverNoteHide();
}

function clearInactiveHoverNoteTargets(activeTarget = null) {
  hoverNoteComposers.forEach((composer, target) => {
    if (target !== activeTarget) composer.classList.remove("is-target-hovered");
  });
}

function getHoverNoteTarget(node) {
  const element = node instanceof Element ? node : node?.parentElement;
  if (!element) return null;
  if (element.closest(`.${ASK_PANEL_CLASS}, .${SELECTION_TOOLBAR_CLASS}, .pit-mark-note-composer, textarea, input, select, button, nav, header, footer, aside, [contenteditable="true"]`)) {
    return null;
  }
  const semanticTarget = element.closest([
    '[data-testid="tweetText"]',
    `.${TRANSLATION_CLASS}`,
    `.${REPLACED_CLASS}`,
    "p", "li", "blockquote", "figcaption", "dd", "dt", "td", "th",
    "h1", "h2", "h3", "h4", "h5", "h6",
    `.${PDF_BLOCK_CLASS}`
  ].join(","));
  const target = semanticTarget || findNearestReadableHoverBlock(element);
  if (!(target instanceof HTMLElement) || !isVisible(target)) return null;
  const text = normalizeSelectedText(target.innerText || target.textContent || "");
  if (!text) return null;
  return target;
}

function findNearestReadableHoverBlock(element) {
  let current = element;
  while (current instanceof HTMLElement && current !== document.body) {
    if (!current.matches("article, main, section, [role='main'], [role='article']")) {
      const style = window.getComputedStyle(current);
      const isBlock = /^(block|flow-root|list-item|table-cell|flex|grid)$/.test(style.display);
      const text = normalizeSelectedText(current.innerText || current.textContent || "");
      if (isBlock && text.length >= 2 && text.length <= 2400 && isVisible(current)) return current;
    }
    current = current.parentElement;
  }
  return null;
}

function showHoverNoteComposer(target) {
  cancelHoverNoteShow();
  if (!hoverNoteCommandPressed || !target.matches(":hover")) return;
  if (hoverNoteComposer && hoverNoteComposer !== hoverNoteComposers.get(target)) {
    dismissHoverNoteComposer(hoverNoteComposer);
  }
  hoverNoteTarget = target;
  hoverNoteComposer = hoverNoteComposers.get(target);
  let created = false;
  if (!hoverNoteComposer?.isConnected) {
    const composer = createHoverNoteComposer(target);
    hoverNoteComposer = composer;
    created = true;
    hoverNoteComposers.set(target, composer);
    hoverNoteResizeObserver?.observe(target);
    hoverNoteResizeObserver?.observe(composer);
    document.body.appendChild(composer);
  }
  if (!hoverNoteComposer.dataset.savedNote
    && !normalizeHoverNoteMarkdown(hoverNoteComposer.querySelector(".pit-mark-note-input")?.value || "")) {
    hoverNoteComposer.dataset.selectedText = getSelectedTextForNoteTarget(target);
  }
  hoverNoteComposer.hidden = false;
  hoverNoteComposer.classList.add("is-add-trigger-enabled");
  hoverNoteComposer.classList.remove("is-visible", "is-hiding");
  if (created) hoverNoteComposer.classList.remove("is-closed");
  hoverNoteComposer.classList.add("is-target-hovered");
  const isClosed = hoverNoteComposer.classList.contains("is-closed");
  hoverNoteComposer.classList.toggle("is-open", !isClosed);
  hoverNoteComposer.querySelector(".pit-mark-note-label")?.setAttribute("aria-expanded", String(!isClosed));
  hoverNoteComposer.querySelector(".pit-mark-note-label")?.setAttribute("aria-label", isClosed ? "添加笔记" : "关闭笔记");
  const composer = hoverNoteComposer;
  requestAnimationFrame(() => composer.classList.add("is-visible"));
  positionHoverNoteComposer(hoverNoteComposer, target);
}

function scheduleHoverNoteShow(target) {
  if (hoverNoteShowTimer && hoverNoteTarget === target) return;
  cancelHoverNoteShow();
  hoverNoteTarget = target;
  hoverNoteShowTimer = setTimeout(() => {
    hoverNoteShowTimer = null;
    if (!hoverNoteCommandPressed || hoverNoteTarget !== target || !target.matches(":hover")) return;
    showHoverNoteComposer(target);
  }, HOVER_NOTE_SHOW_DELAY_MS);
}

function cancelHoverNoteShow() {
  if (!hoverNoteShowTimer) return;
  clearTimeout(hoverNoteShowTimer);
  hoverNoteShowTimer = null;
}

function createHoverNoteComposer(target, settings = undefined) {
  const composer = document.createElement("div");
  composer.className = "pit-mark-note-composer is-hover-note";
  composer.dataset.pitPageUrl = location.href;
  composer.dataset.selectedText = getSelectedTextForNoteTarget(target);
  composer.dataset.savedNote = "";

  const label = document.createElement("button");
  label.className = "pit-mark-note-label";
  label.type = "button";
  label.setAttribute("aria-label", "添加笔记");
  label.setAttribute("aria-expanded", "false");

  const field = document.createElement("div");
  field.className = "pit-mark-note-field";

  const noteIcon = document.createElement("span");
  noteIcon.className = "pit-mark-note-icon";
  noteIcon.setAttribute("aria-hidden", "true");
  noteIcon.innerHTML = [
    '<svg viewBox="0 0 24 24" focusable="false">',
    '<path d="M4 20h4.25L19.6 8.65a2.35 2.35 0 0 0-3.32-3.32L4.93 16.68 4 20z"></path>',
    '<path d="M14.75 6.85l2.4 2.4M4 20h16"></path>',
    "</svg>"
  ].join("");

  const input = document.createElement("textarea");
  input.className = "pit-mark-note-input";
  input.rows = 1;
  setHoverNotePrompt(input);
  input.setAttribute("aria-label", "笔记");

  field.append(noteIcon, input);
  composer.append(label, field);

  const submit = () => submitHoverNote(composer, settings);
  const openFromHotZone = () => {
    hoverNoteTarget = target;
    hoverNoteComposer = composer;
    ensureHoverNoteDefaultPrefix(input);
    composer.hidden = false;
    composer.classList.add("is-visible", "is-target-hovered", "is-hot", "is-open");
    composer.classList.remove("is-closed", "is-hiding");
    label.setAttribute("aria-expanded", "true");
    label.setAttribute("aria-label", "关闭笔记");
    autosizeMarkedNoteInput(input);
    positionHoverNoteComposer(composer, target);
  };
  input.addEventListener("keydown", (event) => {
    primeHoverNoteInputForTyping(input, event);
    if (event.key === "Enter" && !event.shiftKey && !event.altKey && !event.isComposing) {
      event.preventDefault();
      insertTextareaListBreak(input);
    }
  });
  input.addEventListener("paste", () => clearHoverNotePrompt(input));
  input.addEventListener("input", () => {
    input.classList.toggle("is-prompt", input.value === HOVER_NOTE_PROMPT);
    const hasContent = Boolean(normalizeHoverNoteMarkdown(input.value));
    composer.classList.toggle("is-writing", hasContent);
    composer.classList.toggle("has-content", hasContent);
    if (hasContent) {
      composer.classList.remove("is-closed");
      composer.classList.add("is-open");
      label.setAttribute("aria-expanded", "true");
    }
    autosizeMarkedNoteInput(input);
  });
  input.addEventListener("focus", () => {
    ensureHoverNoteDefaultPrefix(input);
    autosizeMarkedNoteInput(input);
  });
  input.addEventListener("blur", () => {
    if (!normalizeHoverNoteMarkdown(input.value)) composer.classList.remove("is-writing");
    autosizeMarkedNoteInput(input);
    if (normalizeHoverNoteMarkdown(input.value)) {
      dismissHoverNoteComposer(composer, settings);
    } else if (!composer.dataset.savedNote) {
      scheduleHoverNoteHide();
    }
  });

  const openNoteField = () => {
    hoverNoteTarget = target;
    hoverNoteComposer = composer;
    ensureHoverNoteDefaultPrefix(input);
    composer.hidden = false;
    composer.classList.add("is-visible", "is-target-hovered");
    composer.classList.remove("is-closed");
    composer.classList.add("is-open");
    label.setAttribute("aria-expanded", "true");
    label.setAttribute("aria-label", "关闭笔记");
    focusWithoutPageScroll(input);
    autosizeMarkedNoteInput(input);
  };

  const closeNoteField = () => {
    const hasContent = Boolean(normalizeHoverNoteMarkdown(input.value) || composer.dataset.savedNote);
    composer.classList.toggle("has-content", hasContent);
    composer.classList.add("is-closed");
    composer.classList.remove("is-hot", "is-open");
    composer.classList.remove("is-writing");
    label.setAttribute("aria-expanded", "false");
    label.setAttribute("aria-label", "添加笔记");
    input.blur();
  };

  label.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (composer.classList.contains("is-closed")) {
      openNoteField();
    } else {
      closeNoteField();
    }
  });
  composer.addEventListener("mouseenter", () => {
    cancelHoverNoteHide();
    openFromHotZone();
    autosizeMarkedNoteInput(input);
  });
  composer.addEventListener("mouseleave", () => {
    if (composer.classList.contains("is-dragging")) return;
    scheduleHoverNoteHide();
  });
  composer.addEventListener("focusin", () => {
    cancelHoverNoteHide();
    autosizeMarkedNoteInput(input);
  });

  autosizeMarkedNoteInput(input);
  return composer;
}

function activateHoverNoteHotZone(composer) {
  if (!(composer instanceof HTMLElement)) return;
  const target = findHoverNoteTargetForComposer(composer);
  if (!(target instanceof HTMLElement)) return;
  hoverNoteTarget = target;
  hoverNoteComposer = composer;
  composer.hidden = false;
  composer.classList.add("is-visible", "is-target-hovered", "is-hot", "is-open");
  composer.classList.remove("is-closed", "is-hiding");
  const label = composer.querySelector(".pit-mark-note-label");
  label?.setAttribute("aria-expanded", "true");
  label?.setAttribute("aria-label", "关闭笔记");
  cancelHoverNoteHide();
  positionHoverNoteComposer(composer, target);
}

function scheduleHoverNoteHide() {
  cancelHoverNoteHide();
  hoverNoteHideTimer = setTimeout(() => {
    if (hoverNoteComposer?.matches(":hover, :focus-within")) {
      cancelHoverNoteHide();
      return;
    }
    const target = hoverNoteComposer ? findHoverNoteTargetForComposer(hoverNoteComposer) : hoverNoteTarget;
    if (target?.matches?.(":hover")) {
      cancelHoverNoteHide();
      return;
    }
    removeHoverNoteComposer();
  }, HOVER_NOTE_HIDE_DELAY_MS);
}

function dismissHoverNoteComposer(composer, settings = undefined) {
  if (!(composer instanceof HTMLElement)) return;
  cancelHoverNoteHide();
  const label = composer.querySelector(".pit-mark-note-label");
  const input = composer.querySelector(".pit-mark-note-input");
  const hasSavedNote = Boolean(composer.dataset.savedNote);
  const draft = normalizeHoverNoteMarkdown(input?.value || "");
  const hasDraft = Boolean(draft);
  composer.classList.remove("is-target-hovered", "is-hot", "is-open", "is-writing");
  composer.classList.add("is-closed");
  label?.setAttribute("aria-expanded", "false");
  label?.setAttribute("aria-label", "添加笔记");
  if (hasDraft && draft !== composer.dataset.savedNote) {
    submitHoverNote(composer, settings);
  } else if (hasSavedNote || hasDraft) {
    input?.blur();
    composer.classList.add("has-content");
  }
  if (hoverNoteComposer === composer) {
    hoverNoteComposer = null;
    hoverNoteTarget = null;
  }
}

function findHoverNoteTargetForComposer(composer) {
  for (const [target, candidate] of hoverNoteComposers) {
    if (candidate === composer) return target;
  }
  return null;
}

function cancelHoverNoteHide() {
  if (!hoverNoteHideTimer) return;
  clearTimeout(hoverNoteHideTimer);
  hoverNoteHideTimer = null;
}

function removeHoverNoteComposer(force = false) {
  cancelHoverNoteShow();
  cancelHoverNoteHide();
  if (force) {
    document.querySelectorAll(".pit-mark-note-composer.is-hover-note").forEach((composer) => composer.remove());
    hoverNoteResizeObserver?.disconnect();
    hoverNoteComposers.clear();
  } else if (hoverNoteComposer) {
    dismissHoverNoteComposer(hoverNoteComposer);
  }
  hoverNoteComposer = null;
  hoverNoteTarget = null;
}

function syncMarkedNotesForCurrentUrl() {
  const currentUrl = location.href;
  document.querySelectorAll(".pit-manual-mark").forEach((mark) => {
    const pageUrl = mark.dataset.pitPageUrl || currentUrl;
    mark.dataset.pitPageUrl = pageUrl;
    mark.classList.toggle("is-url-inactive", pageUrl !== currentUrl);
  });
  document.querySelectorAll(".pit-mark-note-composer").forEach((composer) => {
    const pageUrl = composer.dataset.pitPageUrl || currentUrl;
    composer.dataset.pitPageUrl = pageUrl;
    composer.hidden = pageUrl !== currentUrl;
  });
}

async function submitHoverNote(composer, settings = undefined) {
  if (!(composer instanceof HTMLElement)) return;
  if (composer.dataset.submittingNote === "true") return;
  const input = composer.querySelector(".pit-mark-note-input");
  const note = normalizeHoverNoteMarkdown(input?.value || "");
  if (!note) {
    composer.classList.add("is-empty");
    setTimeout(() => composer.classList.remove("is-empty"), 900);
    focusWithoutPageScroll(input);
    return;
  }

  try {
    composer.dataset.submittingNote = "true";
    const oldNote = composer.dataset.savedNote || "";
    const notePanelTarget = appendHoverNoteToPanel(note, composer.dataset.selectedText || "", settings, oldNote);
    if (!notePanelTarget) throw new Error("无法打开笔记面板。");
    composer.classList.remove("is-empty");
    composer.classList.add("has-note", "has-content", "is-sent");
    composer.classList.remove("is-closed");
    composer.classList.add("is-open");
    composer.querySelector(".pit-mark-note-label")?.setAttribute("aria-expanded", "true");
    composer.dataset.savedNote = note;
    composer.classList.remove("is-writing");
    autosizeMarkedNoteInput(input);
    const anchorTarget = findHoverNoteTargetForComposer(composer);
    if (anchorTarget) positionHoverNoteComposer(composer, anchorTarget);
    setTimeout(() => composer.classList.remove("is-sent"), 900);
  } catch (error) {
    console.warn("[PIT] failed to append hover note", error);
  } finally {
    delete composer.dataset.submittingNote;
  }
}

function autosizeMarkedNoteInput(input) {
  if (!(input instanceof HTMLTextAreaElement)) return;
  input.style.height = "auto";
  const maxHeight = Math.max(88, Math.min(320, Math.floor(window.innerHeight * 0.48)));
  const nextHeight = Math.min(maxHeight, Math.max(30, input.scrollHeight));
  input.style.height = `${nextHeight}px`;
  input.style.overflowY = input.scrollHeight > maxHeight ? "auto" : "hidden";
  scheduleHoverNotePositionSync();
}

function insertTextareaListBreak(input) {
  if (!(input instanceof HTMLTextAreaElement)) return;
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? start;
  const insertion = "\n- ";
  input.value = `${input.value.slice(0, start)}${insertion}${input.value.slice(end)}`;
  input.selectionStart = input.selectionEnd = start + insertion.length;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function ensureHoverNoteDefaultPrefix(input) {
  if (!(input instanceof HTMLTextAreaElement)) return;
  if (input.value) return;
  setHoverNotePrompt(input);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function setHoverNotePrompt(input) {
  if (!(input instanceof HTMLTextAreaElement)) return;
  input.value = HOVER_NOTE_PROMPT;
  input.classList.add("is-prompt");
  input.selectionStart = input.selectionEnd = 2;
}

function clearHoverNotePrompt(input) {
  if (!(input instanceof HTMLTextAreaElement) || input.value !== HOVER_NOTE_PROMPT) return;
  input.value = "- ";
  input.classList.remove("is-prompt");
  input.selectionStart = input.selectionEnd = input.value.length;
}

function primeHoverNoteInputForTyping(input, event) {
  if (!(input instanceof HTMLTextAreaElement) || input.value !== HOVER_NOTE_PROMPT) return;
  const keepsPrompt = [
    "Tab", "Shift", "Control", "Alt", "Meta", "Escape",
    "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"
  ].includes(event.key);
  if (keepsPrompt || event.metaKey || event.ctrlKey || event.altKey) return;
  clearHoverNotePrompt(input);
}

function getLiveMarkedNoteSettings(fallbackSettings = {}) {
  const panel = document.querySelector(`.${ASK_PANEL_CLASS}`);
  if (panel instanceof HTMLElement) {
    return readPanelSettings(panel);
  }
  return { ...DEFAULT_OLLAMA, ...lastKnownSettings, ...fallbackSettings };
}

function positionHoverNoteComposer(composer, target) {
  if (!(composer instanceof HTMLElement) || !(target instanceof HTMLElement)) return;
  if (!target.isConnected) {
    hoverNoteResizeObserver?.unobserve(composer);
    composer.remove();
    hoverNoteResizeObserver?.unobserve(target);
    hoverNoteComposers.delete(target);
    return;
  }
  const rect = target.getBoundingClientRect();
  const isInViewport = rect.bottom > 0
    && rect.top < window.innerHeight
    && rect.right > 0
    && rect.left < window.innerWidth;
  if (!isInViewport) {
    composer.dataset.viewportHidden = "true";
    composer.hidden = true;
    return;
  }
  if (composer.dataset.viewportHidden === "true") {
    delete composer.dataset.viewportHidden;
    composer.hidden = false;
  }
  const buttonSize = 18;
  const gap = 8;
  const left = Math.min(window.innerWidth - buttonSize - 8, Math.max(8, rect.right + gap));
  const paragraphCenter = rect.top + rect.height / 2;
  let top = Math.min(window.innerHeight - buttonSize - 8, Math.max(8, paragraphCenter - buttonSize / 2));
  const noteWidth = Math.min(310, window.innerWidth - 32);
  const spaceRight = window.innerWidth - (left + buttonSize + gap);
  const opensBelow = spaceRight < noteWidth;
  composer.classList.toggle("opens-below", opensBelow);

  const field = composer.querySelector(".pit-mark-note-field");
  const fieldHeight = Math.min(
    Math.max(field?.offsetHeight || composer.querySelector(".pit-mark-note-input")?.scrollHeight || 30, 30),
    Math.min(340, Math.floor(window.innerHeight * 0.48))
  );
  const viewportGap = 8;

  if (opensBelow) {
    const spaceBelow = window.innerHeight - (top + buttonSize + gap) - viewportGap;
    const spaceAbove = top - gap - viewportGap;
    composer.classList.toggle("opens-above", fieldHeight > spaceBelow && spaceAbove >= spaceBelow);
  } else {
    composer.classList.remove("opens-above");
    const minTop = viewportGap + fieldHeight / 2 - buttonSize / 2;
    const maxTop = window.innerHeight - viewportGap - fieldHeight / 2 - buttonSize / 2;
    top = Math.min(Math.max(minTop, top), Math.max(minTop, maxTop));
  }

  composer.style.left = `${Math.round(left)}px`;
  composer.style.top = `${Math.round(top)}px`;
}

function enableHoverNoteDragging(composer, field, handle) {
  let drag = null;

  const move = (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault();
    const left = Math.min(
      window.innerWidth - drag.width - 8,
      Math.max(8, drag.left + event.clientX - drag.startX)
    );
    const top = Math.min(
      window.innerHeight - drag.height - 8,
      Math.max(8, drag.top + event.clientY - drag.startY)
    );
    composer.style.setProperty("--pit-note-drag-left", `${Math.round(left)}px`);
    composer.style.setProperty("--pit-note-drag-top", `${Math.round(top)}px`);
  };

  const stop = (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag = null;
    composer.classList.remove("is-dragging");
    composer.classList.add("is-visible");
    if (normalizeHoverNoteMarkdown(composer.querySelector(".pit-mark-note-input")?.value || "")) {
      composer.classList.add("has-content");
    }
    handle.releasePointerCapture?.(event.pointerId);
    document.removeEventListener("pointermove", move);
    document.removeEventListener("pointerup", stop);
    document.removeEventListener("pointercancel", stop);
  };

  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = field.getBoundingClientRect();
    drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height
    };
    composer.classList.add("is-dragged", "is-dragging");
    composer.classList.remove("is-closed");
    composer.classList.add("is-open");
    composer.style.setProperty("--pit-note-drag-left", `${Math.round(rect.left)}px`);
    composer.style.setProperty("--pit-note-drag-top", `${Math.round(rect.top)}px`);
    handle.setPointerCapture?.(event.pointerId);
    document.addEventListener("pointermove", move, { passive: false });
    document.addEventListener("pointerup", stop);
    document.addEventListener("pointercancel", stop);
  });
}

function scheduleHoverNotePositionSync() {
  if (hoverNotePositionFrame) return;
  hoverNotePositionFrame = requestAnimationFrame(() => {
    hoverNotePositionFrame = 0;
    hoverNoteComposers.forEach((composer, target) => {
      if (!composer.isConnected || !target.isConnected) {
        hoverNoteResizeObserver?.unobserve(composer);
        composer.remove();
        hoverNoteResizeObserver?.unobserve(target);
        hoverNoteComposers.delete(target);
        return;
      }
      positionHoverNoteComposer(composer, target);
    });
  });
}

function getSelectedTextForNoteTarget(target) {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return "";
  const selectedText = normalizeSelectedText(selection.toString() || "");
  if (!selectedText) return "";
  const range = selection.getRangeAt(0);
  if (!target.contains(range.startContainer) || !target.contains(range.endContainer)) return "";
  return selectedText;
}

function appendHoverNoteToPanel(note, selectedText, settings = undefined, oldNote = "") {
  const value = normalizeUserNoteMarkdown(note);
  const selection = normalizeSelectedText(selectedText);
  if (!value) return null;
  const scrollPosition = capturePageScrollPosition();
  const panel = openAskPanel(settings, { focus: false, visible: false });
  activateReaderTab(panel, "notes");
  const input = panel.querySelector(".pit-panel-note");
  if (!input) return null;
  panel.dataset.appendingSelection = "true";
  // Adding a note from the page must not steal keyboard focus from the page.
  // The panel can be hidden here, so focusing its textarea would redirect
  // subsequent copy/paste shortcuts away from the webpage.
  editNoteMarkdown(panel, { focus: false });
  panel.dataset.appendingSelection = "false";
  const result = insertHoverNote(input.value, selection, value, oldNote);
  input.value = result.markdown;
  input.selectionStart = input.selectionEnd = result.cursor;
  input.scrollTop = input.scrollHeight;
  scrollNotesAreaToBottom(panel);
  persistNoteDraft(panel);
  prepareOriginalSummary(settings);
  restorePageScrollPosition(scrollPosition);
  showPanelReceiveFeedback(panel, input);
  return { panel, input };
}

function insertHoverNote(markdown, selectedText, note, oldNote = "") {
  const source = String(markdown || "");
  const selectionLine = selectedText
    ? `- 选中内容：${escapeMarkdownInline(selectedText).replace(/\n+/g, " / ")}`
    : "";
  const noteMarkdown = formatNoteMarkdownForInsertion(note);
  const oldNoteMarkdown = oldNote ? formatNoteMarkdownForInsertion(oldNote) : "";
  const legacyPrefix = selectionLine ? "  - 笔记：" : "- 笔记：";
  const legacyOldNote = oldNote ? `${legacyPrefix}${escapeMarkdownInline(oldNote).replace(/\n+/g, " / ")}` : "";

  if (oldNoteMarkdown) {
    const contextIndex = selectionLine ? source.lastIndexOf(selectionLine) : 0;
    const searchStart = contextIndex >= 0 ? contextIndex : 0;
    let oldIndex = source.indexOf(oldNoteMarkdown, searchStart);
    let oldLength = oldNoteMarkdown.length;
    if (oldIndex < 0 && legacyOldNote) {
      oldIndex = source.indexOf(legacyOldNote, searchStart);
      oldLength = legacyOldNote.length;
    }
    if (oldIndex >= 0) {
      const markdownValue = `${source.slice(0, oldIndex)}${noteMarkdown}${source.slice(oldIndex + oldLength)}`;
      return { markdown: markdownValue, cursor: oldIndex + noteMarkdown.length };
    }
  }

  const prefix = source.trim() ? (source.endsWith("\n") ? "\n" : "\n\n") : "";
  const insertion = selectionLine
    ? `${prefix}${selectionLine}\n\n${noteMarkdown}\n`
    : `${prefix}${noteMarkdown}\n`;
  return { markdown: `${source}${insertion}`, cursor: source.length + insertion.length };
}

function normalizeUserNoteMarkdown(markdown) {
  return String(markdown || "")
    .replace(/\r\n?/g, "\n")
    .replace(/\u00A0/g, " ")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/^(#{1,6})([^\s#])/gm, "$1 $2")
    .replace(/^(\s*)([-+*])([^\s])/gm, "$1$2 $3")
    .replace(/^(\s*)(\d+[.)])([^\s])/gm, "$1$2 $3")
    .replace(/^(\s*>)([^\s>])/gm, "$1 $2")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeHoverNoteMarkdown(markdown) {
  const normalized = normalizeUserNoteMarkdown(markdown);
  const source = normalized === HOVER_NOTE_PROMPT ? "- " : normalized;
  return source
    .split("\n")
    .filter((line) => !/^\s*(?:[-+*]|\d+[.)])\s*$/.test(line))
    .join("\n")
    .trim();
}

function formatNoteMarkdownForInsertion(markdown) {
  const normalized = normalizeUserNoteMarkdown(markdown);
  if (!normalized) return "";
  if (normalized.includes("\n") || hasMarkdownBlockSyntax(normalized)) {
    return normalized;
  }

  return `- ${normalized}`;
}

function hasMarkdownBlockSyntax(markdown) {
  return /^(?:\s{0,3}(?:[-+*]\s+|\d+[.)]\s+|#{1,6}\s+|>\s+|```|~~~)|\s{4}\S)/m.test(String(markdown || ""));
}

function formatMarkedTextMarkdown(text) {
  const value = normalizeSelectedText(text);
  if (!value) return "";
  return `- 标记内容：${escapeMarkdownInline(value).replace(/\n+/g, " / ")}`;
}

async function getCurrentPanelSettings() {
  const panel = document.querySelector(`.${ASK_PANEL_CLASS}`);
  if (panel) return readPanelSettings(panel);
  const stored = await chrome.storage.sync.get(DEFAULT_OLLAMA);
  lastKnownSettings = { ...DEFAULT_OLLAMA, ...stored };
  return lastKnownSettings;
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

function appendMarkdownLineToNote(markdown, settings = undefined, status = "已发送到笔记，草稿已自动保存。") {
  const value = String(markdown || "").trim();
  if (!value) return null;
  const scrollPosition = capturePageScrollPosition();
  const panel = openAskPanel(settings, { focus: false, visible: false });
  activateReaderTab(panel, "notes");
  const input = panel.querySelector(".pit-panel-note");
  panel.dataset.appendingSelection = "true";
  // Marking text also appends an automatic note. Keep the page focused so
  // normal Ctrl/Cmd+C and Ctrl/Cmd+V continue to target the webpage.
  editNoteMarkdown(panel, { focus: false });
  panel.dataset.appendingSelection = "false";
  const insertion = `${input.value.trim() ? "\n\n" : ""}${value}\n`;
  const start = input.value.length;
  const end = input.value.length;
  input.value = `${input.value.slice(0, start)}${insertion}${input.value.slice(end)}`;
  input.selectionStart = input.selectionEnd = start + insertion.length;
  input.scrollTop = input.scrollHeight;
  scrollNotesAreaToBottom(panel);
  persistNoteDraft(panel);
  prepareOriginalSummary(settings);
  hideSelectionToolbar();
  restorePageScrollPosition(scrollPosition);
  return { panel, input };
}

const noteCleaningStates = new WeakMap();

function prepareOriginalSummary(settings = undefined) {
  if (lastOriginalSummary) return Promise.resolve(lastOriginalSummary);
  if (originalSummaryPromise) return originalSummaryPromise;

  const sourceUrl = location.href;
  const page = getPageBundle();
  const resolvedSettings = settings
    ? { ...DEFAULT_OLLAMA, ...settings }
    : { ...DEFAULT_OLLAMA, ...lastKnownSettings };
  originalSummaryPromise = sendRuntimeMessageWithTimeout({
    type: "BUILD_ORIGINAL_SUMMARY",
    page,
    settings: resolvedSettings
  }, 22000, "原文总结生成超时。")
    .then((response) => {
      if (!response?.ok) throw new Error(response?.error || "原文总结生成失败。");
      if (location.href !== sourceUrl) return "";
      lastOriginalSummary = String(response.originalSummary || "").trim();
      return lastOriginalSummary;
    })
    .catch((error) => {
      console.warn("[PIT] original summary preparation failed", error);
      return "";
    })
    .finally(() => {
      originalSummaryPromise = null;
    });
  return originalSummaryPromise;
}

function requestNoteCleaning(panel, settings = undefined, options = {}) {
  if (!(panel instanceof HTMLElement)) return;
  const state = noteCleaningStates.get(panel) || {
    running: false,
    pending: false,
    settings: undefined,
    silent: false
  };
  state.pending = true;
  state.settings = settings;
  state.silent = Boolean(options.silent);
  noteCleaningStates.set(panel, state);
  if (!state.running) runNoteCleaning(panel, state);
}

async function runNoteCleaning(panel, state) {
  state.running = true;
  try {
    while (state.pending && panel.isConnected) {
      state.pending = false;
      const input = panel.querySelector(".pit-panel-note");
      const original = input?.value.trim() || "";
      if (!original) continue;

      const response = await sendRuntimeMessageWithTimeout({
        type: "CLEAN_NOTE_CONTENT",
        note: original,
        settings: state.settings
          ? { ...DEFAULT_OLLAMA, ...state.settings }
          : readPanelSettings(panel)
      }, 30000, "笔记清洗超时。");

      if (!response?.ok) throw new Error(response?.error || "笔记清洗失败。");
      if (!input || input.value.trim() !== original) {
        state.pending = true;
        continue;
      }

      const cleaned = String(response.cleanedNote || "").trim();
      if (cleaned && cleaned !== original) {
        input.value = `${cleaned}\n`;
        input.selectionStart = input.selectionEnd = input.value.length;
        persistNoteDraft(panel);
        if (!state.silent) setPanelStatus(panel, "笔记已清洗，重复内容已删除。");
      } else {
        if (!state.silent) setPanelStatus(panel, "笔记已检查，没有发现重复内容。");
      }
    }
  } catch (error) {
    if (!state.silent) setPanelStatus(panel, `${humanizeRuntimeError(error)} 原始笔记已保留。`);
  } finally {
    state.running = false;
    if (state.pending && panel.isConnected) runNoteCleaning(panel, state);
  }
}

function showMarkedTextFeedback({ markedNode, sourceRect, selectedText, panel, input }) {
  showMarkedNodeConfirmation(markedNode);
  showPanelReceiveFeedback(panel, input);
  flyMarkedTextToPanel(sourceRect, selectedText, panel, input);
}

function showMarkedNodeConfirmation(markedNode) {
  if (!(markedNode instanceof HTMLElement)) return;
  markedNode.classList.add("is-confirmed");
  setTimeout(() => markedNode.classList.remove("is-confirmed"), 1200);
}

function showPanelReceiveFeedback(panel, input) {
  if (panel instanceof HTMLElement) {
    panel.classList.remove("is-receiving-mark");
    void panel.offsetWidth;
    panel.classList.add("is-receiving-mark");
    setTimeout(() => panel.classList.remove("is-receiving-mark"), 1200);
  }
  if (input instanceof HTMLElement) {
    input.classList.remove("is-receiving-mark");
    void input.offsetWidth;
    input.classList.add("is-receiving-mark");
    input.scrollTop = input.scrollHeight;
    scrollNotesAreaToBottom(panel);
    setTimeout(() => input.classList.remove("is-receiving-mark"), 1600);
  }
}

function scrollNotesAreaToBottom(panel) {
  const area = panel?.querySelector?.('.pit-reader-panel-section[data-reader-panel="notes"]');
  if (area) area.scrollTop = area.scrollHeight;
}

function flyMarkedTextToPanel(sourceRect, selectedText, panel, input) {
  if (!sourceRect || window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) return;
  const target = input instanceof HTMLElement ? input : panel;
  if (!(target instanceof HTMLElement)) return;
  const targetRect = target.getBoundingClientRect();
  if (!targetRect.width || !targetRect.height) return;
  const flyout = document.createElement("div");
  flyout.className = "pit-mark-flyout";
  flyout.textContent = compactFeedbackText(selectedText);
  const startX = sourceRect.left + Math.min(sourceRect.width / 2, 120);
  const startY = sourceRect.top + Math.min(sourceRect.height / 2, 24);
  const endX = targetRect.left + Math.min(targetRect.width - 28, Math.max(28, targetRect.width * 0.68));
  const endY = targetRect.top + Math.min(targetRect.height - 28, Math.max(28, targetRect.height * 0.82));
  flyout.style.left = `${startX}px`;
  flyout.style.top = `${startY}px`;
  flyout.style.setProperty("--pit-fly-x", `${endX - startX}px`);
  flyout.style.setProperty("--pit-fly-y", `${endY - startY}px`);
  document.body.appendChild(flyout);
  requestAnimationFrame(() => flyout.classList.add("is-flying"));
  setTimeout(() => flyout.remove(), 720);
}

function compactFeedbackText(text) {
  const chars = Array.from(normalizeSelectedText(text));
  return chars.length > 24 ? `${chars.slice(0, 24).join("")}...` : chars.join("");
}

function showMarkButtonSuccess(button) {
  if (!(button instanceof HTMLElement)) return;
  button.dataset.feedback = "success";
  setTimeout(() => {
    if (button.dataset.feedback === "success") delete button.dataset.feedback;
  }, 520);
}

function normalizeSelectedText(text) {
  return normalizeTextPreserveBreaks(text);
}

function persistPanelSettings(settings) {
  const store = chrome.storage?.sync;
  if (!store?.set) return;
  store.set({
    provider: settings.provider,
    providerConfigs: settings.providerConfigs,
    mode: settings.mode,
    translationStyle: settings.translationStyle,
    shortTextReplaceMode: settings.shortTextReplaceMode,
    markStyle: settings.markStyle,
    markHighlightColor: settings.markHighlightColor,
    markHighlightColorLight: settings.markHighlightColorLight,
    markHighlightColorDark: settings.markHighlightColorDark,
    noteSaveShortcut: "auto",
    model: settings.model,
    baseUrl: settings.baseUrl,
    apiKey: settings.apiKey,
    translationFontSize: settings.translationFontSize,
    translationLineHeight: settings.translationLineHeight,
    autoOpenPanel: settings.autoOpenPanel,
    saveDir: settings.saveDir,
    summaryPrompt: settings.summaryPrompt,
    allowWebSearch: settings.allowWebSearch,
    localQaUrl: settings.localQaUrl,
    localQaNotesDir: settings.localQaNotesDir
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

async function getNoteMarkdownForSave(panel) {
  // restoreNoteDraft is deliberately non-blocking for panel rendering, but a
  // save must not race it. Awaiting the per-panel promise also makes the three
  // save routes consume exactly the same source of truth.
  await panel?.__pitDraftRestorePromise;
  return getNoteMarkdown(panel).trim();
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
      const hasUnsavedContent = hasMeaningfulNoteContent(draft);
      updateUnsavedNotePrompt(hasUnsavedContent);
      if (hasUnsavedContent) setPanelStatus(panel, "已恢复未保存的笔记草稿。");
    }
  } catch {
    // 草稿恢复失败不影响正常使用。
  }
}

function persistNoteDraft(panel) {
  const note = getNoteMarkdown(panel);
  const entries = Object.fromEntries(getNoteDraftKeys().map((key) => [key, note]));
  updateUnsavedNotePrompt(hasMeaningfulNoteContent(note));
  if (!chrome.storage?.local?.set) return;
  chrome.storage.local.set(entries).catch(() => {
    // 自动草稿失败时不打断编辑。
  });
}

function hasMeaningfulNoteContent(note) {
  const value = String(note || "").trim();
  if (!value) return false;
  // Focusing an empty editor inserts a Markdown heading prefix for convenience.
  // That prefix is an editor placeholder, not a written note or a page mark.
  return !/^#{1,6}$/.test(value);
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
  updateUnsavedNotePrompt(false);
}

function updateUnsavedNotePrompt(visible) {
  let prompt = document.querySelector(".pit-unsaved-note-prompt");
  if (!visible) {
    prompt?.remove();
    return;
  }
  if (!prompt) {
    prompt = document.createElement("div");
    prompt.className = "pit-unsaved-note-prompt";
    prompt.innerHTML = [
      '<div class="pit-unsaved-note-copy"><span>笔记尚未保存</span><small hidden></small></div>',
      '<button type="button">保存</button>'
    ].join("");
    prompt.querySelector("button")?.addEventListener("click", async () => {
      const button = prompt.querySelector("button");
      button.disabled = true;
      button.textContent = "保存中";
      try {
        const settings = await getCurrentPanelSettings();
        const panel = openAskPanel(settings, { focus: false, visible: false });
        await savePanelMarkdown(panel);
      } finally {
        if (prompt.isConnected) {
          button.disabled = false;
          button.textContent = "保存";
        }
      }
    });
    document.body.appendChild(prompt);
    updateUnsavedNoteShortcutHint(prompt);
  }
}

async function updateUnsavedNoteShortcutHint(prompt) {
  const hint = prompt?.querySelector?.(".pit-unsaved-note-copy small");
  if (!(hint instanceof HTMLElement)) return;
  hint.hidden = true;
  hint.textContent = "";
  try {
    const response = await safeRuntimeMessage({
      type: "GET_COMMAND_SHORTCUT",
      command: "save_page"
    });
    const shortcut = String(response?.shortcut || "").trim();
    if (!response?.ok || !shortcut || !prompt.isConnected) return;
    hint.textContent = `快捷键：${shortcut}`;
    hint.hidden = false;
  } catch {
    // 读取不到实时快捷键时不展示提示。
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

function editNoteMarkdown(panel, { focus = true } = {}) {
  const input = panel.querySelector(".pit-panel-note");
  const render = panel.querySelector(".pit-note-render");
  if (!input || !render) return;
  render.hidden = true;
  input.hidden = false;
  if (focus) focusWithoutPageScroll(input);
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

function normalizeNoteSaveShortcut(value) {
  return value === "cmdEnter" ? "cmdEnter" : "enter";
}

function normalizeColor(value, fallback = DEFAULT_OLLAMA.markHighlightColorLight) {
  const text = String(value || "").trim();
  return /^#[0-9a-fA-F]{6}$/.test(text) ? text : fallback;
}

function getStoredMarkColor(settings = {}, theme = "light") {
  if (theme === "dark") {
    return normalizeColor(settings.markHighlightColorDark, DEFAULT_OLLAMA.markHighlightColorDark);
  }
  return normalizeColor(
    settings.markHighlightColorLight || settings.markHighlightColor,
    DEFAULT_OLLAMA.markHighlightColorLight
  );
}

function getMarkHighlightColor(settings = {}) {
  const theme = detectPageTheme();
  return getStoredMarkColor(settings, theme);
}

function detectPageTheme() {
  const themeHint = [
    document.documentElement?.dataset?.theme,
    document.body?.dataset?.theme,
    document.documentElement?.className,
    document.body?.className,
    document.documentElement?.getAttribute?.("color-scheme"),
    document.documentElement?.style?.colorScheme
  ].join(" ").toLowerCase();

  if (/\bdark\b|theme-dark|dark-mode|night/.test(themeHint)) return "dark";
  if (/\blight\b|theme-light|light-mode/.test(themeHint)) return "light";

  const background = getEffectivePageBackground();
  if (background) {
    return getRelativeLuminance(background) < 0.48 ? "dark" : "light";
  }

  return window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ? "dark" : "light";
}

function getEffectivePageBackground() {
  const candidates = [document.body, document.documentElement];
  for (const node of candidates) {
    const parsed = parseCssRgb(getComputedStyle(node).backgroundColor);
    if (parsed && parsed.a > 0.05) return parsed;
  }
  return null;
}

function parseCssRgb(value) {
  const match = String(value || "").match(/rgba?\(([^)]+)\)/i);
  if (!match) return null;
  const parts = match[1].split(/,\s*|\s+/).filter((part) => part && part !== "/");
  const [r, g, b] = parts.map((part) => Number.parseFloat(part));
  if (![r, g, b].every(Number.isFinite)) return null;
  const a = Number.isFinite(Number.parseFloat(parts[3])) ? Number.parseFloat(parts[3]) : 1;
  return { r, g, b, a };
}

function getRelativeLuminance({ r, g, b }) {
  const [sr, sg, sb] = [r, g, b].map((channel) => {
    const value = Math.min(255, Math.max(0, channel)) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * sr + 0.7152 * sg + 0.0722 * sb;
}

function initMarkThemeWatcher() {
  lastDetectedPageTheme = detectPageTheme();
  window.matchMedia?.("(prefers-color-scheme: dark)")?.addEventListener?.("change", refreshMarkColorsForCurrentTheme);
  setInterval(() => {
    const theme = detectPageTheme();
    if (theme === lastDetectedPageTheme) return;
    lastDetectedPageTheme = theme;
    refreshMarkColorsForCurrentTheme();
  }, 2000);
}

function initSettingsSyncWatcher() {
  chrome.storage?.onChanged?.addListener?.((changes, areaName) => {
    if (areaName !== "sync") return;
    const settings = {};
    for (const [key, change] of Object.entries(changes || {})) {
      if (key in DEFAULT_OLLAMA || key === "saveDir" || key === "apiKey" || key === "summaryPrompt") {
        settings[key] = change.newValue;
      }
    }
    if (Object.keys(settings).length) {
      lastKnownSettings = { ...lastKnownSettings, ...settings };
    }
    const panel = document.querySelector(`.${ASK_PANEL_CLASS}`);
    if (!(panel instanceof HTMLElement)) return;
    applyExternalSettingsToPanel(panel, settings);
  });
}

async function refreshMarkColorsForCurrentTheme() {
  const panel = document.querySelector(`.${ASK_PANEL_CLASS}`);
  const settings = panel ? readPanelSettings(panel) : await getCurrentPanelSettings();
  applyMarkColorToPage(settings);
}

async function loadPanelOverview(panel) {
  const page = getPageBundle();
  const response = await sendRuntimeMessageWithTimeout({
    type: "BUILD_ARTICLE_OVERVIEW",
    page,
    settings: readPanelSettings(panel)
  }, OVERVIEW_TIMEOUT_MS, "文章脉络生成超时，请稍后重试或切换更小的本地模型。");
  if (!response?.ok) throw new Error(response?.error || "生成文章脉络失败。");
  const overviewMarkdown = response.overview || "文章脉络为空。";
  lastSummaryText = overviewMarkdown;
  panel.querySelector(".pit-ask-overview").innerHTML = renderMiniMarkdown(overviewMarkdown);
  prepareNoteTitle({ ...page, summary: overviewMarkdown }, getNoteMarkdown(panel).trim(), readPanelSettings(panel));
  scrollAskAreaToTop(panel);
}

function prepareNoteTitle(page, note, settings) {
  sendRuntimeMessageWithTimeout({
    type: "GENERATE_NOTE_TITLE",
    page,
    note,
    settings
  }, 15000, "标题生成超时。")
    .then((response) => {
      if (response?.ok && response.noteTitle) {
        lastNoteTitle = response.noteTitle;
      }
    })
    .catch((error) => {
      console.warn("[PIT] note title preparation failed", error);
    });
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
      allowWebSearch: readPanelSettings(panel).allowWebSearch,
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

// ─── PDF 内容抽取 ─────────────────────────────────────────────
async function ensurePdfContentSections() {
  const sources = collectPdfSources();
  if (!sources.length) return { loaded: 0, message: "" };

  let loaded = 0;
  let failed = 0;
  for (const source of sources.slice(0, MAX_PDFS_PER_PAGE)) {
    if (findPdfContentSection(source.url)) {
      loaded += 1;
      continue;
    }

    try {
      const text = await extractPdfTextFromUrl(source.url);
      const paragraphs = splitPdfTextIntoParagraphs(text);
      if (!paragraphs.length) {
        failed += 1;
        continue;
      }
      insertPdfContentSection(source, paragraphs);
      loaded += 1;
    } catch (error) {
      failed += 1;
      console.warn("[PIT] PDF extraction failed", source.url, error);
    }
  }

  return {
    loaded,
    message: loaded
      ? `已读取 ${loaded} 个 PDF。`
      : (failed ? "发现 PDF，但无法读取其中的文字。" : "")
  };
}

function collectPdfSources() {
  const sources = [];
  const seen = new Set();
  const candidates = Array.from(document.querySelectorAll("a[href], iframe[src], embed[src], object[data]"));

  for (const element of candidates) {
    const rawUrl = element.getAttribute("href") || element.getAttribute("src") || element.getAttribute("data") || "";
    const type = element.getAttribute("type") || "";
    const url = normalizePdfUrl(rawUrl);
    if (!url) continue;
    if (!/\.pdf(?:[?#]|$)/i.test(url) && !/application\/pdf/i.test(type)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    sources.push({
      url,
      element,
      title: getPdfSourceTitle(element, url)
    });
  }

  if (/\.pdf(?:[?#]|$)/i.test(location.href)) {
    const url = normalizePdfUrl(location.href);
    if (url && !seen.has(url)) {
      sources.unshift({ url, element: document.body, title: document.title || getFileNameFromUrl(url) || "PDF" });
    }
  }

  return sources;
}

function normalizePdfUrl(rawUrl) {
  const value = String(rawUrl || "").trim();
  if (!value || value.startsWith("javascript:") || value.startsWith("data:")) return "";
  try {
    const url = new URL(value, location.href);
    return url.href;
  } catch {
    return "";
  }
}

function findPdfContentSection(url) {
  return Array.from(document.querySelectorAll(`.${PDF_SECTION_CLASS}`))
    .find((section) => section.getAttribute(PDF_SOURCE_ATTR) === url) || null;
}

function getPdfSourceTitle(element, url) {
  const label = normalizeText(element?.innerText || element?.getAttribute?.("title") || element?.getAttribute?.("aria-label") || "");
  return label || getFileNameFromUrl(url) || "PDF";
}

function getFileNameFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    return decodeURIComponent(pathname.split("/").filter(Boolean).pop() || "");
  } catch {
    return "";
  }
}

async function extractPdfTextFromUrl(url) {
  let buffer = null;
  try {
    const response = await fetch(url, { credentials: "include" });
    if (!response.ok) throw new Error(`PDF 下载失败：${response.status}`);
    buffer = await response.arrayBuffer();
  } catch (error) {
    buffer = await fetchPdfBufferFromBackground(url, error);
  }
  return extractPdfTextWithFrame(buffer);
}

async function fetchPdfBufferFromBackground(url, originalError) {
  const response = await chrome.runtime.sendMessage({ type: "FETCH_PDF_AS_BASE64", url });
  if (!response?.ok) {
    throw new Error(response?.error || originalError?.message || "PDF 下载失败。");
  }
  return base64ToArrayBuffer(response.base64 || "");
}

function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

async function extractPdfTextWithFrame(buffer) {
  const frame = await getPdfExtractorFrame();
  const requestId = `pdf_${Date.now()}_${Math.random().toString(36).slice(2)}`;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("PDF 文本读取超时。"));
    }, 30000);

    function cleanup() {
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
    }

    function onMessage(event) {
      const message = event.data || {};
      if (message.type !== "PIT_EXTRACT_PDF_TEXT_RESULT" || message.requestId !== requestId) return;
      cleanup();
      if (message.ok) resolve(message.text || "");
      else reject(new Error(message.error || "PDF 文本读取失败。"));
    }

    window.addEventListener("message", onMessage);
    frame.contentWindow.postMessage({
      type: "PIT_EXTRACT_PDF_TEXT",
      requestId,
      buffer
    }, "*", [buffer]);
  });
}

function getPdfExtractorFrame() {
  if (pdfExtractorFramePromise) return pdfExtractorFramePromise;

  pdfExtractorFramePromise = new Promise((resolve, reject) => {
    const frame = document.createElement("iframe");
    frame.src = chrome.runtime.getURL("pdf-extractor.html");
    frame.hidden = true;
    frame.style.display = "none";
    frame.onload = () => resolve(frame);
    frame.onerror = () => reject(new Error("PDF 读取器加载失败。"));
    document.documentElement.appendChild(frame);
  });

  return pdfExtractorFramePromise;
}

function splitPdfTextIntoParagraphs(text) {
  return String(text || "")
    .replace(/\r/g, "")
    .split(/\n{2,}|\n(?=第\s*\d+\s*页\b)/)
    .flatMap((part) => splitLongPdfParagraph(part.trim()))
    .map((part) => normalizeTextPreserveBreaks(part))
    .filter((part) => part.length >= 8 && shouldTranslateToSimplifiedChinese(part))
    .slice(0, MAX_PDF_PARAGRAPHS_PER_FILE);
}

function splitLongPdfParagraph(text) {
  if (!text) return [];
  if (text.length <= 900) return [text];
  const chunks = [];
  let current = "";
  const sentences = text.match(/[^.!?。！？;；]+[.!?。！？;；]?\s*|[^.!?。！？;；]+$/g) || [text];
  for (const sentence of sentences) {
    if ((current + sentence).length <= 900) {
      current += sentence;
    } else {
      if (current.trim()) chunks.push(current.trim());
      current = sentence;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

function insertPdfContentSection(source, paragraphs) {
  const section = document.createElement("section");
  section.className = PDF_SECTION_CLASS;
  section.setAttribute(PDF_SOURCE_ATTR, source.url);

  const heading = document.createElement("h2");
  heading.textContent = `PDF 内容：${source.title}`;
  section.appendChild(heading);

  for (const paragraph of paragraphs) {
    const node = document.createElement("p");
    node.className = PDF_BLOCK_CLASS;
    node.textContent = paragraph;
    section.appendChild(node);
  }

  const target = source.element?.closest?.("a, iframe, embed, object, p, li, div, section, article") || source.element;
  if (target?.parentElement) {
    target.insertAdjacentElement("afterend", section);
  } else {
    document.body.appendChild(section);
  }
}

// ─── 格式转换（HTML ↔ Markdown）──────────────────────────────
function hasFormatting(element) {
  return element.querySelector("strong, b, em, i, u, code, a") !== null;
}

function htmlToMarkdown(html) {
  return normalizeTextPreserveBreaks(
    html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(?:p|div|li|h[1-6]|blockquote|figcaption|dd|dt|td|th|tr|section|article)>/gi, "\n\n")
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
  return formatTranslationResult(md)
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.*?)\*/g,     "<em>$1</em>")
    .replace(/_(.*?)_/g,       "<u>$1</u>")
    .replace(/`(.*?)`/g,       "<code>$1</code>")
    .replace(/\[(.*?)\]\((.*?)\)/g, '<a href="$2" target="_blank">$1</a>')
    .replace(/\n+/g, "<br>")
    .replace(/(?:<br\s*\/?>\s*){2,}/gi, "<br>");
}

// ─── 段落收集 ─────────────────────────────────────────────────
function collectBlocks() {
  const seen = new Set();
  const candidates = Array.from(document.querySelectorAll(BLOCK_SELECTOR))
    .filter((el) => {
      if (seen.has(el)) return false;
      seen.add(el);
      return isCandidateBlock(el);
    });

  return removeOverlappingCandidateBlocks(addCoverageFallbackBlock(addVisibleTextFallbackCandidates(candidates)))
    .map((el) => {
      const hasFormat = hasFormatting(el);
      const text      = extractBlockText(el);
      return { element: el, text, hasFormat };
    })
    .filter((item) => shouldTranslateToSimplifiedChinese(item.text))
    .slice(0, MAX_BLOCKS_PER_RUN);
}

function collectBundleBlocks() {
  const contentRoot = findBestArticleContentRoot() || document.body;
  if (!contentRoot) return [];
  const seen = new Set();
  const candidates = Array.from(contentRoot.querySelectorAll(BLOCK_SELECTOR))
    .filter((el) => {
      if (seen.has(el)) return false;
      seen.add(el);
      return isBundleCandidateBlock(el);
    });

  if (contentRoot.matches?.(BLOCK_SELECTOR) && isBundleCandidateBlock(contentRoot)) {
    candidates.unshift(contentRoot);
  }

  return removeOverlappingCandidateBlocks(candidates)
    .map((el) => {
      const text = extractOriginalTextForBundle(el);
      return { element: el, text, hasFormat: hasFormatting(el) };
    })
    .filter((item) => item.text && item.text.length >= 8)
    .slice(0, MAX_BLOCKS_PER_RUN);
}

function findBestArticleContentRoot() {
  if (isXPage()) {
    return document.querySelector("main, [role='main']") || document.body;
  }

  const selectors = [
    "article", "main article", "[role='article']",
    "main", "[role='main']",
    ".article-body", ".article-content", ".post-content", ".entry-content",
    ".story-body", ".content-body", "#article", "#content"
  ];
  const candidates = Array.from(document.querySelectorAll(selectors.join(",")))
    .filter((el, index, list) => list.indexOf(el) === index)
    .filter((el) => el instanceof HTMLElement && isVisible(el) && !el.closest(CONTENT_NOISE_SELECTOR))
    .map((el) => {
      const text = normalizeText(extractOriginalTextForBundle(el));
      const paragraphs = el.querySelectorAll("p, li, blockquote, h1, h2, h3").length;
      const linkTextLength = Array.from(el.querySelectorAll("a"))
        .reduce((sum, link) => sum + normalizeText(link.innerText || link.textContent).length, 0);
      const linkRatio = text.length ? linkTextLength / text.length : 1;
      const semanticBonus = el.matches("article, main article, [role='article']") ? 1200 : 0;
      const score = Math.min(text.length, 30000) + Math.min(paragraphs, 40) * 80 + semanticBonus - linkRatio * 5000;
      return { el, text, score };
    })
    .filter((item) => item.text.length >= 120)
    .sort((a, b) => b.score - a.score);

  return candidates[0]?.el || null;
}

function isCandidateBlock(el) {
  if (!(el instanceof HTMLElement))     return false;
  if (el.closest(SKIP_SELECTOR))        return false;
  if (isAlreadyHandledBlock(el))        return false;
  if (!isVisible(el))                   return false;

  const text = normalizeText(el.innerText);
  if (!text || text.length < 8)         return false;
  if (el.querySelector(`.${TRANSLATION_CLASS}`)) return false;

  const rect = el.getBoundingClientRect();
  if (rect.width < 40 || rect.height < 6) return false;

  return true;
}

function isAlreadyHandledBlock(el) {
  if (!(el instanceof Element)) return false;
  if (el.matches(`[${PROCESSED_ATTR}]`)) return true;
  return Boolean(el.parentElement?.closest?.(`[${PROCESSED_ATTR}]`));
}

function removeOverlappingCandidateBlocks(elements) {
  const candidateSet = new Set(elements);
  return elements.filter((el) => {
    const atomicAncestor = elements.find((parent) => (
      parent !== el
      && candidateSet.has(parent)
      && parent.contains(el)
      && isAtomicTranslationBlock(parent)
    ));
    if (atomicAncestor) return false;

    const descendants = elements.filter((child) => child !== el && candidateSet.has(child) && el.contains(child));
    if (!descendants.length) return true;

    // 正文段落优先于 article/main/section 等外层容器，避免外层替换时把尚未
    // 翻译的内部段落一起移出 DOM。反过来，p/li 等原子段落优先于内部 span。
    if (isAtomicTranslationBlock(el)) return true;
    if (descendants.some((child) => isAtomicTranslationBlock(child))) return false;

    const parentText = normalizeText(el.innerText);
    if (!parentText) return false;

    const descendantText = normalizeText(descendants
      .map((child) => child.innerText)
      .filter(Boolean)
      .join(" "));

    if (!descendantText) return true;
    return getTextCoverage(descendantText, parentText) < 0.98;
  });
}

function isAtomicTranslationBlock(element) {
  return element instanceof Element
    && /^(P|LI|BLOCKQUOTE|FIGCAPTION|DD|DT|TD|TH|H[1-6])$/.test(element.tagName);
}

function getTextCoverage(partText, fullText) {
  const part = normalizeText(partText);
  const full = normalizeText(fullText);
  if (!part || !full) return 0;
  if (full.includes(part)) return Math.min(1, part.length / full.length);

  const partWords = part.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  const fullWords = new Set(full.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
  if (!partWords.length || !fullWords.size) return 0;

  const covered = partWords.filter((word) => fullWords.has(word)).length;
  return covered / partWords.length;
}

function addVisibleTextFallbackCandidates(candidates) {
  const result = [...candidates];
  const seen = new Set(result);
  const root = document.body;
  if (!root) return result;

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const text = normalizeText(node.textContent || "");
      if (!text || text.length < 2 || !shouldTranslateToSimplifiedChinese(text)) return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (!parent || parent.closest(SKIP_SELECTOR) || !isVisibleTextNode(node) || isAlreadyHandledBlock(parent)) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  let node = walker.nextNode();
  while (node && result.length < MAX_BLOCKS_PER_RUN * 2) {
    const element = getTranslationElementForTextNode(node);
    if (element && !seen.has(element) && isTextFallbackCandidate(element)) {
      seen.add(element);
      result.push(element);
    }
    node = walker.nextNode();
  }

  return result;
}

function isTextFallbackCandidate(el) {
  if (!(el instanceof HTMLElement)) return false;
  if (el.closest(SKIP_SELECTOR)) return false;
  if (isAlreadyHandledBlock(el)) return false;
  if (!isVisible(el) && !hasVisibleTextRange(el)) return false;

  const text = normalizeText(extractBlockText(el));
  if (!text || text.length < 2) return false;
  if (!shouldTranslateToSimplifiedChinese(text)) return false;
  if (el.querySelector(`.${TRANSLATION_CLASS}`)) return false;

  const rect = el.getBoundingClientRect();
  return (rect.width > 0 && rect.height > 0) || hasVisibleTextRange(el);
}

function isVisibleTextNode(node) {
  if (!node?.parentElement) return false;
  if (isVisible(node.parentElement)) return true;
  const range = document.createRange();
  range.selectNodeContents(node);
  const rect = range.getBoundingClientRect();
  range.detach?.();
  return rect.width > 0 && rect.height > 0;
}

function hasVisibleTextRange(el) {
  if (!(el instanceof Element)) return false;
  const range = document.createRange();
  range.selectNodeContents(el);
  const rect = range.getBoundingClientRect();
  range.detach?.();
  return rect.width > 0 && rect.height > 0;
}

function getTranslationElementForTextNode(textNode) {
  const parent = textNode.parentElement;
  if (!parent) return null;
  const paragraphOwner = parent.closest(TEXT_FALLBACK_CONTAINER_SELECTOR);
  if (paragraphOwner && isReadableFallbackContainer(paragraphOwner)) return paragraphOwner;

  const inlineOwner = parent.closest(INLINE_TEXT_OWNER_SELECTOR);
  if (inlineOwner && !inlineOwner.closest(SKIP_SELECTOR)) return inlineOwner;
  return paragraphOwner || parent;
}

function isReadableFallbackContainer(el) {
  if (!(el instanceof HTMLElement)) return false;
  if (el.closest(SKIP_SELECTOR)) return false;
  if (isAlreadyHandledBlock(el)) return false;

  const text = normalizeText(extractBlockText(el));
  if (!text || text.length < 2) return false;
  if (!shouldTranslateToSimplifiedChinese(text)) return false;

  if (isCompactTextContainer(el)) return true;
  if (hasNestedParagraphBoundaries(el)) return false;
  return text.length <= TRANSLATION_CHUNK_LENGTH;
}

function isCompactTextContainer(el) {
  if (!(el instanceof HTMLElement)) return false;
  if (/^(P|LI|BLOCKQUOTE|FIGCAPTION|DD|DT|TD|TH|H[1-6])$/.test(el.tagName)) return true;

  const childElements = Array.from(el.children)
    .filter((child) => !child.matches?.(SKIP_SELECTOR));
  const blockChildren = childElements
    .filter((child) => isParagraphBoundaryElement(child) && normalizeText(child.innerText || child.textContent).length >= 4);

  return blockChildren.length === 0;
}

function addCoverageFallbackBlock(candidates) {
  const fallback = findBestReadableContainer();
  if (!fallback || candidates.includes(fallback)) return candidates;

  const fullText = normalizeText(extractBlockText(fallback));
  if (!fullText || fullText.length < 80 || !shouldTranslateToSimplifiedChinese(fullText)) return candidates;

  const candidateText = normalizeText(candidates
    .filter((el) => fallback.contains(el))
    .map((el) => extractBlockText(el))
    .filter(Boolean)
    .join(" "));

  if (getTextCoverage(candidateText, fullText) >= 0.98) return candidates;
  return [fallback, ...candidates];
}

function findBestReadableContainer() {
  const selectorGroups = [
    ["article", "main article", '[role="article"]'],
    ["main", '[role="main"]'],
    [".article", ".post", ".entry-content", ".content", "#content"],
    document.body ? ["body"] : []
  ];

  for (const selectors of selectorGroups) {
    const candidates = selectors
      .flatMap((selector) => Array.from(document.querySelectorAll(selector)))
      .filter((el, index, list) => list.indexOf(el) === index)
      .filter((el) => el instanceof HTMLElement && !el.closest(SKIP_SELECTOR) && isVisible(el))
      .map((el) => ({ el, text: normalizeText(extractBlockText(el)) }))
      .filter((item) => item.text.length >= 80 && shouldTranslateToSimplifiedChinese(item.text))
      .sort((a, b) => b.text.length - a.text.length);

    if (candidates.length) return candidates[0].el;
  }

  return null;
}

function isBundleCandidateBlock(el) {
  if (!(el instanceof HTMLElement)) return false;
  if (el.closest(`script, style, noscript, svg, canvas, pre, code, kbd, samp, [contenteditable='true'], ${CONTENT_NOISE_SELECTOR}`)) return false;
  if (!isVisible(el)) return false;

  const text = extractOriginalTextForBundle(el);
  if (!text || text.length < 8) return false;
  if (isLikelyPageChromeBlock(el, text)) return false;

  const rect = el.getBoundingClientRect();
  if (rect.width < 40 || rect.height < 6) return false;

  return true;
}

function extractOriginalTextForBundle(el) {
  if (el.hasAttribute(ORIGINAL_HTML_ATTR)) {
    const original = document.createElement("div");
    original.innerHTML = el.getAttribute(ORIGINAL_HTML_ATTR) || "";
    cleanBundleClone(original);
    return extractBlockText(original);
  }

  const clone = el.cloneNode(true);
  cleanBundleClone(clone);
  return extractBlockText(clone);
}

function cleanBundleClone(clone) {
  clone.querySelectorAll(`.${TRANSLATION_CLASS}, .${REPLACED_CLASS}, ${CONTENT_NOISE_SELECTOR}`).forEach((node) => node.remove());
  clone.querySelectorAll("a").forEach((link) => {
    const text = normalizeText(link.textContent || "");
    const parentText = normalizeText(link.parentElement?.textContent || "");
    if (!text || parentText === text) {
      link.remove();
      return;
    }
    link.replaceWith(document.createTextNode(text));
  });
}

function isLikelyPageChromeBlock(el, text) {
  if (el.matches("a, button, [role='button'], [role='link']")) return true;
  const links = Array.from(el.querySelectorAll("a"));
  const linkTextLength = links.reduce((sum, link) => sum + normalizeText(link.innerText || link.textContent).length, 0);
  const plainLength = normalizeText(text).length;
  const linkRatio = plainLength ? linkTextLength / plainLength : 0;
  if (links.length >= 3 && linkRatio > 0.45) return true;
  if (linkRatio > 0.72 && plainLength < 260) return true;

  const compact = normalizeText(text);
  if (compact.length <= 80 && /^(?:登录|注册|订阅|分享|关注|点赞|收藏|下载|打开|关闭|返回|首页|菜单|更多|下一页|上一页|阅读全文|查看详情|login|sign up|subscribe|share|follow|like|download|open|close|home|menu|more|next|previous|read more)\b/i.test(compact)) {
    return true;
  }
  return false;
}

function extractBlockText(el) {
  if (!el) return "";
  if (hasFormatting(el) || hasNestedParagraphBoundaries(el)) {
    return domToMarkdownPreserveParagraphs(el);
  }
  return normalizeTextPreserveBreaks(el.innerText || el.textContent);
}

function hasNestedParagraphBoundaries(el) {
  const nestedBlocks = Array.from(el.querySelectorAll("*"))
    .filter((child) => {
      const isDetached = !document.documentElement.contains(child);
      return child !== el
        && (isDetached || isVisible(child))
        && isParagraphBoundaryElement(child)
        && normalizeText(child.innerText || child.textContent).length >= 4;
    });
  if (nestedBlocks.length >= 2) return true;

  const text = String(el.innerText || el.textContent || "");
  return /\S[^\n]*\n\s*\n[^\n]*\S/.test(text);
}

function domToMarkdownPreserveParagraphs(root) {
  return normalizeTextPreserveBreaks(Array.from(root.childNodes).map(nodeToMarkdown).join(""));
}

function nodeToMarkdown(node) {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent || "";
  if (!(node instanceof Element)) return "";
  if (node.classList?.contains(TRANSLATION_CLASS) || node.classList?.contains(REPLACED_CLASS)) return "";
  if (node.matches(SKIP_SELECTOR)) return "";

  if (node.tagName === "BR") return "\n";

  let text = Array.from(node.childNodes).map(nodeToMarkdown).join("");
  const tag = node.tagName;

  if (tag === "STRONG" || tag === "B") text = wrapInlineMarkdown(text, "**");
  if (tag === "EM" || tag === "I") text = wrapInlineMarkdown(text, "*");
  if (tag === "U") text = wrapInlineMarkdown(text, "_");
  if (tag === "CODE") text = wrapInlineMarkdown(text.replace(/`/g, "'"), "`");
  if (tag === "A") {
    const href = node.getAttribute("href") || "";
    if (href && text.trim()) text = `[${text.trim()}](${href})`;
  }

  if (isParagraphBoundaryElement(node)) {
    return `\n\n${text.trim()}\n\n`;
  }

  return text;
}

function wrapInlineMarkdown(text, marker) {
  const value = String(text || "").trim();
  return value ? `${marker}${value}${marker}` : "";
}

function isParagraphBoundaryElement(el) {
  if (!(el instanceof Element)) return false;
  if (el.classList?.contains(PDF_BLOCK_CLASS)) return true;
  if (PARAGRAPH_BOUNDARY_TAGS.has(el.tagName)) return true;

  const role = String(el.getAttribute("role") || "").toLowerCase();
  if (/^(article|document|heading|list|listitem|main|paragraph|row|table)$/.test(role)) return true;

  const style = getElementDisplayStyle(el);
  if (/^(block|flow-root|list-item|table|table-row|table-cell|flex|grid)$/.test(style.display)) return true;
  if (/^(flex|grid)$/.test(style.parentDisplay || "")) return true;
  if (style.display === "inline-block" && isWideTextInlineBlock(el)) return true;

  return false;
}

function getElementDisplayStyle(el) {
  if (!(el instanceof HTMLElement) || !document.documentElement.contains(el)) {
    const inlineDisplay = String(el.getAttribute?.("style") || "").match(/display\s*:\s*([^;]+)/i)?.[1]?.trim().toLowerCase() || "";
    return { display: inlineDisplay, parentDisplay: "" };
  }

  const computed = window.getComputedStyle(el);
  const parentComputed = el.parentElement ? window.getComputedStyle(el.parentElement) : null;
  return {
    display: computed.display,
    parentDisplay: parentComputed?.display || ""
  };
}

function isWideTextInlineBlock(el) {
  if (!(el instanceof HTMLElement) || !document.documentElement.contains(el)) return false;
  const text = normalizeText(el.innerText || el.textContent);
  if (text.length < 20) return false;
  const rect = el.getBoundingClientRect();
  const parentRect = el.parentElement?.getBoundingClientRect();
  if (!parentRect?.width) return false;
  return rect.width >= Math.min(parentRect.width * 0.55, 360);
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
  const cached = getSessionValue(CACHE_PREFIX + hashText(text));
  return cached ? formatTranslationResult(cached) : null;
}
function setCacheEntry(text, translation) {
  setSessionValue(CACHE_PREFIX + hashText(text), formatTranslationResult(translation));
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
    if (hit && isUsableTranslationResult(b.text, hit)) {
      cached.push({ block: b, translation: hit });
    } else {
      if (hit) removeSessionValue(CACHE_PREFIX + hashText(b.text));
      uncached.push(b);
    }
  }
  return { cachedBlocks: cached, uncachedBlocks: uncached };
}

function removeSessionValue(key) {
  try { sessionStorage.removeItem(key); }
  catch { /* 忽略不可用的 sessionStorage */ }
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

// 统一收紧模型输出的排版：清理行尾空白并移除空白行。
// 保留单个换行，避免破坏列表、诗句等仍需要逐行展示的内容。
function formatTranslationResult(text) {
  return stripStreamedText(text)
    .replace(/\r\n?/g, "\n")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .split("\n")
    .map((line) => line.replace(/[\t \u00A0]+$/g, ""))
    .join("\n")
    .replace(/\n(?:[\t \u00A0]*\n)+/g, "\n")
    .trim();
}
function shouldTranslateToSimplifiedChinese(text) {
  const value = normalizeText(text);
  if (value.length < 2) return false;
  if (isProtectedInlineTokenOnly(value)) return false;
  if (isMostlyNonContent(value)) return false;
  if (hasTraditionalChineseSignal(value)) return true;
  if (isChineseDominantMixedText(value)) return false;
  if (hasChineseWithInlineTerm(value)) return false;
  return !isLikelySimplifiedChinese(value);
}

function isLikelySimplifiedChinese(text) {
  const readableText = stripSocialNoise(text);
  const cjk = readableText.match(/[\u3400-\u9fff]/g)?.length || 0;
  if (cjk < 2) return false;
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
  if (languageChars < 2) return true;
  if (/^(https?:\/\/|www\.|@[\w.-]+$|#[\w.-]+$|\$[A-Za-z][A-Za-z0-9._-]*$)/i.test(text)) return true;
  return languageChars / text.length < 0.28;
}

function isProtectedInlineTokenOnly(text) {
  const value = String(text || "").trim();
  if (!value) return false;
  PROTECTED_INLINE_TOKEN_PATTERN.lastIndex = 0;
  COMMON_UNTRANSLATED_TERM_PATTERN.lastIndex = 0;
  const stripped = value
    .replace(PROTECTED_INLINE_TOKEN_PATTERN, " ")
    .replace(COMMON_UNTRANSLATED_TERM_PATTERN, " ")
    .replace(/\s+/g, "")
    .trim();
  PROTECTED_INLINE_TOKEN_PATTERN.lastIndex = 0;
  COMMON_UNTRANSLATED_TERM_PATTERN.lastIndex = 0;
  return stripped === "";
}

function isChineseDominantMixedText(text) {
  const readableText = stripSocialNoise(text);
  if (hasTraditionalChineseSignal(readableText)) return false;
  const cjk = readableText.match(/[\u3400-\u9fff]/g)?.length || 0;
  const latinWords = getLatinWordsForTranslationDecision(readableText);
  if (cjk < 2 || !latinWords.length) return false;
  const kana = readableText.match(/[\u3040-\u30ff]/g)?.length || 0;
  const hangul = readableText.match(/[\uac00-\ud7af]/g)?.length || 0;
  if (kana || hangul) return false;
  return cjk > latinWords.length;
}

function hasChineseWithInlineTerm(text) {
  const value = String(text || "");
  if (!/[\u3400-\u9fff]/.test(value)) return false;
  if (hasTraditionalChineseSignal(value)) return false;

  COMMON_UNTRANSLATED_TERM_PATTERN.lastIndex = 0;
  const hasCommonTerm = COMMON_UNTRANSLATED_TERM_PATTERN.test(value);
  COMMON_UNTRANSLATED_TERM_PATTERN.lastIndex = 0;

  return hasCommonTerm
    || /[\u3400-\u9fff][A-Za-z][A-Za-z0-9+./-]*|[A-Za-z][A-Za-z0-9+./-]*[\u3400-\u9fff]/.test(value)
    || /[\u3400-\u9fff][（(]\s*[A-Za-z][A-Za-z0-9+./\s-]{1,60}\s*[)）]/.test(value);
}

function getLatinWordsForTranslationDecision(text) {
  const cleaned = String(text || "")
    .replace(PROTECTED_INLINE_TOKEN_PATTERN, " ")
    .replace(COMMON_UNTRANSLATED_TERM_PATTERN, " ");
  PROTECTED_INLINE_TOKEN_PATTERN.lastIndex = 0;
  COMMON_UNTRANSLATED_TERM_PATTERN.lastIndex = 0;
  return cleaned.match(/[A-Za-z]+(?:[-'][A-Za-z]+)?/g) || [];
}
function isVisible(el) {
  const s = window.getComputedStyle(el);
  if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) return false;
  return Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
}

function splitTextForTranslation(text) {
  const source = normalizeTextPreserveBreaks(text);
  return splitTextPreservingLineBreaks(source).flatMap((segment) => {
    const chunks = splitTextSegmentForTranslation(segment.text);
    if (!chunks.length) return segment.separator ? [{ text: "", separator: segment.separator }] : [];
    return chunks.map((chunk, index) => ({
      text: chunk,
      separator: index === chunks.length - 1 ? segment.separator : ""
    }));
  });
}

function splitTextPreservingLineBreaks(source) {
  const segments = [];
  const tokens = String(source || "").split(/(\n+)/);
  let current = "";

  for (const token of tokens) {
    if (!token) continue;
    if (/^\n+$/.test(token)) {
      if (current.trim()) {
        segments.push({ text: current.trim(), separator: token });
        current = "";
      } else if (segments.length) {
        segments[segments.length - 1].separator += token;
      }
      continue;
    }
    current += token;
  }

  if (current.trim()) segments.push({ text: current.trim(), separator: "" });
  return segments;
}

function splitTextSegmentForTranslation(source) {
  if (!source) return [];
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
