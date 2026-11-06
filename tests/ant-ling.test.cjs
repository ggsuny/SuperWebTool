const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');
const source = (file) => readFileSync(new URL(`../${file}`, `file://${__filename}`), 'utf8');

function background(fetch) {
  const event = { addListener() {} };
  const context = vm.createContext({
    chrome: {
      runtime: { onInstalled: event, onStartup: event, onMessage: event, onConnect: event },
      action: { onClicked: event }, commands: { onCommand: event }, contextMenus: { onClicked: event }
    }, fetch, AbortController, TextDecoder, setTimeout, clearTimeout, console
  });
  vm.runInContext(source('src/background.js'), context);
  return context;
}

const settings = { provider: 'antLing', apiKey: 'test-key' };

test('百灵批量翻译使用官方地址、认证和响应内容', async () => {
  const calls = [];
  const app = background(async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    return { ok: true, json: async () => ({ choices: [{ message: { content: '["你好"]' } }] }) };
  });
  assert.deepEqual(Array.from(await app.translateBatch(['Hello'], settings)), ['你好']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.ant-ling.com/v1/chat/completions');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer test-key');
  assert.equal(calls[0].body.model, 'Ling-3.0-flash');
  assert.equal(calls[0].body.thinking.type, 'disabled');
});

test('百灵流式翻译正确分发文本和完成事件', async () => {
  const events = [];
  const encoder = new TextEncoder();
  let request;
  const app = background(async (url, options) => {
    request = { url, body: JSON.parse(options.body) };
    return { ok: true, body: new ReadableStream({ start(controller) {
      const data = 'data: {"choices":[{"delta":{"content":"你好"}}]}\n\ndata: [DONE]\n\n';
      const bytes = encoder.encode(data);
      controller.enqueue(bytes.slice(0, 17));
      controller.enqueue(bytes.slice(17));
      controller.close();
    } }) };
  });
  await app.streamTranslationToPort('Hello', settings, { postMessage: (event) => events.push(event) }, new AbortController());
  assert.equal(request.body.stream, true);
  assert.equal(request.url, 'https://api.ant-ling.com/v1/chat/completions');
  assert.equal(events.filter((event) => event.type === 'chunk').map((event) => event.chunk).join(''), '你好');
  assert.equal(events.at(-1).type, 'done');
  assert.equal(events.at(-1).text, '你好');
});

test('总结和 Ask 使用百灵自定义模型与地址', async () => {
  const app = background(async (url, options) => {
    assert.equal(url, 'https://example.com/v1/chat/completions');
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'Ling-3.1-flash');
    assert.equal(body.thinking.type, 'disabled');
    return { ok: true, json: async () => ({ choices: [{ message: { content: '摘要' } }] }) };
  });
  assert.equal(await app.chatWithConfiguredProvider({ ...settings, baseUrl: 'https://example.com/v1/', model: 'Ling-3.1-flash' }, [{ role: 'user', content: '总结' }]), '摘要');
});

test('未填写百灵密钥时提示设置且不发送请求', async () => {
  const app = background(() => { throw new Error('不应发送请求'); });
  await assert.rejects(app.translateBatch(['Hello'], { provider: 'antLing' }), /百灵 API Key/);
});

test('现有 OpenAI 兼容后端保持原请求格式，百灵失败仍可回退 Ollama', async () => {
  const calls = [];
  const app = background(async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url, body });
    if (url.startsWith('https://api.ant-ling.com')) return { ok: false, status: 429, text: async () => 'rate limit' };
    if (url.includes('/api/chat')) return { ok: true, json: async () => ({ message: { content: '["本地翻译"]' } }) };
    return { ok: true, json: async () => ({ choices: [{ message: { content: '["在线翻译"]' } }] }) };
  });
  const online = await app.translateBatch(['Hello'], { provider: 'openaiCompatible', baseUrl: 'https://example.com/v1', model: 'custom' });
  assert.equal(online[0], '在线翻译');
  assert.equal('thinking' in calls[0].body, false);
  const fallback = await app.translateBatch(['Hello'], settings);
  assert.equal(fallback[0], '本地翻译');
  assert.equal(calls.at(-1).url, 'http://localhost:11434/api/chat');
});

function popup() {
  const elements = new Map();
  const element = (selector) => {
    if (!elements.has(selector)) elements.set(selector, {
      value: '', checked: false, style: {}, listeners: {},
      addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    });
    return elements.get(selector);
  };
  const app = vm.createContext({ document: { querySelector: element, querySelectorAll: () => [] }, chrome: {}, console });
  vm.runInContext(source('src/popup.js').replace('\ninit();', ''), app);
  vm.runInContext(`
    updateProviderFields = async () => {};
    saveUiState = async () => {};
    loadSettings = async () => ({ ...DEFAULT_SETTINGS, provider: 'openaiCompatible', baseUrl: 'https://old.example/v1', model: 'old-model', apiKey: 'old-key' });
    bindTabs = () => {};
    getUiStateKey = async () => 'test';
    restoreUiState = async () => {};
    chrome.storage = { onChanged: { addListener() {} }, sync: { set: async (settings) => { globalThis.saved = settings; } } };
  `, app);
  return { app, element };
}

test('弹窗切换百灵后预填默认配置，并保存、恢复各后端密钥', async () => {
  const { app, element } = popup();
  await app.init();
  const provider = element('#provider');
  const change = async (value) => {
    provider.value = value;
    for (const listener of provider.listeners.change) await listener();
  };
  await change('antLing');
  assert.equal(element('#baseUrl').value, 'https://api.ant-ling.com/v1');
  assert.equal(element('#model').value, 'Ling-3.0-flash');
  assert.equal(element('#apiKey').value, '');
  element('#apiKey').value = 'ling-key';
  await app.persistSettings();
  await change('openaiCompatible');
  assert.equal(element('#apiKey').value, 'old-key');
  assert.equal(element('#model').value, 'old-model');
  await change('antLing');
  assert.equal(element('#apiKey').value, 'ling-key');
  assert.equal(app.saved.providerConfigs.openaiCompatible.apiKey, 'old-key');
  const saved = app.saved;
  app.applySettings(saved);
  assert.equal(element('#apiKey').value, 'ling-key');
});

test('网页阅读面板切换后端时保留独立配置并同步保存', async () => {
  const code = source('src/content.js');
  const elements = new Map();
  const element = (selector) => {
    if (!elements.has(selector)) elements.set(selector, {
      value: '', checked: false, hidden: false, listeners: {}, label: {},
      matches(selectors) { return selectors.split(',').some((item) => item.trim() === selector); },
      addEventListener(type, fn) { this.listeners[type] = fn; },
      closest() { return this.label; }
    });
    return elements.get(selector);
  };
  const initial = { provider: 'openaiCompatible', baseUrl: 'https://old.example/v1', model: 'old-model', apiKey: 'old-key' };
  const panel = { __pitSettings: initial, querySelector: element, querySelectorAll: (selectors) => selectors.split(',').map((item) => element(item.trim())) };
  const app = vm.createContext({
    panel, DEFAULT_OLLAMA: { baseUrl: 'http://localhost:11434', model: 'qwen3.5:4b' },
    normalizeColor: (value) => value, normalizeFontSizePercent: () => 100,
    normalizeLineHeight: () => 1.4, normalizePanelLocalQaUrl: (value) => value,
    getMarkHighlightColor: () => '#fff2a8', updateTypographyLabels() {},
    applyTranslationTypographyToPage() {}, applyMarkColorToPage() {},
    replaceSelectOptions: (select, options) => { select.value = options[0].value; },
    chrome: { storage: { sync: { set: async (settings) => { app.saved = settings; } } } }
  });
  vm.runInContext(code.slice(code.indexOf('function getPanelProviderDefaults('), code.indexOf('function replaceSelectOptions(')), app);
  vm.runInContext(code.slice(code.indexOf('function persistPanelSettings('), code.indexOf('function applyPanelResize(')), app);
  const start = code.indexOf('  panel.querySelectorAll([\n    ".pit-panel-mode"');
  const end = code.indexOf('\n  panel.querySelector(".pit-panel-translate")', start);
  element('.pit-panel-provider').value = initial.provider;
  element('.pit-panel-model-input').value = initial.model;
  element('.pit-panel-base-url').value = initial.baseUrl;
  element('.pit-panel-api-key').value = initial.apiKey;
  vm.runInContext(code.slice(start, end), app);
  const provider = element('.pit-panel-provider');
  provider.value = 'antLing';
  provider.listeners.input();
  provider.listeners.change();
  assert.equal(element('.pit-panel-base-url').value, 'https://api.ant-ling.com/v1');
  assert.equal(element('.pit-panel-model-input').value, 'Ling-3.0-flash');
  assert.equal(element('.pit-panel-api-key').value, '');
  assert.equal(element('.pit-panel-model-select').hidden, true);
  assert.equal(element('.pit-panel-api-key').label.hidden, false);
  element('.pit-panel-api-key').value = 'ling-key';
  element('.pit-panel-api-key').listeners.input();
  provider.value = 'openaiCompatible';
  provider.listeners.change();
  assert.equal(element('.pit-panel-model-input').value, 'old-model');
  assert.equal(element('.pit-panel-api-key').value, 'old-key');
  provider.value = 'antLing';
  provider.listeners.change();
  assert.equal(element('.pit-panel-api-key').value, 'ling-key');
  assert.equal(app.saved.provider, 'antLing');
  assert.equal(app.saved.providerConfigs.antLing.apiKey, 'ling-key');
});
