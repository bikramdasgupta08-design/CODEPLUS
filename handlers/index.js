'use strict';

const send = (sock, jid, text) => sock.sendMessage(jid, { text });
const { resetHistory } = require('../ai');

const handlers = {
  ping: async ({ sock, jid }) => send(sock, jid, 'pong 🏓'),

  id: async ({ sock, jid }) => send(sock, jid, `Chat ID: ${jid}`),

  echo: async ({ sock, jid, args }) => {
    const text = args.join(' ').trim();
    await send(sock, jid, text ? text : 'Usage: !echo <text>');
  },

  time: async ({ sock, jid }) => send(sock, jid, new Date().toLocaleString()),

  ai: async ({ sock, jid, config }) => send(sock, jid, [
    'CODEPLUS AI is ACTIVE.',
    '• Normal messages get AI replies — no prefix needed.',
    `• Model: ${config.aiModel}`,
    `• Fallbacks: ${config.aiFallbackModels.join(', ')}`,
    `• Memory: last ${config.aiHistoryLength} messages per chat`,
    `• Groups: ${config.aiReplyInGroups ? 'on' : 'off'}`
  ].join('\n')),

  aireset: async ({ sock, jid }) => {
    resetHistory(jid);
    await send(sock, jid, 'CODEPLUS memory cleared for this chat.');
  },

  help: async ({ sock, jid }) => send(sock, jid, [
    'CODEPLUS — commands:',
    '• (no prefix) — Chat with AI normally',
    '• !ping — Reply with pong',
    '• !id — Show the current chat ID',
    '• !echo <text> — Echo text back',
    '• !time — Show the current date and time',
    '• !away [off|message] — Set or clear away auto-reply (owner only)',
    '• !ai — Show CODEPLUS AI status',
    '• !aireset — Clear AI memory for this chat',
    '• !help — Show this list'
  ].join('\n')),

  away: require('./away').away
};

module.exports = handlers;
