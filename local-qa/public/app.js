const api = "";
const els = {
  indexMeta: document.querySelector("#indexMeta"),
  notesDir: document.querySelector("#notesDir"),
  provider: document.querySelector("#provider"),
  baseUrl: document.querySelector("#baseUrl"),
  model: document.querySelector("#model"),
  apiKey: document.querySelector("#apiKey"),
  apiKeyWrap: document.querySelector("#apiKeyWrap"),
  pickDirBtn: document.querySelector("#pickDirBtn"),
  saveConfigBtn: document.querySelector("#saveConfigBtn"),
  reindexBtn: document.querySelector("#reindexBtn"),
  messages: document.querySelector("#messages"),
  form: document.querySelector("#askForm"),
  question: document.querySelector("#question"),
  askBtn: document.querySelector("#askBtn"),
  status: document.querySelector("#status")
};

init();

async function init() {
  bind();
  await loadConfig();
}

function bind() {
  els.provider.addEventListener("change", updateProviderFields);
  els.pickDirBtn.addEventListener("click", pickDirectory);
  els.saveConfigBtn.addEventListener("click", saveConfig);
  els.reindexBtn.addEventListener("click", reindex);
  els.form.addEventListener("submit", async (event) => {
    event.preventDefault();
    await ask();
  });
}

async function loadConfig() {
  const data = await request("/api/config");
  const config = data.config || {};
  els.notesDir.value = config.notesDir || "";
  els.provider.value = config.provider || "ollama";
  els.baseUrl.value = config.baseUrl || "http://localhost:11434";
  els.model.value = config.model || "qwen3.5:4b";
  updateProviderFields();
  renderIndex(data.index);
}

async function saveConfig() {
  setBusy(true, "正在保存设置...");
  try {
    const data = await request("/api/config", {
      method: "POST",
      body: JSON.stringify(readConfig())
    });
    renderIndex(data.index);
    await reindex();
  } finally {
    setBusy(false, "设置已保存。");
  }
}

async function pickDirectory() {
  setBusy(true, "正在打开目录选择器...");
  try {
    const data = await request("/api/pick-directory", {
      method: "POST",
      body: "{}"
    });
    if (data.cancelled) {
      setStatus("已取消选择。");
      return;
    }
    els.notesDir.value = data.path || "";
    await reindex();
  } finally {
    setBusy(false);
  }
}

async function reindex() {
  setBusy(true, "正在扫描 Markdown...");
  try {
    const data = await request("/api/index", { method: "POST", body: "{}" });
    renderIndex(data.index);
    setStatus("索引已更新。");
  } finally {
    setBusy(false);
  }
}

async function ask() {
  const question = els.question.value.trim();
  if (!question) return;
  appendMessage("user", question);
  els.question.value = "";
  const pending = appendMessage("assistant", "正在查找笔记并组织回答", { pending: true });
  setBusy(true, "正在回答...");
  try {
    const data = await request("/api/ask", {
      method: "POST",
      body: JSON.stringify({ question })
    });
    pending.node.classList.remove("pending");
    pending.text.innerHTML = renderMarkdown(data.answer || "没有得到回答。");
    renderSources(pending.node, data.sources || []);
    setStatus("回答完成。");
  } catch (error) {
    pending.node.classList.remove("pending");
    pending.text.textContent = error.message || String(error);
  } finally {
    setBusy(false);
  }
}

function readConfig() {
  return {
    notesDir: els.notesDir.value.trim(),
    provider: els.provider.value,
    baseUrl: els.baseUrl.value.trim(),
    model: els.model.value.trim(),
    apiKey: els.apiKey.value.trim()
  };
}

function updateProviderFields() {
  els.apiKeyWrap.style.display = els.provider.value === "openaiCompatible" ? "grid" : "none";
}

function appendMessage(role, text, options = {}) {
  const node = document.createElement("article");
  node.className = `message ${role}${options.pending ? " pending" : ""}`;
  const body = document.createElement("div");
  body.className = "message-body";
  if (role === "assistant" && !options.pending) {
    body.innerHTML = renderMarkdown(text);
  } else {
    body.textContent = text;
  }
  node.append(body);
  els.messages.append(node);
  node.scrollIntoView({ block: "end" });
  return { node, text: body };
}

function renderSources(node, sources) {
  if (!sources.length) return;
  const wrap = document.createElement("section");
  wrap.className = "sources";
  wrap.textContent = "来源";
  for (const source of sources.slice(0, 6)) {
    const item = document.createElement("div");
    const link = document.createElement("a");
    link.href = source.sourceUrl || "#";
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = `${source.relativePath} · ${source.title}`;
    const time = document.createElement("span");
    time.textContent = `材料时间：${source.sourceTime?.label || "未知"}`;
    item.append(link, time);
    wrap.append(item);
  }
  node.append(wrap);
}

function renderIndex(index = {}) {
  if (!index?.builtAt) {
    els.indexMeta.textContent = "尚未建立索引。设置笔记目录后点击重新索引。";
    return;
  }
  const time = new Date(index.builtAt).toLocaleString();
  els.indexMeta.textContent = `已索引 ${index.fileCount || 0} 个文件、${index.chunkCount || 0} 个片段。更新时间：${time}`;
}

async function request(path, options = {}) {
  const response = await fetch(`${api}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options
  });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.error || "请求失败。");
  return data;
}

function setBusy(isBusy, message = "") {
  els.askBtn.disabled = isBusy;
  els.pickDirBtn.disabled = isBusy;
  els.saveConfigBtn.disabled = isBusy;
  els.reindexBtn.disabled = isBusy;
  if (message) setStatus(message);
}

function setStatus(message) {
  els.status.textContent = message || "";
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
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_match, label, href) => {
      const safeHref = String(href || "");
      if (!/^(?:https?:\/\/|\/api\/source\?)/i.test(safeHref)) return label;
      return `<a href="${safeHref}" target="_blank" rel="noreferrer">${label}</a>`;
    })
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
