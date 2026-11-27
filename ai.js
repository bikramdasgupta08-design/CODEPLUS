'use strict';

const config = require('./config');
const logger = require('./logger');
const { buildContext, istNow } = require('./web');

const histories = new Map();

function getHistory(jid) {
  if (!histories.has(jid)) histories.set(jid, []);
  return histories.get(jid);
}

function resetHistory(jid) {
  histories.set(jid, []);
}

function trimHistory(history) {
  while (history.length > config.aiHistoryLength * 2) history.shift();
}

async function askGemini(text, history, systemPrompt) {
  const models = [config.aiModel, ...config.aiFallbackModels.filter(m => m !== config.aiModel)];
  const contents = [
    ...history.map(h => ({
      role: h.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: h.text }]
    })),
    { role: 'user', parts: [{ text }] }
  ];
  let lastError;

  for (const model of models) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${config.geminiApiKey}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents
        }),
        signal: AbortSignal.timeout(config.aiRequestTimeoutMs || 10000)
      });
      const data = await response.json();

      if (!response.ok) throw new Error(data?.error?.message || `Gemini error ${response.status}`);

      const reply = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('').trim();
      if (!reply) throw new Error('Gemini returned an empty reply');
      return reply;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error('No Gemini model available');
}

async function askOpenAICompatible({ name, apiKey, model, url, text, history, systemPrompt, retryOnRateLimit = false }) {
  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.map(h => ({ role: h.role, content: h.text })),
    { role: 'user', content: text }
  ];

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  for (let attempt = 0; attempt <= (retryOnRateLimit ? 2 : 0); attempt++) {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, messages, temperature: 0.7 }),
      signal: AbortSignal.timeout(config.aiRequestTimeoutMs || 10000)
    });

    const raw = await response.text();
    let data;
    try { data = JSON.parse(raw); } catch (_) { data = null; }

    if (!response.ok) {
      const message = data?.error?.message || data?.message || raw.slice(0, 120) || `${name} error ${response.status}`;
      // Pollinations' keyless tier allows about one reply every 45 seconds.
      if (retryOnRateLimit && [402, 429].includes(response.status) && attempt < 2) {
        const match = String(message).match(/Retry after (\d+)s/i);
        const delay = Math.min(match ? Number(match[1]) + 1 : 10, 20);
        await new Promise(resolve => setTimeout(resolve, delay * 1000));
        continue;
      }
      throw new Error(message);
    }

    const reply = data?.choices?.[0]?.message?.content?.trim();
    if (!reply) throw new Error(`${name} returned an empty reply`);
    return reply;
  }

  throw new Error(`${name} rate limit persisted`);
}

function buildProviders(text, history, systemPrompt) {
  const providers = [];

  if (config.geminiApiKey) {
    providers.push({
      name: 'Gemini',
      run: () => askGemini(text, history, systemPrompt)
    });
  }
  if (config.groqApiKey) {
    providers.push({
      name: 'Groq',
      run: () => askOpenAICompatible({
        name: 'Groq',
        apiKey: config.groqApiKey,
        model: config.groqModel,
        url: 'https://api.groq.com/openai/v1/chat/completions',
        text,
        history,
        systemPrompt
      })
    });
  }
  if (config.openrouterApiKey) {
    providers.push({
      name: 'OpenRouter',
      run: () => askOpenAICompatible({
        name: 'OpenRouter',
        apiKey: config.openrouterApiKey,
        model: config.openrouterModel,
        url: 'https://openrouter.ai/api/v1/chat/completions',
        text,
        history,
        systemPrompt
      })
    });
  }
  if (config.openaiApiKey) {
    providers.push({
      name: 'OpenAI',
      run: () => askOpenAICompatible({
        name: 'OpenAI',
        apiKey: config.openaiApiKey,
        model: config.openaiModel,
        url: 'https://api.openai.com/v1/chat/completions',
        text,
        history,
        systemPrompt
      })
    });
  }

  // Keyless last resort: Pollinations free text API (OpenAI-compatible).
  providers.push({
    name: 'Pollinations',
    run: () => askOpenAICompatible({
      name: 'Pollinations',
      model: 'openai',
      url: 'https://text.pollinations.ai/openai',
      text,
      history,
      systemPrompt,
      retryOnRateLimit: true
    })
  });

  return providers;
}

async function runProviders(text, history, systemPrompt) {
  const providers = buildProviders(text, history, systemPrompt);
  let lastError;

  for (const provider of providers) {
    try {
      const reply = await provider.run();
      logger.debug('AI_PROVIDER', { provider: provider.name });
      return { text: reply, provider: provider.name };
    } catch (error) {
      lastError = error;
      logger.warn(`${provider.name} failed:`, error.message);
    }
  }

  throw lastError || new Error('All AI providers failed');
}

// Main conversation path: keeps per-chat history and adds fresh web context.
async function askAI(jid, text, extraPrompt = '') {
  const history = getHistory(jid);
  const context = await buildContext(text);
  const systemPrompt = [
    config.systemPrompt,
    `Current date and time in India (IST): ${istNow()}. Use this for any date or time question.`,
    extraPrompt,
    context
      ? 'Latest information fetched from the web (use it when relevant; prefer it over older training data):\n' + context
      : ''
  ].filter(Boolean).join('\n\n');

  const result = await runProviders(text, history, systemPrompt);
  history.push({ role: 'user', text }, { role: 'assistant', text: result.text });
  trimHistory(history);
  return result.text;
}

// One-shot request (e.g. !improve). Does not touch conversation history.
async function askOnce(text, systemPrompt) {
  const result = await runProviders(text, [], systemPrompt || config.systemPrompt);
  return result.text;
}

module.exports = { askAI, askOnce, askGemini, resetHistory, getHistory };
