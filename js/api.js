// ============================================================
// 小栖 API Demo · API 调用封装
// ============================================================
// 改编自 StepForward 项目的 api.js（作者：温玥美）
// 双模式：
//   - 本地（localhost / 127.0.0.1 / file://）：API Key 存 localStorage，浏览器直连
//   - 线上（Netlify 部署）：走 /.netlify/functions/llm-proxy，Key 在服务端环境变量
// 支持服务商：deepseek / minimax / openai / zhipu / qwen / anthropic
// ============================================================

const XQ_PROVIDERS = {
  deepseek: {
    name: 'DeepSeek',
    endpoint: 'https://api.deepseek.com/v1/chat/completions',
    models: [
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro（能力更强）' },
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash（推荐，速度快）' },
    ],
    defaultModel: 'deepseek-v4-flash',
    buildBody: (messages, model, systemPrompt, options) => {
      const body = {
        model,
        messages: [{ role: 'system', content: systemPrompt }, ...messages],
        temperature: 0.7,
        max_tokens: 4096,
        // 关闭思考模式：思考链会吃掉 max_tokens 预算，导致正式回复为空
        thinking: { type: 'disabled' },
      };
      if (options?.json) body.response_format = { type: 'json_object' };
      return body;
    },
    extractContent: (data) => data.choices?.[0]?.message?.content || '',
  },
  minimax: {
    name: 'MiniMax',
    endpoint: 'https://api.minimaxi.com/v1/chat/completions',
    models: [
      { id: 'MiniMax-M2.5', name: 'MiniMax M2.5（推荐）' },
      { id: 'MiniMax-M2', name: 'MiniMax M2（性价比）' },
    ],
    defaultModel: 'MiniMax-M2.5',
    buildBody: (messages, model, systemPrompt, options) => {
      const body = {
        model,
        messages: [{ role: 'system', content: systemPrompt }, ...messages],
        temperature: 0.7,
        max_tokens: 4096,
      };
      if (options?.json) body.response_format = { type: 'json_object' };
      return body;
    },
    extractContent: (data) => data.choices?.[0]?.message?.content || '',
  },
  openai: {
    name: 'OpenAI',
    endpoint: 'https://api.openai.com/v1/chat/completions',
    models: [
      { id: 'gpt-5.5-mini', name: 'GPT-5.5 mini（推荐，性价比）' },
      { id: 'gpt-5.5', name: 'GPT-5.5（能力更强）' },
    ],
    defaultModel: 'gpt-5.5-mini',
    buildBody: (messages, model, systemPrompt, options) => {
      const body = {
        model,
        messages: [{ role: 'system', content: systemPrompt }, ...messages],
        // GPT-5.x 不支持 temperature 参数
        reasoning_effort: 'minimal',
        max_tokens: 4096,
      };
      if (options?.json) body.response_format = { type: 'json_object' };
      return body;
    },
    extractContent: (data) => data.choices?.[0]?.message?.content || '',
  },
  zhipu: {
    name: '智谱 AI',
    endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    models: [
      { id: 'glm-4.7-flash', name: 'GLM-4.7 Flash（免费档/速度快）' },
      { id: 'glm-4.6', name: 'GLM-4.6（能力更强）' },
    ],
    defaultModel: 'glm-4.7-flash',
    buildBody: (messages, model, systemPrompt, options) => {
      const body = {
        model,
        messages: [{ role: 'system', content: systemPrompt }, ...messages],
        temperature: 0.7,
        max_tokens: 4096,
      };
      if (options?.json) body.response_format = { type: 'json_object' };
      return body;
    },
    extractContent: (data) => data.choices?.[0]?.message?.content || '',
  },
  qwen: {
    name: '通义千问',
    endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    models: [
      { id: 'qwen-plus', name: 'Qwen Plus（推荐）' },
      { id: 'qwen-turbo', name: 'Qwen Turbo（速度快）' },
      { id: 'qwen3-max', name: 'Qwen3 Max（能力最强）' },
    ],
    defaultModel: 'qwen-plus',
    buildBody: (messages, model, systemPrompt, options) => {
      const body = {
        model,
        messages: [{ role: 'system', content: systemPrompt }, ...messages],
        temperature: 0.7,
        max_tokens: 4096,
      };
      // 仅 Qwen3/QwQ 思考模型需要显式关闭思考模式
      if (/^(qwen3|qwq)/i.test(model)) body.enable_thinking = false;
      if (options?.json) body.response_format = { type: 'json_object' };
      return body;
    },
    extractContent: (data) => data.choices?.[0]?.message?.content || '',
  },
  anthropic: {
    name: 'Anthropic',
    endpoint: 'https://api.anthropic.com/v1/messages',
    models: [{ id: 'claude-sonnet-5-0630', name: 'Claude Sonnet 5' }],
    defaultModel: 'claude-sonnet-5-0630',
    buildBody: (messages, model, systemPrompt) => ({
      model,
      system: systemPrompt,
      messages,
      temperature: 0.7,
      max_tokens: 4096,
    }),
    extractContent: (data) => data.content?.[0]?.text || '',
    getHeaders: (apiKey) => ({
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      // 浏览器直连必须携带此请求头，否则跨域请求会被拒绝
      'anthropic-dangerous-direct-browser-access': 'true',
    }),
  },
};

// ============================================================
// 配置管理（localStorage）
// ============================================================

const XQ_CONFIG_KEY = 'xiaoqi_config';

// 本地（localhost / 127.0.0.1 / file://）走直连；部署到 Netlify 走服务端代理
function xqIsDemoMode() {
  try {
    const host = window.location.hostname;
    if (host === 'localhost' || host === '127.0.0.1' || host === '') return false;
    if (window.location.protocol === 'file:') return false;
    return true;
  } catch (e) {
    return false;
  }
}

function xqGetConfig() {
  try {
    const raw = localStorage.getItem(XQ_CONFIG_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function xqSaveConfig(config) {
  localStorage.setItem(XQ_CONFIG_KEY, JSON.stringify(config));
}

function xqHasConfig() {
  if (xqIsDemoMode()) return true; // 线上模式 Key 在服务端，视为已配置
  const c = xqGetConfig();
  return !!(c && c.apiKey);
}

// 过期模型兜底：本地保存的旧模型名不在列表时回退默认模型
function xqResolveModel(provider, model) {
  if (model && provider.models.some((m) => m.id === model)) return model;
  return provider.defaultModel;
}

// ============================================================
// 线上模式：通过 Netlify Function 代理调用
// ============================================================

const XQ_PROXY_URL = '/.netlify/functions/llm-proxy';

async function xqProxyFetch(payload) {
  let res;
  try {
    res = await fetch(XQ_PROXY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    throw new Error('演示服务暂时不可用，请稍后再试');
  }
  if (!res.ok) {
    let errorMsg = `请求失败 (${res.status})`;
    try {
      const errData = await res.json();
      if (errData.error?.message) errorMsg = errData.error.message;
      else if (errData.error) errorMsg = errData.error;
    } catch (e) {}
    throw new Error(errorMsg);
  }
  return res;
}

async function xqCallDemoAI(messages, systemPrompt, config, options) {
  const provider = XQ_PROVIDERS[config.provider];
  if (!provider) throw new Error(`不支持的服务商: ${config.provider}`);
  const model = xqResolveModel(provider, config.model);
  const res = await xqProxyFetch({
    provider: config.provider,
    model,
    messages,
    systemPrompt,
    options: options || {},
    stream: false,
  });
  const data = await res.json();
  return provider.extractContent(data);
}

async function xqCallDemoAIStream(messages, systemPrompt, config, onChunk) {
  const provider = XQ_PROVIDERS[config.provider];
  if (!provider) throw new Error(`不支持的服务商: ${config.provider}`);
  const model = xqResolveModel(provider, config.model);
  const res = await xqProxyFetch({
    provider: config.provider,
    model,
    messages,
    systemPrompt,
    options: {},
    stream: true,
  });

  // 代理返回 JSON（非流式兜底）时直接提取全文
  const contentType = res.headers.get('Content-Type') || '';
  if (contentType.includes('application/json')) {
    const data = await res.json();
    const text = provider.extractContent(data);
    if (text) onChunk(text);
    return text;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let fullText = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop();
    for (const part of parts) {
      for (const line of part.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') return fullText;
        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta;
          if (delta?.content) {
            fullText += delta.content;
            onChunk(fullText);
          }
        } catch (e) {}
      }
    }
  }
  if (!fullText) throw new Error('演示服务返回为空，请稍后再试');
  return fullText;
}

// ============================================================
// 核心：调用 AI API
// ============================================================

/**
 * 非流式调用
 * @param {Array} messages [{role:'user'|'assistant', content}]
 * @param {string} systemPrompt
 * @param {Object} config {provider, apiKey, model}
 * @param {Object} options {json:true} 要求返回 JSON
 */
async function xqCallAI(messages, systemPrompt, config, options) {
  if (!config) config = xqGetConfig();
  if (!config) throw new Error('请先在 ⚙ 设置中配置 API');
  if (xqIsDemoMode()) return xqCallDemoAI(messages, systemPrompt, config, options);

  const provider = XQ_PROVIDERS[config.provider];
  if (!provider) throw new Error(`不支持的服务商: ${config.provider}`);

  const model = xqResolveModel(provider, config.model);
  const apiKey = config.apiKey;
  if (!apiKey) throw new Error('API Key 为空，请在 ⚙ 设置中填写');

  const headers = provider.getHeaders
    ? provider.getHeaders(apiKey)
    : { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` };

  const body = provider.buildBody(messages, model, systemPrompt, options);

  try {
    const res = await fetch(provider.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errorText = await res.text();
      let errorMsg = `请求失败 (${res.status})`;
      try {
        const errData = JSON.parse(errorText);
        if (errData.error?.message) errorMsg = errData.error.message;
        else if (errData.message) errorMsg = errData.message;
      } catch (e) {}
      if (res.status === 401) errorMsg = 'API Key 无效，请检查是否正确';
      if (res.status === 429) errorMsg = '请求太频繁或额度不足，请稍后再试或检查余额';
      if (res.status === 404) errorMsg = '模型不存在或接口地址错误';
      throw new Error(errorMsg);
    }
    const data = await res.json();
    return provider.extractContent(data);
  } catch (err) {
    if (err.message.includes('Failed to fetch') || err.message.includes('CORS')) {
      throw new Error(
        '网络连接失败或存在 CORS 限制。\n建议使用国内服务商（DeepSeek / 智谱 / 通义千问 / MiniMax），或部署到 Netlify 后使用代理模式。'
      );
    }
    throw err;
  }
}

/**
 * 流式调用（SSE 逐字输出）
 * @returns {Promise<string>} 完整回应
 */
async function xqCallAIStream(messages, systemPrompt, config, onChunk) {
  if (!config) config = xqGetConfig();
  if (!config) throw new Error('请先在 ⚙ 设置中配置 API');
  if (!onChunk || typeof onChunk !== 'function') onChunk = () => {};
  if (xqIsDemoMode()) return xqCallDemoAIStream(messages, systemPrompt, config, onChunk);

  const provider = XQ_PROVIDERS[config.provider];
  if (!provider) throw new Error(`不支持的服务商: ${config.provider}`);

  const model = xqResolveModel(provider, config.model);
  const apiKey = config.apiKey;
  if (!apiKey) throw new Error('API Key 为空，请在 ⚙ 设置中填写');

  const isAnthropic = config.provider === 'anthropic';
  const headers = provider.getHeaders
    ? provider.getHeaders(apiKey)
    : { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` };

  const body = provider.buildBody(messages, model, systemPrompt);
  body.stream = true;

  try {
    const res = await fetch(provider.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errorText = await res.text();
      let errorMsg = `请求失败 (${res.status})`;
      try {
        const errData = JSON.parse(errorText);
        if (errData.error?.message) errorMsg = errData.error.message;
        else if (errData.message) errorMsg = errData.message;
      } catch (e) {}
      if (res.status === 401) errorMsg = 'API Key 无效，请检查是否正确';
      if (res.status === 429) errorMsg = '请求太频繁或额度不足，请稍后再试或检查余额';
      throw new Error(errorMsg);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let fullText = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop();

      for (const part of parts) {
        if (isAnthropic) {
          let eventType = '';
          let eventData = '';
          for (const line of part.split('\n')) {
            if (line.startsWith('event: ')) eventType = line.slice(7).trim();
            else if (line.startsWith('data: ')) eventData = line.slice(6);
          }
          if (!eventData) continue;
          try {
            const parsed = JSON.parse(eventData);
            if (eventType === 'content_block_delta' && parsed.delta?.type === 'text_delta' && parsed.delta?.text) {
              fullText += parsed.delta.text;
              onChunk(fullText);
            }
            if (eventType === 'message_stop') return fullText;
            if (eventType === 'error') throw new Error(parsed.error?.message || 'Claude API error');
          } catch (e) {
            if (e.message && !e.message.includes('JSON')) throw e;
          }
        } else {
          for (const line of part.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6).trim();
            if (data === '[DONE]') return fullText;
            try {
              const parsed = JSON.parse(data);
              const delta = parsed.choices?.[0]?.delta;
              if (delta?.content) {
                fullText += delta.content;
                onChunk(fullText);
              }
            } catch (e) {}
          }
        }
      }
    }
    return fullText;
  } catch (err) {
    if (err.name === 'AbortError') return '';
    if (err.message.includes('Failed to fetch') || err.message.includes('CORS')) {
      throw new Error('网络连接失败或存在 CORS 限制。\n建议使用国内服务商，或部署到 Netlify 后使用代理模式。');
    }
    throw err;
  }
}

async function xqTestAPI(config) {
  try {
    await xqCallAI([{ role: 'user', content: '你好，请回复"OK"' }], '你是一个简洁的助手。', config);
    return { ok: true, message: '配置成功！' };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

window.XQ_API = {
  PROVIDERS: XQ_PROVIDERS,
  isDemoMode: xqIsDemoMode,
  getConfig: xqGetConfig,
  saveConfig: xqSaveConfig,
  hasConfig: xqHasConfig,
  resolveModel: xqResolveModel,
  callAI: xqCallAI,
  callAIStream: xqCallAIStream,
  testAPI: xqTestAPI,
};
