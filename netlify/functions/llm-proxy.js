// ============================================================
// 小栖 API Demo · Netlify Function 代理
// ============================================================
// 作用：部署到 Netlify 后，前端通过 /.netlify/functions/llm-proxy 调用，
// API Key 保留在服务端环境变量中，不暴露给浏览器。
//
// 环境变量（在 Netlify Site settings → Environment variables 设置）：
//   DEEPSEEK_API_KEY  / MINIMAX_API_KEY  / OPENAI_API_KEY
//   ZHIPU_API_KEY     / QWEN_API_KEY     / ANTHROPIC_API_KEY
//   （或统一设置 LLM_API_KEY 作为兜底）
//
// 支持流式（stream:true 时直接透传 SSE 响应体）。
// ============================================================

const PROVIDERS = {
  deepseek: {
    endpoint: 'https://api.deepseek.com/v1/chat/completions',
    buildBody: (messages, model, systemPrompt, options) => {
      const body = {
        model,
        messages: [{ role: 'system', content: systemPrompt }, ...messages],
        temperature: 0.7,
        max_tokens: 4096,
        thinking: { type: 'disabled' },
      };
      if (options?.json) body.response_format = { type: 'json_object' };
      return body;
    },
  },
  minimax: {
    endpoint: 'https://api.minimaxi.com/v1/chat/completions',
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
  },
  openai: {
    endpoint: 'https://api.openai.com/v1/chat/completions',
    buildBody: (messages, model, systemPrompt, options) => {
      const body = {
        model,
        messages: [{ role: 'system', content: systemPrompt }, ...messages],
        reasoning_effort: 'minimal',
        max_tokens: 4096,
      };
      if (options?.json) body.response_format = { type: 'json_object' };
      return body;
    },
  },
  zhipu: {
    endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
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
  },
  qwen: {
    endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    buildBody: (messages, model, systemPrompt, options) => {
      const body = {
        model,
        messages: [{ role: 'system', content: systemPrompt }, ...messages],
        temperature: 0.7,
        max_tokens: 4096,
      };
      if (/^(qwen3|qwq)/i.test(model)) body.enable_thinking = false;
      if (options?.json) body.response_format = { type: 'json_object' };
      return body;
    },
  },
  anthropic: {
    endpoint: 'https://api.anthropic.com/v1/messages',
    buildBody: (messages, model, systemPrompt) => ({
      model,
      system: systemPrompt,
      messages,
      temperature: 0.7,
      max_tokens: 4096,
    }),
  },
};

function getApiKey(providerId) {
  const perProvider = process.env[`${providerId.toUpperCase()}_API_KEY`];
  if (perProvider) return perProvider;
  return process.env.LLM_API_KEY || '';
}

function jsonRes(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export default async (req) => {
  if (req.method !== 'POST') return jsonRes({ error: '仅支持 POST' }, 405);

  let payload;
  try {
    payload = await req.json();
  } catch (e) {
    return jsonRes({ error: '请求体不是合法 JSON' }, 400);
  }

  const { provider: providerId, model, messages, systemPrompt, options, stream } = payload;
  const provider = PROVIDERS[providerId];
  if (!provider) return jsonRes({ error: `不支持的服务商: ${providerId}` }, 400);
  if (!Array.isArray(messages) || messages.length === 0) return jsonRes({ error: 'messages 不能为空' }, 400);

  const apiKey = getApiKey(providerId);
  if (!apiKey) {
    return jsonRes(
      { error: '服务端未配置 API Key。请在 Netlify 环境变量中设置对应服务商的 KEY（如 DEEPSEEK_API_KEY）后重新部署。' },
      500
    );
  }

  const headers = providerId === 'anthropic'
    ? {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      }
    : {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      };

  const body = provider.buildBody(messages, model || '', systemPrompt || '你是小栖。', options);
  if (stream) body.stream = true;

  let upstream;
  try {
    upstream = await fetch(provider.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  } catch (e) {
    return jsonRes({ error: '上游服务连接失败，请稍后再试' }, 502);
  }

  if (!upstream.ok) {
    const errText = await upstream.text();
    let msg = `上游服务错误 (${upstream.status})`;
    try {
      const parsed = JSON.parse(errText);
      msg = parsed.error?.message || parsed.message || msg;
    } catch (e) {}
    if (upstream.status === 401) msg = '服务端 API Key 无效，请检查 Netlify 环境变量';
    if (upstream.status === 429) msg = '请求太频繁或额度不足';
    return jsonRes({ error: msg }, upstream.status);
  }

  // 流式：直接透传 SSE 响应体（Netlify Functions v2 支持流式 Response）
  if (stream && upstream.body) {
    return new Response(upstream.body, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
      },
    });
  }

  const data = await upstream.json();
  return jsonRes(data);
};
