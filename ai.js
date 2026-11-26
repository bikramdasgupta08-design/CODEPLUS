'use strict';

const config = require('./config');
const logger = require('./logger');

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

async function askGemini(text, history) {
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
          systemInstruction: { parts: [{ text: config.systemPrompt }] },
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

async function askOpenAICompatible({ name, apiKey, model, url, text, history }) {
  const messages = [
    { role: 'system', content: config.systemPrompt },
    ...history.map(h => ({ role: h.role, content: h.text })),
    { role: 'user', content: text }
  ];

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model, messages, temperature: 0.7 }),
    signal: AbortSignal.timeout(config.aiRequestTimeoutMs || 10000)
  });

  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.message || `${name} error ${response.status}`);

  const reply = data?.choices?.[0]?.message?.content?.trim();
  if (!reply) throw new Error(`${name} returned an empty reply`);
  return reply;
}

async function askAI(jid, text) {
  const history = getHistory(jid);
  const providers = [];

  if (config.geminiApiKey) {
    providers.push({ name: 'Gemini', run: () => askGemini(text, history) });
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
        history
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
        history
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
        history
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
      history
    })
  });

  if (!providers.length) {
    throw new Error('No AI provider configured. Add GEMINI_API_KEY to .env.');
  }

  let lastError;
  for (const provider of providers) {
    try {
      const reply = await provider.run();
      history.push({ role: 'user', text }, { role: 'assistant', text: reply });
      trimHistory(history);
      logger.debug('AI_PROVIDER', { jid, provider: provider.name });
      return reply;
    } catch (error) {
      lastError = error;
      logger.warn(`${provider.name} failed:`, error.message);
    }
  }

  throw lastError || new Error('All AI providers failed');
}

module.exports = { askAI, askGemini, resetHistory, getHistory };
