'use strict';

const config = require('./config');

const histories = new Map();

function getHistory(jid) {
  if (!histories.has(jid)) histories.set(jid, []);
  return histories.get(jid);
}

function resetHistory(jid) {
  histories.set(jid, []);
}

async function askGemini(jid, text) {
  const history = getHistory(jid);
  const contents = [
    ...history,
    { role: 'user', parts: [{ text }] }
  ];

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.model}:generateContent?key=${config.apiKey}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: config.systemPrompt }] },
      contents
    })
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data?.error?.message || `Gemini API error ${response.status}`);
  }

  const reply = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('').trim();
  if (!reply) throw new Error('Gemini returned an empty reply');

  history.push({ role: 'user', parts: [{ text }] });
  history.push({ role: 'model', parts: [{ text: reply }] });

  while (history.length > config.historyLength * 2) history.shift();

  return reply;
}

module.exports = { askGemini, resetHistory, getHistory };
