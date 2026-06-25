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

如果在线 API 请求失败、被限流或不可用，扩展会自动尝试本地 Ollama 默认配置作为兜底。

## 使用建议

- 普通阅读推荐「段落下方增加中文」，最不容易影响原网页排版。
- 想快速扫读时用「替换原文」。
- 每次把普通笔记、网页标记或 hover 笔记发送到“我的笔记”后，会使用当前选择的 LLM 删除重复内容；保存 Markdown 时直接写入文件，不再等待模型。hover 笔记会同时保存对应段落，并在下一行缩进展示笔记。
- 如果页面内容很多，第一次翻译会分批进行，状态会显示在扩展弹窗里。
- `qwen3.5:4b` 是当前推荐的实时翻译默认模型，兼顾速度和质量。追求更高质量时可以在 Ollama 下拉框里选择 `translategemma:12b`；追求更快响应时可以选择更小的已安装模型。

## Arc 快捷键

Arc 基于 Chromium，但它有自己的快捷键和扩展快捷键作用域。若默认的 `Alt+Shift+O/T/N` 或页面内标记快捷键不生效，先打开 `arc://extensions/shortcuts`，检查本扩展的快捷键是否被 Arc 分配，并把作用域从浏览器内改成可用的全局/扩展作用域；如果仍冲突，换成不被 Arc 占用的组合键，例如 `Command+Shift+O/T/N`。macOS 下 Chrome 扩展命令可以使用 `Command`；如果要用 Control，需要在 manifest 的 mac 快捷键里写 `MacCtrl`。
