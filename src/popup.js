const DEFAULT_SETTINGS = {
  provider: "ollama",
  mode: "append",
  translationStyle: "bar",
  shortTextReplaceMode: false,
  markStyle: "highlight",
  markHighlightColor: "#fff2a8",
  markHighlightColorLight: "#fff2a8",
  markHighlightColorDark: "#facc15",
  model: "qwen3.5:4b",
  baseUrl: "http://localhost:11434",
  apiKey: "",
  summaryPrompt: "",
  saveDir: "page-notes",
  noteSaveShortcut: "enter",
  saveUrl: true,
  saveOriginal: true,
  saveTranslation: true,
  saveSummary: true,
  saveNote: true,
  userNote: "",
  allowWebSearch: true
};

const UI_STATE_KEY = "pit_popup_ui_state";

const controls = {
  tabs: Array.from(document.querySelectorAll(".tab")),
  panels: Array.from(document.querySelectorAll(".tab-panel")),
  mode: document.querySelector("#mode"),
  translationStyle: document.querySelector("#translationStyle"),
  shortTextReplaceMode: document.querySelector("#shortTextReplaceMode"),
  provider: document.querySelector("#provider"),
  ollamaModel: document.querySelector("#ollamaModel"),
  model: document.querySelector("#model"),
  baseUrl: document.querySelector("#baseUrl"),
  apiKey: document.querySelector("#apiKey"),
  saveDir: document.querySelector("#saveDir"),
  summaryPrompt: document.querySelector("#summaryPrompt"),
  summaryCard: document.querySelector("#summaryCard"),
  summaryResult: document.querySelector("#summaryResult"),
  summaryToggleBtn: document.querySelector("#summaryToggleBtn"),
  askOverview: document.querySelector("#askOverview"),
  askOverviewBtn: document.querySelector("#askOverviewBtn"),
  askMessages: document.querySelector("#askMessages"),
  askQuestion: document.querySelector("#askQuestion"),
  allowWebSearch: document.querySelector("#allowWebSearch"),
  userNote: document.querySelector("#userNote"),
  saveUrl: document.querySelector("#saveUrl"),
  saveOriginal: document.querySelector("#saveOriginal"),
  saveTranslation: document.querySelector("#saveTranslation"),
  saveSummary: document.querySelector("#saveSummary"),
  saveNote: document.querySelector("#saveNote"),
  translateBtn: document.querySelector("#translateBtn"),
  restoreBtn: document.querySelector("#restoreBtn"),
  summaryBtn: document.querySelector("#summaryBtn"),
  askBtn: document.querySelector("#askBtn"),
  saveNoteBtn: document.querySelector("#saveNoteBtn"),
  message: document.querySelector("#message"),
  statusDot: document.querySelector("#statusDot")
};

let askOverviewLoaded = false;
let askOverviewMarkdown = "";
let askMessages = [];
let currentUiStateKey = UI_STATE_KEY;
let retainedMarkSettings = {
  markStyle: DEFAULT_SETTINGS.markStyle,
  markHighlightColor: DEFAULT_SETTINGS.markHighlightColor,
  markHighlightColorLight: DEFAULT_SETTINGS.markHighlightColorLight,
  markHighlightColorDark: DEFAULT_SETTINGS.markHighlightColorDark
};

init();

async function init() {
  const settings = await loadSettings();
  retainedMarkSettings = {
    markStyle: settings.markStyle,
    markHighlightColor: settings.markHighlightColor,
    markHighlightColorLight: settings.markHighlightColorLight,
    markHighlightColorDark: settings.markHighlightColorDark
  };
  chrome.storage.onChanged.addListener(updateRetainedMarkSettings);
  applySettings(settings);
  bindTabs();
  currentUiStateKey = await getUiStateKey();
  await restoreUiState();
  await updateProviderFields();

  ["change", "input"].forEach((eventName) => {
    [
      "mode", "translationStyle", "shortTextReplaceMode", "provider", "ollamaModel", "model", "baseUrl",
      "apiKey", "saveDir", "summaryPrompt", "userNote", "saveUrl", "saveOriginal",
      "saveTranslation", "saveSummary", "saveNote", "allowWebSearch"
    ].forEach((key) => {
      controls[key].addEventListener(eventName, persistSettings);
    });
  });

  controls.provider.addEventListener("change", async () => {
    const providerDefaults = getProviderDefaults(controls.provider.value);
    controls.baseUrl.value = providerDefaults.baseUrl;
    controls.model.value = providerDefaults.model;
    await updateProviderFields();
    await persistSettings();
  });

  controls.baseUrl.addEventListener("change", async () => {
    if (controls.provider.value === "ollama") {
      await loadOllamaModels();
      await persistSettings();
    }
  });

  controls.ollamaModel.addEventListener("change", () => {
    controls.model.value = controls.ollamaModel.value;
  });

  controls.translateBtn.addEventListener("click", translateCurrentTab);
  controls.restoreBtn.addEventListener("click", restoreCurrentTab);
  controls.summaryBtn.addEventListener("click", summarizeCurrentTab);
  controls.summaryToggleBtn.addEventListener("click", toggleSummaryResult);
  controls.askOverviewBtn.addEventListener("click", () => loadAskOverview({ force: true }));
  controls.askBtn.addEventListener("click", askCurrentArticle);
  controls.saveNoteBtn.addEventListener("click", saveMarkdownNote);
  controls.askQuestion.addEventListener("input", () => {
    resizeAskInput();
    saveUiState();
  });
  controls.askQuestion.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      askCurrentArticle();
    }
  });

  prewarmCurrentModel();
}

function bindTabs() {
  controls.tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const target = activateTab(tab.dataset.tab);
      saveUiState();
      if (target === "summary") refreshSummaryPreview();
      if (target === "ask") {
        openAskPanelInPage();
        if (!askOverviewLoaded) loadAskOverview();
      }
    });
  });
}

function activateTab(target) {
  controls.tabs.forEach((item) => item.classList.toggle("is-active", item.dataset.tab === target));
  controls.panels.forEach((panel) => {
    panel.classList.toggle("is-active", panel.dataset.panel === target);
  });
  return target;
}

async function translateCurrentTab() {
  setBusy(true, "正在翻译...");
  try {
    await persistSettings();
    const response = await sendToActiveTab({
      type: "TRANSLATE_PAGE",
      settings: readSettings()
    });

    if (!response?.ok) throw new Error(response?.error || "翻译失败。");
    setStatus("ok", response.message || `已翻译 ${response.translated || 0} 个段落。`);
  } catch (error) {
    setStatus("error", error?.message || String(error));
  } finally {
    setBusy(false);
  }
}

async function summarizeCurrentTab() {
  setBusy(true, "正在总结...");
  try {
    await persistSettings();
    const response = await sendToActiveTab({
      type: "SUMMARY_PAGE",
      settings: readSettings()
    });

    if (!response?.ok) throw new Error(response?.error || "总结失败。");
    if (response.summary) setSummaryResult(response.summary);
    setStatus("ok", response.message || "已生成右侧总结。");
  } catch (error) {
    setStatus("error", error?.message || String(error));
  } finally {
    setBusy(false);
  }
}

async function restoreCurrentTab() {
  setBusy(true, "正在恢复...");
  try {
    const response = await sendToActiveTab({ type: "RESTORE_PAGE" });
    if (!response?.ok) throw new Error(response?.error || "恢复失败。");
    setStatus("ok", "已恢复原文。");
  } catch (error) {
    setStatus("error", error?.message || String(error));
  } finally {
    setBusy(false);
  }
}

async function saveMarkdownNote() {
  setBusy(true, "正在保存 Markdown...");
  try {
    await persistSettings();
    const settings = readSettings();
    const page = await sendToActiveTab({ type: "GET_PAGE_BUNDLE" });
    if (!page?.ok) throw new Error(page?.error || "无法读取当前页面内容。");

    const response = await chrome.runtime.sendMessage({
      type: "SAVE_MARKDOWN_NOTE",
      page,
      note: controls.userNote.value.trim(),
      options: {
        provider: settings.provider,
        model: settings.model,
        baseUrl: settings.baseUrl,
        apiKey: settings.apiKey,
        saveDir: settings.saveDir,
        saveUrl: settings.saveUrl,
        saveOriginal: settings.saveOriginal,
        saveTranslation: settings.saveTranslation,
        saveSummary: settings.saveSummary,
        saveNote: settings.saveNote
      }
    });

    if (!response?.ok) throw new Error(response?.error || "保存失败。");
    setStatus("ok", `已保存：${response.filename}`);
  } catch (error) {
    setStatus("error", error?.message || String(error));
  } finally {
    setBusy(false);
  }
}

async function loadAskOverview({ force = false } = {}) {
  if (askOverviewLoaded && !force) return;
  setPassiveBusy(true, "正在读取文章脉络...");
  try {
    const page = await sendToActiveTab({ type: "GET_PAGE_BUNDLE" });
    if (!page?.ok) throw new Error(page?.error || "无法读取当前页面内容。");

    controls.askOverview.textContent = "正在生成文章脉络...";
    const response = await chrome.runtime.sendMessage({
      type: "BUILD_ARTICLE_OVERVIEW",
      page,
      settings: readSettings()
    });

    if (!response?.ok) throw new Error(response?.error || "生成文章脉络失败。");
    setAskOverview(response.overview || "文章脉络为空。");
    askOverviewLoaded = true;
    setStatus("ok", "已生成文章脉络。");
  } catch (error) {
    controls.askOverview.textContent = error?.message || String(error);
    setStatus("error", error?.message || String(error));
  } finally {
    setPassiveBusy(false);
  }
}

async function askCurrentArticle() {
  const question = controls.askQuestion.value.trim();
  if (!question) {
    setStatus("error", "请输入问题。");
    return;
  }

  appendAskMessage("user", question);
  controls.askQuestion.value = "";
  resizeAskInput();
  saveUiState();
  const pendingId = appendAskMessage("assistant", "正在思考...", { pending: true });
  setBusy(true, "正在回答...");

  try {
    const settings = readSettings();
    const page = await sendToActiveTab({ type: "GET_PAGE_BUNDLE" });
    if (!page?.ok) throw new Error(page?.error || "无法读取当前页面内容。");

    const response = await chrome.runtime.sendMessage({
      type: "ASK_ARTICLE",
      page,
      question,
      allowWebSearch: settings.allowWebSearch,
      settings
    });

    if (!response?.ok) throw new Error(response?.error || "回答失败。");
    updateAskMessage(pendingId, response.answer || "没有得到回答。");
    setStatus("ok", response.usedWebSearch ? "已回答，包含网络补充。" : "已基于文章回答。");
  } catch (error) {
    updateAskMessage(pendingId, error?.message || String(error));
    setStatus("error", error?.message || String(error));
  } finally {
    setBusy(false);
  }
}

async function openAskPanelInPage() {
  try {
    await sendToActiveTab({
      type: "OPEN_ASK_PANEL",
      settings: readSettings()
    });
  } catch {
    // 页面不支持注入时，popup 内 Ask 仍可用。
  }
}

async function sendToActiveTab(message) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("没有找到当前标签页。");

  try {
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch (error) {
    if (!isMissingReceiverError(error)) throw error;
    await injectContentScript(tab);
    return chrome.tabs.sendMessage(tab.id, message);
  }
}

async function loadSettings() {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  const settings = { ...DEFAULT_SETTINGS, ...stored, userNote: "" };
  if (!stored.model || ["qwen2.5:1.5b", "qwen2.5:3b", "qwen3:8b"].includes(stored.model)) {
    settings.model = DEFAULT_SETTINGS.model;
  }
  return settings;
}

function applySettings(settings) {
  controls.mode.value = settings.mode;
  controls.translationStyle.value = settings.translationStyle || DEFAULT_SETTINGS.translationStyle;
  controls.shortTextReplaceMode.checked = Boolean(settings.shortTextReplaceMode);
  controls.provider.value = settings.provider;
  controls.model.value = settings.model;
  controls.baseUrl.value = settings.baseUrl;
  controls.apiKey.value = settings.apiKey;
  controls.saveDir.value = settings.saveDir || DEFAULT_SETTINGS.saveDir;
  controls.summaryPrompt.value = settings.summaryPrompt || "";
  controls.userNote.value = settings.userNote || "";
  controls.allowWebSearch.checked = Boolean(settings.allowWebSearch);
  controls.saveUrl.checked = Boolean(settings.saveUrl);
  controls.saveOriginal.checked = Boolean(settings.saveOriginal);
  controls.saveTranslation.checked = Boolean(settings.saveTranslation);
  controls.saveSummary.checked = Boolean(settings.saveSummary);
  controls.saveNote.checked = Boolean(settings.saveNote);
}

async function persistSettings() {
  const settings = readSettings();
  const { userNote, ...syncSettings } = settings;
  await chrome.storage.sync.set(syncSettings);
  await saveUiState();
}

function readSettings() {
  const isOllama = controls.provider.value === "ollama";
  return {
    ...retainedMarkSettings,
    mode: controls.mode.value,
    translationStyle: controls.translationStyle.value,
    shortTextReplaceMode: controls.shortTextReplaceMode.checked,
    provider: controls.provider.value,
    model: (isOllama ? controls.ollamaModel.value || controls.model.value : controls.model.value).trim(),
    baseUrl: controls.baseUrl.value.trim(),
    apiKey: controls.apiKey.value.trim(),
    saveDir: normalizeSaveDir(controls.saveDir.value),
    noteSaveShortcut: "auto",
    summaryPrompt: controls.summaryPrompt.value.trim(),
    userNote: controls.userNote.value,
    allowWebSearch: controls.allowWebSearch.checked,
    saveUrl: controls.saveUrl.checked,
    saveOriginal: controls.saveOriginal.checked,
    saveTranslation: controls.saveTranslation.checked,
    saveSummary: controls.saveSummary.checked,
    saveNote: controls.saveNote.checked
  };
}

function updateRetainedMarkSettings(changes, areaName) {
  if (areaName !== "sync") return;
  for (const key of Object.keys(retainedMarkSettings)) {
    if (changes[key]?.newValue !== undefined) {
      retainedMarkSettings[key] = changes[key].newValue;
    }
  }
}

function getProviderDefaults(provider) {
  if (provider === "openaiCompatible") {
    return {
      baseUrl: "https://api.groq.com/openai/v1",
      model: "llama-3.1-8b-instant"
    };
  }

  return {
    baseUrl: "http://localhost:11434",
    model: "qwen3.5:4b"
  };
}

async function injectContentScript(tab) {
  if (!canInjectIntoUrl(tab.url)) {
    throw new Error("当前页面不允许扩展注入脚本。请在普通网页上使用，并避开 chrome://、扩展商店、新标签页等浏览器内置页面。");
  }

  await chrome.scripting.insertCSS({
    target: { tabId: tab.id },
    files: ["src/content.css"]
  });

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["src/content.js"]
  });
}

function canInjectIntoUrl(url) {
  return /^https?:\/\//i.test(url || "") || /^file:\/\//i.test(url || "");
}

function isMissingReceiverError(error) {
  return String(error?.message || error).includes("Receiving end does not exist");
}

async function updateProviderFields() {
  const isOnline = controls.provider.value === "openaiCompatible";
  controls.ollamaModel.style.display = isOnline ? "none" : "block";
  controls.model.style.display = isOnline ? "block" : "none";
  document.querySelector(".api-key-field").style.display = isOnline ? "grid" : "none";

  if (!isOnline) {
    await loadOllamaModels();
  }
}

async function loadOllamaModels() {
  const preferredModel = controls.model.value.trim() || DEFAULT_SETTINGS.model;
  setModelSelectState("正在读取 Ollama 模型...", true);

  try {
    const response = await chrome.runtime.sendMessage({
      type: "LIST_OLLAMA_MODELS",
      baseUrl: controls.baseUrl.value.trim() || DEFAULT_SETTINGS.baseUrl
    });

    if (!response?.ok) throw new Error(response?.error || "无法读取 Ollama 模型列表。");
    const models = response.models || [];

    if (!models.length) {
      setModelSelectState("未找到已安装模型", true);
      controls.model.value = preferredModel;
      setStatus("error", "Ollama 当前没有可用模型，请先运行 ollama pull qwen3.5:4b。");
      return;
    }

    controls.ollamaModel.replaceChildren(
      ...models.map((model) => {
        const option = document.createElement("option");
        option.value = model;
        option.textContent = model;
        return option;
      })
    );

    const selectedModel = choosePreferredOllamaModel(models, preferredModel);
    controls.ollamaModel.disabled = false;
    controls.ollamaModel.value = selectedModel;
    controls.model.value = controls.ollamaModel.value;
    controls.message.textContent = selectedModel === preferredModel
      ? `已读取 ${models.length} 个本地模型。`
      : `已自动切换到已安装模型：${selectedModel}`;
    controls.statusDot.className = "status-dot is-ok";
    await persistSettings();
    prewarmCurrentModel();
  } catch (error) {
    setModelSelectState("无法连接 Ollama", true);
    controls.model.value = preferredModel;
    setStatus("error", error?.message || String(error));
  }
}

function prewarmCurrentModel() {
  const settings = readSettings();
  if (settings.provider !== "ollama" || !settings.model) return;

  chrome.runtime.sendMessage({
    type: "PREWARM_OLLAMA",
    settings
  }).catch(() => {
    // 预热失败不阻塞用户操作，真正翻译时会显示具体错误。
  });
}

function choosePreferredOllamaModel(models, preferredModel) {
  if (models.includes(preferredModel)) return preferredModel;

  const preferredPatterns = [
    /^qwen3\.5/i,
    /^qwen2\.5/i,
    /^qwen/i,
    /^llama3\.1/i,
    /^llama3/i,
    /^mistral/i,
    /^gemma/i,
    /^deepseek/i
  ];

  for (const pattern of preferredPatterns) {
    const found = models.find((model) => pattern.test(model));
    if (found) return found;
  }

  return models[0];
}

function setModelSelectState(label, disabled) {
  const option = document.createElement("option");
  option.value = "";
  option.textContent = label;
  controls.ollamaModel.replaceChildren(option);
  controls.ollamaModel.disabled = disabled;
}

function setBusy(isBusy, message = "") {
  [
    controls.translateBtn,
    controls.restoreBtn,
    controls.summaryBtn,
    controls.askOverviewBtn,
    controls.askBtn,
    controls.saveNoteBtn
  ].forEach((button) => {
    button.disabled = isBusy;
  });
  controls.statusDot.className = `status-dot${isBusy ? " is-busy" : ""}`;
  if (message) controls.message.textContent = message;
}

function setStatus(type, message) {
  controls.statusDot.className = `status-dot is-${type}`;
  controls.message.textContent = message;
}

function setSummaryResult(summary, { persist = true } = {}) {
  controls.summaryResult.textContent = summary || "暂无总结。";
  controls.summaryCard.classList.remove("is-empty");
  controls.summaryCard.classList.add("is-collapsed");
  controls.summaryToggleBtn.textContent = "展开";
  if (persist) saveUiState();
}

function toggleSummaryResult() {
  const collapsed = controls.summaryCard.classList.toggle("is-collapsed");
  controls.summaryToggleBtn.textContent = collapsed ? "展开" : "收起";
}

async function refreshSummaryPreview() {
  try {
    const page = await sendToActiveTab({ type: "GET_PAGE_BUNDLE" });
    if (page?.ok && page.summary) setSummaryResult(page.summary);
  } catch {
    // 页面还没注入或尚无总结时保持当前占位。
  }
}

function appendAskMessage(role, text, options = {}) {
  const id = `msg_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  askMessages.push({ id, role, text, pending: Boolean(options.pending) });
  renderAskMessages();
  saveUiState();
  return id;
}

function updateAskMessage(id, text) {
  const message = askMessages.find((item) => item.id === id);
  if (!message) return;
  message.text = text;
  message.pending = false;
  renderAskMessages();
  saveUiState();
}

function renderAskMessages() {
  controls.askMessages.replaceChildren(
    ...askMessages.map((message) => createAskMessageNode(message))
  );
  controls.askMessages.scrollTop = controls.askMessages.scrollHeight;
}

function createAskMessageNode(message) {
  const node = document.createElement("div");
  node.className = `ask-message is-${message.role}${message.pending ? " is-pending" : ""}`;
  const label = document.createElement("div");
  label.className = "ask-message-label";
  label.textContent = message.role === "user" ? "你" : "助手";
  const body = document.createElement("div");
  body.className = "ask-message-body markdown-body";
  body.innerHTML = message.role === "assistant" ? renderMarkdown(message.text) : escapeHtml(message.text);
  node.append(label, body);
  return node;
}

function setAskOverview(text, { persist = true } = {}) {
  askOverviewMarkdown = text || "";
  controls.askOverview.innerHTML = renderMarkdown(text);
  if (persist) saveUiState();
}

async function restoreUiState() {
  const stored = await chrome.storage.local.get({ [currentUiStateKey]: {} });
  const state = stored[currentUiStateKey] || {};
  if (state.summaryResult) setSummaryResult(state.summaryResult, { persist: false });
  if (state.askOverviewMarkdown || state.askOverview) {
    setAskOverview(state.askOverviewMarkdown || state.askOverview, { persist: false });
    askOverviewLoaded = Boolean(state.askOverviewLoaded);
  } else {
    askOverviewMarkdown = "";
    askOverviewLoaded = false;
  }
  askMessages = Array.isArray(state.askMessages) ? state.askMessages : [];
  renderAskMessages();
  controls.askQuestion.value = state.askQuestion || "";
  controls.userNote.value = state.userNote || "";
  resizeAskInput();
  if (state.activeTab) activateTab(state.activeTab);
}

async function saveUiState() {
  const activeTab = controls.tabs.find((tab) => tab.classList.contains("is-active"))?.dataset.tab || "translate";
  const summaryText = controls.summaryCard.classList.contains("is-empty")
    ? ""
    : controls.summaryResult.textContent;
  await chrome.storage.local.set({
    [currentUiStateKey]: {
      activeTab,
      summaryResult: summaryText,
      askOverviewMarkdown,
      askOverviewLoaded,
      askMessages,
      askQuestion: controls.askQuestion.value,
      userNote: controls.userNote.value
    }
  });
}

async function getUiStateKey() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return `${UI_STATE_KEY}:${hashString(tab?.url || "")}`;
  } catch {
    return UI_STATE_KEY;
  }
}

function hashString(text) {
  let hash = 2166136261;
  for (let index = 0; index < String(text || "").length; index += 1) {
    hash ^= String(text).charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function renderMarkdown(markdown) {
  const lines = String(markdown || "").split("\n");
  const html = [];
  let listItems = [];
  let orderedItems = [];

  function flushList() {
    if (!listItems.length) return;
    html.push(`<ul>${listItems.map((item) => `<li>${renderInlineMarkdown(escapeHtml(item))}</li>`).join("")}</ul>`);
    listItems = [];
  }

  function flushOrderedList() {
    if (!orderedItems.length) return;
    html.push(`<ol>${orderedItems.map((item) => `<li>${renderInlineMarkdown(escapeHtml(item))}</li>`).join("")}</ol>`);
    orderedItems = [];
  }

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      flushList();
      flushOrderedList();
      continue;
    }

    const bullet = line.match(/^[-*]\s+(.+)$/);
    if (bullet) {
      flushOrderedList();
      listItems.push(bullet[1]);
      continue;
    }

    const ordered = line.match(/^\d+[\.)]\s+(.+)$/);
    if (ordered) {
      flushList();
      orderedItems.push(ordered[1]);
      continue;
    }

    flushList();
    flushOrderedList();
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      const level = Math.min(3, heading[1].length);
      html.push(`<h${level}>${renderInlineMarkdown(escapeHtml(heading[2]))}</h${level}>`);
    } else {
      html.push(`<p>${renderInlineMarkdown(escapeHtml(line))}</p>`);
    }
  }

  flushList();
  flushOrderedList();
  return html.join("");
}

function renderInlineMarkdown(text) {
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

function setPassiveBusy(isBusy, message = "") {
  controls.statusDot.className = `status-dot${isBusy ? " is-busy" : ""}`;
  if (message) controls.message.textContent = message;
}

function resizeAskInput() {
  controls.askQuestion.style.height = "auto";
  const nextHeight = Math.min(96, Math.max(34, controls.askQuestion.scrollHeight));
  controls.askQuestion.style.height = `${nextHeight}px`;
}

function normalizeSaveDir(value) {
  return String(value || DEFAULT_SETTINGS.saveDir)
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.\.+/g, "")
    .trim() || DEFAULT_SETTINGS.saveDir;
}
