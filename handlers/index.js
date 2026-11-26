'use strict';

const send = (sock, jid, text) => sock.sendMessage(jid, { text });
const { resetHistory, askOnce } = require('../ai');
const { generateImage } = require('../image');
const logger = require('../logger');
const { status: spamStatus } = require('./spam');
const { list: autoReplyList } = require('./autoreply');
const {
  enable,
  disable,
  status: chatStatus,
  isChatEnabled
} = require('./chatstate');

const handlers = {
  enable,
  disable,
  status: chatStatus,

  ping: async ({ sock, jid }) => send(sock, jid, 'pong 🏓'),

  id: async ({ sock, jid }) => send(sock, jid, `Chat ID: ${jid}`),

  echo: async ({ sock, jid, args }) => {
    const text = args.join(' ').trim();
    await send(sock, jid, text ? text : 'Usage: !echo <text>');
  },

  time: async ({ sock, jid }) => send(sock, jid, new Date().toLocaleString()),

  img: async ({ sock, jid, args }) => {
    const prompt = args.join(' ').trim();
    if (!prompt) {
      await send(sock, jid, 'Usage: !img <image description>');
      return;
    }

    await send(sock, jid, '🎨 Generating image, please wait...');
    try {
      const { buffer, source } = await generateImage(prompt);
      await sock.sendMessage(jid, { image: buffer, caption: `🖼️ ${prompt}` });
      logger.debug('IMAGE_OK', { prompt, source });
    } catch (error) {
      logger.warn('IMAGE_FAILED', { prompt, error: error.message });
      await send(sock, jid, `Image generation failed: ${error.message}`);
    }
  },

  improve: async ({ sock, jid, args }) => {
    const text = args.join(' ').trim();
    if (!text) {
      await send(sock, jid, 'Usage: !improve <text>');
      return;
    }

    try {
      const improved = await askOnce(
        [
          'Rewrite the text below to be clearer, smoother and more polished.',
          'Keep the same meaning and the same language.',
          'Return only the improved text, with no explanation, quotes or labels.',
          '',
          text
        ].join('\n'),
        'You are a skilled editor. Reply with only the improved version of the text.'
      );
      await send(sock, jid, `✨ ${improved}`);
    } catch (error) {
      logger.warn('IMPROVE_FAILED', { error: error.message });
      await send(sock, jid, 'Could not improve that right now. Please try again.');
    }
  },

  ai: async ({ sock, jid, config }) => {
    const enabled = [
      config.geminiApiKey && 'Gemini',
      config.groqApiKey && 'Groq',
      config.openrouterApiKey && 'OpenRouter',
      config.openaiApiKey && 'OpenAI',
      'Pollinations (keyless)'
    ].filter(Boolean);

    await send(sock, jid, [
      `CODEPLUS in this chat: ${isChatEnabled(jid, config) ? 'ENABLED' : 'DISABLED'}.`,
      'CODEPLUS multi-AI is ready.',
      '• Normal messages get AI replies — no prefix needed.',
      `• Providers (in order): ${enabled.join(' > ') || 'none configured'}`,
      `• Gemini models: ${[config.aiModel, ...config.aiFallbackModels].join(', ')}`,
      `• Images: Gemini > Pollinations (keyless)`,
      `• Memory: last ${config.aiHistoryLength} messages per chat`,
      `• Spam guard: ${spamStatus().enabled ? 'on' : 'off'}`,
      `• Auto-reply rules: ${autoReplyList().length}`,
      `• Groups: ${config.aiReplyInGroups ? 'on' : 'off'}`
    ].join('\n'));
  },

  aireset: async ({ sock, jid }) => {
    resetHistory(jid);
    await send(sock, jid, 'CODEPLUS memory cleared for this chat.');
  },

  help: async ({ sock, jid, config }) => send(sock, jid, [
    'CODEPLUS — commands:',
    `• This chat: ${isChatEnabled(jid, config) ? 'ENABLED' : 'DISABLED'} (send !enable here)`,
    '• !enable — Enable CODEPLUS in THIS chat only (owner only)',
    '• !disable — Pause CODEPLUS in THIS chat only (owner only)',
    '• !status — Show this chat\'s switch status (owner only)',
    '• (no prefix) — Chat with AI normally',
    '• !ping — Reply with pong',
    '• !id — Show the current chat ID',
    '• !echo <text> — Echo text back',
    '• !time — Show the current date and time',
    '• !img <prompt> — Generate an image (Gemini, then keyless fallback)',
    '• !improve <text> — Rewrite text more clearly',
    '• !away [off|message] — Set or clear away auto-reply (owner only)',
    '• !spam [status|on|off|unblock] — Spam control (owner only)',
    '• !autoreply [add|remove|list|on|off] — Keyword auto-replies (owner only)',
    '• !ai — Show CODEPLUS AI status',
    '• !aireset — Clear AI memory for this chat',
    '• !help — Show this list'
  ].join('\n')),

  away: require('./away').away,
  spam: require('./spam').spam,
  autoreply: require('./autoreply').autoreply
};

module.exports = handlers;
