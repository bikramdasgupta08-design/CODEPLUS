'use strict';

const { askOnce, getHistory } = require('../ai');
const logger = require('../logger');

const send = (sock, jid, text) => sock.sendMessage(jid, { text });

async function summarize({ sock, jid, args }) {
  const history = getHistory(jid);
  if (!history.length) {
    await send(sock, jid, 'No chat history to summarize yet.');
    return;
  }

  const count = Math.min(Math.max(Number(args[0]) || 20, 2), 60);
  const recent = history.slice(-count * 2);
  const transcript = recent.map(item => `${item.role === 'assistant' ? 'CODEPLUS' : 'User'}: ${item.text}`).join('\n');

  try {
    const summary = await askOnce(
      `Summarize this chat conversation in clear, short bullet points. Include decisions, facts and open questions. Do not invent anything.\n\n${transcript}`,
      'You are a precise summarizer. Reply with only the summary.'
    );
    await send(sock, jid, `📝 Summary of the last ${recent.length} messages:\n\n${summary}`);
  } catch (error) {
    logger.warn('SUMMARIZE_FAILED', { error: error.message });
    await send(sock, jid, 'Could not summarize right now. Please try again.');
  }
}

async function translate({ sock, jid, args }) {
  const raw = args.join(' ').trim();
  const match = raw.match(/^([^\s]+)\s+([\s\S]+)$/);
  if (!match) {
    await send(sock, jid, 'Usage: !translate <language> <text>\nExample: !translate Hindi Good morning, how are you?');
    return;
  }

  const [, language, text] = match;
  try {
    const result = await askOnce(
      `Translate the following text into ${language}. Return only the translation, with no explanation or quotes.\n\n${text}`,
      'You are an accurate translator. Preserve tone and meaning.'
    );
    await send(sock, jid, `🌐 ${language}:\n${result}`);
  } catch (error) {
    logger.warn('TRANSLATE_FAILED', { error: error.message });
    await send(sock, jid, 'Could not translate right now. Please try again.');
  }
}

module.exports = { summarize, translate };
