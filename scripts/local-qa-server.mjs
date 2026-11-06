import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import { extname, isAbsolute, join, resolve, relative, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const PUBLIC_DIR = join(ROOT, "local-qa", "public");
const CONFIG_PATH = join(ROOT, ".local-qa-config.json");
const PORT = Number(process.env.PORT || 3218);
const execFileAsync = promisify(execFile);
const DEFAULT_CONFIG = {
  notesDir: "",
  provider: "ollama",
  baseUrl: "http://localhost:11434",
  model: "qwen3.5:4b",
  apiKey: "",
  topK: 8
};

let config = await loadConfig();
let indexState = {
  builtAt: 0,
  notesDir: "",
  files: [],
  chunks: []
};

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    if (request.method === "OPTIONS") return sendJson(response, { ok: true });

    if (url.pathname === "/api/health") return sendJson(response, { ok: true, port: PORT });
    if (url.pathname === "/api/config" && request.method === "GET") {
      return sendJson(response, { ok: true, config: publicConfig(config), index: summarizeIndex() });
    }
    if (url.pathname === "/api/config" && request.method === "POST") {
      const input = await readJson(request);
      const nextConfig = normalizeConfig({ ...config, ...input });
      const shouldResetIndex = hasIndexConfigChanged(config, nextConfig);
      config = nextConfig;
      if (shouldResetIndex) {
        await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));
        indexState = { builtAt: 0, notesDir: "", files: [], chunks: [] };
      }
      return sendJson(response, { ok: true, config: publicConfig(config), index: summarizeIndex() });
    }
    if (url.pathname === "/api/index" && request.method === "POST") {
      await rebuildIndex();
      return sendJson(response, { ok: true, index: summarizeIndex() });
    }
    if (url.pathname === "/api/pick-directory" && request.method === "POST") {
      const result = await pickDirectory();
      if (result.cancelled) return sendJson(response, { ok: true, cancelled: true });
      config = normalizeConfig({ ...config, notesDir: result.path });
      await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));
      indexState = { builtAt: 0, notesDir: "", files: [], chunks: [] };
      return sendJson(response, { ok: true, path: config.notesDir, config: publicConfig(config) });
    }
    if (url.pathname === "/api/search" && request.method === "POST") {
      const input = await readJson(request);
      await ensureIndex();
      return sendJson(response, { ok: true, results: searchChunks(input.query || "", input.limit || 10) });
    }
    if (url.pathname === "/api/ask" && request.method === "POST") {
      const input = await readJson(request);
      const answer = await askNotes(input.question || "");
      return sendJson(response, { ok: true, ...answer });
    }
    if (url.pathname === "/api/source" && request.method === "GET") {
      return serveSourceFile(url.searchParams.get("path") || "", response);
    }

    return serveStatic(url.pathname, response);
  } catch (error) {
    sendJson(response, { ok: false, error: humanizeError(error) }, 500);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Local notes QA is running at http://localhost:${PORT}`);
});

async function loadConfig() {
  const fileConfig = existsSync(CONFIG_PATH)
    ? JSON.parse(await readFile(CONFIG_PATH, "utf8"))
    : {};
  return normalizeConfig({
    ...DEFAULT_CONFIG,
    ...fileConfig,
    notesDir: process.env.NOTES_DIR || fileConfig.notesDir || DEFAULT_CONFIG.notesDir,
    provider: process.env.LLM_PROVIDER || fileConfig.provider || DEFAULT_CONFIG.provider,
    baseUrl: process.env.LLM_BASE_URL || fileConfig.baseUrl || DEFAULT_CONFIG.baseUrl,
    model: process.env.LLM_MODEL || fileConfig.model || DEFAULT_CONFIG.model,
    apiKey: process.env.LLM_API_KEY || fileConfig.apiKey || DEFAULT_CONFIG.apiKey
  });
}

function normalizeConfig(value) {
  return {
    notesDir: String(value.notesDir || "").trim(),
    provider: value.provider === "openaiCompatible" ? "openaiCompatible" : "ollama",
    baseUrl: String(value.baseUrl || DEFAULT_CONFIG.baseUrl).trim().replace(/\/+$/, ""),
    model: String(value.model || DEFAULT_CONFIG.model).trim(),
    apiKey: String(value.apiKey || "").trim(),
    topK: Math.min(20, Math.max(3, Number(value.topK || DEFAULT_CONFIG.topK)))
  };
}

function publicConfig(value) {
  return { ...value, apiKey: value.apiKey ? "********" : "" };
}

function hasIndexConfigChanged(current, next) {
  return current.notesDir !== next.notesDir
    || current.provider !== next.provider
    || current.baseUrl !== next.baseUrl
    || current.model !== next.model
    || current.apiKey !== next.apiKey
    || current.topK !== next.topK;
}

async function pickDirectory() {
  if (process.platform !== "darwin") {
    throw new Error("当前系统暂不支持目录选择器，请手动输入路径。");
  }

  const script = [
    "try",
    "set selectedFolder to choose folder with prompt \"选择 Markdown 笔记目录\"",
    "POSIX path of selectedFolder",
    "on error number -128",
    "\"\"",
    "end try"
  ].join("\n");
  const { stdout } = await execFileAsync("osascript", ["-e", script], { timeout: 120000 });
  const selected = stdout.trim().replace(/\/+$/, "");
  return selected ? { path: selected } : { cancelled: true };
}

async function rebuildIndex() {
  const notesDir = resolve(config.notesDir || "");
  if (!config.notesDir || !existsSync(notesDir)) {
    throw new Error("请先设置一个存在的 Markdown 笔记目录。");
  }

  const files = await findMarkdownFiles(notesDir);
  const chunks = [];
  for (const file of files) {
    const raw = await readFile(file, "utf8");
    const fileStat = await stat(file);
    const parsed = parseMarkdown(raw);
    const relativePath = relative(notesDir, file);
    const sourceTime = resolveSourceTime(parsed.meta, fileStat);
    for (const chunk of chunkMarkdown(parsed.body)) {
      const searchText = `${parsed.title || ""} ${parsed.tags.join(" ")} ${relativePath} ${chunk}`;
      chunks.push({
        id: `${relativePath}#${chunks.length + 1}`,
        file,
        relativePath,
        title: parsed.title || titleFromPath(file),
        tags: parsed.tags,
        sourceUrl: `/api/source?path=${encodeURIComponent(relativePath)}`,
        sourceTime,
        text: chunk,
        lowerTitle: (parsed.title || titleFromPath(file)).toLowerCase(),
        lowerPath: relativePath.toLowerCase(),
        tokenCounts: countTokens(searchText)
      });
    }
  }

  indexState = {
    builtAt: Date.now(),
    notesDir,
    files: files.map((file) => relative(notesDir, file)),
    chunks
  };
}

async function ensureIndex() {
  if (!indexState.builtAt || indexState.notesDir !== resolve(config.notesDir || "")) {
    await rebuildIndex();
  }
}

async function findMarkdownFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await findMarkdownFiles(path));
    } else if (entry.isFile() && [".md", ".markdown"].includes(extname(entry.name).toLowerCase())) {
      files.push(path);
    }
  }
  return files.sort((a, b) => a.localeCompare(b));
}

function parseMarkdown(raw) {
  const text = String(raw || "").replace(/\r\n?/g, "\n");
  const frontmatter = text.match(/^---\n([\s\S]*?)\n---\n?/);
  const meta = frontmatter ? parseFrontmatter(frontmatter[1]) : {};
  const body = frontmatter ? text.slice(frontmatter[0].length) : text;
  const heading = body.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return {
    title: meta.title || heading || "",
    tags: normalizeTags(meta.tags),
    meta,
    body: body.trim()
  };
}

function parseFrontmatter(text) {
  const meta = {};
  for (const line of text.split("\n")) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    meta[match[1]] = match[2].replace(/^["']|["']$/g, "").trim();
  }
  return meta;
}

function normalizeTags(value) {
  if (!value) return [];
  return String(value)
    .replace(/^\[|\]$/g, "")
    .split(/[,，]/)
    .map((item) => item.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

function resolveSourceTime(meta, fileStat) {
  const explicit = meta.updated || meta.modified || meta.date || meta.created || meta.time;
  const parsed = explicit ? new Date(explicit) : null;
  const date = parsed && !Number.isNaN(parsed.getTime()) ? parsed : fileStat.mtime;
  return {
    label: formatDateTime(date),
    iso: date.toISOString(),
    kind: explicit ? "frontmatter" : "modified"
  };
}

function formatDateTime(date) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
}

function chunkMarkdown(markdown) {
  const blocks = String(markdown || "")
    .split(/\n(?=#{1,3}\s+)/)
    .map((item) => item.trim())
    .filter(Boolean);
  const chunks = [];
  for (const block of blocks.length ? blocks : [markdown]) {
    const chars = Array.from(block);
    for (let start = 0; start < chars.length; start += 1600) {
      const piece = chars.slice(start, start + 2200).join("").trim();
      if (piece.length >= 40) chunks.push(piece);
    }
  }
  return chunks;
}

function searchChunks(query, limit = config.topK) {
  const terms = tokenize(query);
  if (!terms.length) return [];
  return indexState.chunks
    .map((chunk) => ({ ...chunk, score: scoreChunk(chunk, terms) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ lowerTitle, lowerPath, tokenCounts, ...item }) => item);
}

function scoreChunk(chunk, terms) {
  let score = 0;
  for (const term of terms) {
    const bodyHits = chunk.tokenCounts[term] || 0;
    if (bodyHits) score += bodyHits;
    if (chunk.lowerTitle.includes(term)) score += 4;
    if (chunk.lowerPath.includes(term)) score += 3;
  }
  return score;
}

function countTokens(text) {
  const counts = Object.create(null);
  for (const token of tokenize(text)) {
    counts[token] = (counts[token] || 0) + 1;
  }
  return counts;
}

function tokenize(text) {
  return Array.from(new Set(rawTokens(text))).slice(0, 80);
}

function rawTokens(text) {
  const lower = String(text || "").toLowerCase();
  const latin = lower.match(/[a-z0-9][a-z0-9._-]{1,}/g) || [];
  const cjk = lower.match(/[\u4e00-\u9fff]{2,}/g) || [];
  const cjkPairs = cjk.flatMap((item) => {
    const chars = Array.from(item);
    return chars.slice(0, -1).map((_, index) => chars.slice(index, index + 2).join(""));
  });
  return [...latin, ...cjk, ...cjkPairs];
}

async function askNotes(question) {
  const cleanQuestion = String(question || "").trim();
  if (!cleanQuestion) throw new Error("请输入问题。");
  await ensureIndex();
  const results = searchChunks(cleanQuestion, config.topK);
  if (!results.length) {
    return {
      answer: "没有在当前 Markdown 笔记里找到足够相关的内容。可以换几个关键词，或先确认笔记目录已经重新索引。",
      sources: []
    };
  }

  const context = results.map((item, index) => [
    `资料 ${index + 1}`,
    `标题：${item.title}`,
    `文件：${item.relativePath}`,
    `材料时间：${item.sourceTime.label}`,
    item.text
  ].join("\n")).join("\n\n---\n\n");

  const answer = await chat([
    {
      role: "system",
      content: [
        "你是本地 Markdown 笔记问答助手。",
        "只依据用户提供的资料回答，不要编造资料外的事实。",
        "如果资料不足，直接说明不足，并给出可继续查找的关键词。",
        "用简体中文回答，结构清晰，尽量给出结论、依据和来源文件。"
      ].join("")
    },
    {
      role: "user",
      content: `问题：${cleanQuestion}\n\n本地笔记资料：\n${context}`
    }
  ]);

  return {
    answer: stripModelNoise(answer),
    sources: results.map(({ score, file, relativePath, title, sourceUrl, sourceTime }) => ({
      score,
      file,
      relativePath,
      title,
      sourceUrl,
      sourceTime
    }))
  };
}

async function chat(messages) {
  if (config.provider === "openaiCompatible") return chatOpenAICompatible(messages);
  return chatOllama(messages);
}

async function chatOllama(messages) {
  const response = await fetch(`${config.baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.model,
      stream: false,
      think: false,
      keep_alive: "30m",
      options: { temperature: 0.1, num_ctx: 12000, num_predict: 1800 },
      messages
    })
  });
  if (!response.ok) throw new Error(`Ollama 请求失败：${response.status} ${await response.text()}`);
  const data = await response.json();
  return data?.message?.content || "";
}

async function chatOpenAICompatible(messages) {
  const headers = { "Content-Type": "application/json" };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
  const endpoint = config.baseUrl.endsWith("/chat/completions")
    ? config.baseUrl
    : `${config.baseUrl.replace(/\/v1\/?$/, "")}/v1/chat/completions`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: config.model, temperature: 0.1, max_tokens: 1800, messages })
  });
  if (!response.ok) throw new Error(`API 请求失败：${response.status} ${await response.text()}`);
  const data = await response.json();
  return data?.choices?.[0]?.message?.content || "";
}

function summarizeIndex() {
  return {
    builtAt: indexState.builtAt,
    notesDir: indexState.notesDir,
    fileCount: indexState.files.length,
    chunkCount: indexState.chunks.length
  };
}

async function serveStatic(pathname, response) {
  const safePath = normalize(decodeURIComponent(pathname === "/" ? "/index.html" : pathname)).replace(/^(\.\.[/\\])+/, "");
  const file = resolve(PUBLIC_DIR, `.${safePath}`);
  if (!file.startsWith(PUBLIC_DIR)) return sendText(response, "Not found", 404);
  if (!existsSync(file) || (await stat(file)).isDirectory()) return sendText(response, "Not found", 404);
  response.writeHead(200, {
    "Content-Type": contentType(file),
    "Access-Control-Allow-Origin": "*"
  });
  createReadStream(file).pipe(response);
}

async function serveSourceFile(relativeSourcePath, response) {
  const notesDir = resolve(config.notesDir || "");
  if (!config.notesDir || !existsSync(notesDir)) return sendText(response, "Notes directory is not configured", 404);

  const safeRelative = normalize(relativeSourcePath).replace(/^(\.\.[/\\])+/, "");
  const file = resolve(notesDir, safeRelative);
  if (!isPathInside(file, notesDir) || !existsSync(file)) return sendText(response, "Not found", 404);
  if (![".md", ".markdown"].includes(extname(file).toLowerCase())) return sendText(response, "Not found", 404);

  response.writeHead(200, {
    "Content-Type": "text/markdown; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Content-Disposition": `inline; filename="${encodeURIComponent(file.split(/[\\/]/).pop() || "source.md")}"`
  });
  createReadStream(file).pipe(response);
}

function isPathInside(file, parent) {
  const relativePath = relative(parent, file);
  return Boolean(relativePath) && !relativePath.startsWith("..") && !isAbsolute(relativePath);
}

function sendJson(response, payload, status = 200) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
  });
  response.end(JSON.stringify(payload));
}

function sendText(response, text, status = 200) {
  response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  response.end(text);
}

function readJson(request) {
  return new Promise((resolveJson, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) request.destroy();
    });
    request.on("end", () => {
      try {
        resolveJson(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function contentType(file) {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  return "application/octet-stream";
}

function titleFromPath(file) {
  return file.split(/[\\/]/).pop()?.replace(/\.(md|markdown)$/i, "") || "Untitled";
}

function stripModelNoise(text) {
  return String(text || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^\s*```(?:markdown|md)?\s*\n?/i, "")
    .replace(/\n?```\s*$/i, "")
    .trim();
}

function humanizeError(error) {
  if (error?.name === "AbortError") return "请求超时。";
  return error?.message || String(error);
}
