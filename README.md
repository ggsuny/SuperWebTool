# Page Inline Translator

一个轻量 Chrome/Edge 扩展，用于在英文网页原页面内翻译中文。支持两种模式：

- **段落下方增加中文**：保留原文，在每个正文块下方追加中文翻译。
- **替换原文**：将正文块临时替换为中文，并保留恢复原文能力。

扩展优先保持原有页面布局和风格，不会改写整页 HTML，也会跳过导航、表单、代码块、隐藏元素等容易破坏体验的区域。

## 安装

1. 打开 Chrome 的 `chrome://extensions/`。
2. 开启右上角「开发者模式」。
3. 点击「加载已解压的扩展程序」。
4. 选择本目录：`/Users/ericlau/Documents/chrome翻译插件`。

## 推荐本地免费模型

如果你用 MacBook Pro，不建议下载很大的模型。推荐先用 Ollama 的小模型：

```sh
brew install ollama
ollama serve
ollama pull qwen3.5:4b
```

扩展默认配置：

- Provider: `本地 Ollama`
- Base URL: `http://localhost:11434`
- Model: `qwen3.5:4b`

选择 `本地 Ollama` 时，扩展会自动读取 `http://localhost:11434/api/tags`，把已经下载安装的模型显示为下拉选项。

如果想更轻量，可以试 `qwen:latest`；如果更重视质量，可以试 `translategemma:12b`。

## 修复 Ollama 403

如果翻译时报 `Ollama request failed: 403`，说明 Ollama 拒绝了 Chrome 扩展来源。执行下面命令后，完全退出并重新打开 Ollama：

```sh
launchctl setenv OLLAMA_ORIGINS 'chrome-extension://*,http://localhost:*,http://127.0.0.1:*'
```

如果你习惯从终端启动 Ollama，也可以用项目里的脚本：

```sh
chmod +x scripts/start-ollama-for-extension.sh
./scripts/start-ollama-for-extension.sh
```

## 在线免费额度 API

也可以选择 `OpenAI-compatible API`，填写兼容 `/v1/chat/completions` 的 `Base URL`、`Model` 和 `API Key`。例如 Groq 官方文档使用的 OpenAI-compatible base URL 是 `https://api.groq.com/openai/v1`，模型可先试 `llama-3.1-8b-instant`。免费额度和频率限制经常变化，建议以服务商当前说明为准。

### 蚂蚁百灵 AI

1. 在[百灵 API 控制台](https://chat.ant-ling.com/)创建 API Key。
2. 打开扩展的「设置」，将「翻译后端」切换为「蚂蚁百灵 AI」。
3. 填写 API Key；接口地址默认是 `https://api.ant-ling.com/v1`，模型默认是 `Ling-3.0-flash`，也可以填写账号可用的其他模型 ID。
4. 设置自动保存，点击「翻译」即可使用百灵；网页内阅读面板和弹窗都支持配置，切换后端会记住各自的地址、模型和密钥。

百灵支持流式和批量翻译，页面总结和 Ask 也会使用当前选中的后端。为提高响应速度，百灵请求默认关闭思考模式。接口格式参见[百灵官方文档](https://developer.ant-ling.com/zh-CN/docs/api-reference/chat/openai)。

如果在线 API 请求失败、被限流或不可用，扩展会自动尝试本地 Ollama 默认配置作为兜底。

## 使用建议

- 点击扩展图标只会打开网页右侧的一个「页面阅读助手」面板。顶部提供「翻译」和「保存」按钮；标签页按阅读流程依次为「笔记 → Ask → 问笔记 → 发帖 → 设置」。进入 Ask 会先展示当前页面总结，再可继续提问。
- 普通阅读推荐「段落下方增加中文」，最不容易影响原网页排版。
- 想快速扫读时用「替换原文」。
- 每次把普通笔记、网页标记或 hover 笔记发送到“我的笔记”后，会使用当前选择的 LLM 删除重复内容。hover 笔记会同时保存对应段落，并在下一行缩进展示笔记。
- 保存 Markdown 时会提取网页主要正文，自动生成“原文总结”并放在“我的笔记”之后、“网页原文”之前；若当前本地或云端 LLM 可用，会根据页面内容生成简短关键词标题作为 Markdown 标题和文件名，否则使用网页标题。导出前还会移除不可见字符、空标记和纯装饰分隔符。

## 本地 Markdown 笔记问答

项目内置一个本地 Node 问答服务，可以扫描你指定目录下的 `.md` / `.markdown` 文件，并通过本地 Ollama 或 OpenAI-compatible API 回答问题。

启动服务：

```bash
npm run qa
```

默认地址是：

```text
http://localhost:3218
```

两种入口都支持：

- 直接打开 `http://localhost:3218`，在网页里设置 Markdown 笔记目录并提问。
- 点击 Chrome 扩展图标，在页面右侧的「页面阅读助手」里打开「问笔记」标签，填写本地问答服务地址，点击「选择目录」选中笔记目录，然后点击「重新索引」或直接提问。

服务会把配置保存在项目目录的 `.local-qa-config.json`。如果想用环境变量临时覆盖：

```bash
NOTES_DIR="/Users/you/notes" LLM_MODEL="qwen3.5:4b" npm run qa
```

当前版本使用轻量关键词检索，会优先把相关 Markdown 片段交给模型回答，并在回答末尾列出来源文件、材料时间和可点击的本地源文件链接。材料时间优先读取 frontmatter 里的 `updated`、`date`、`created` 等字段；没有这些字段时使用文件修改时间。后续如果笔记量很大，可以再升级为向量索引。

## 开发时自动重载

先手动刷新一次扩展，让自动重载代码生效。之后在项目目录运行：

```bash
./scripts/watch-extension.sh
```

保持终端窗口运行，修改 JavaScript、CSS、HTML、JSON 或图标文件后，扩展和当前已打开的普通网页会自动刷新。
- 如果页面内容很多，第一次翻译会分批进行，状态会显示在页面阅读助手内。
- `qwen3.5:4b` 是当前推荐的实时翻译默认模型，兼顾速度和质量。追求更高质量时可以在 Ollama 下拉框里选择 `translategemma:12b`；追求更快响应时可以选择更小的已安装模型。

## Arc 快捷键

Arc 基于 Chromium，但它有自己的快捷键和扩展快捷键作用域。若默认的 `Alt+Shift+O/T/N` 或页面内标记快捷键不生效，先打开 `arc://extensions/shortcuts`，检查本扩展的快捷键是否被 Arc 分配，并把作用域从浏览器内改成可用的全局/扩展作用域；如果仍冲突，换成不被 Arc 占用的组合键，例如 `Command+Shift+O/T/N`。macOS 下 Chrome 扩展命令可以使用 `Command`；如果要用 Control，需要在 manifest 的 mac 快捷键里写 `MacCtrl`。
