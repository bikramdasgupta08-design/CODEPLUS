'use strict';

require('dotenv').config();

module.exports = {
  botName: 'CODEPLUS',

  // Login/session folder for this bot (independent of your other bot).
  authDir: './auth_info',

  // Normal chat needs NO prefix. Prefix is only for owner admin commands.
  prefix: '!',

  // Gemini model. Override with GEMINI_MODEL in .env if needed.
  model: process.env.GEMINI_MODEL || 'gemini-3.8-flash',

  // Tried in order if the primary model is unavailable or overloaded.
  fallbackModels: ['gemini-flash-lite-latest', 'gemini-3.5-flash'],

  // Abort a slow model quickly so fallback can take over.
  requestTimeoutMs: 10000,

  apiKey: process.env.GEMINI_API_KEY || '',

  // Reply to messages in groups as well as private chats.
  replyInGroups: false,

  // Number of past messages kept per chat for context.
  historyLength: 20,

  // Only these JIDs may use prefix commands. Leave empty to allow everyone.
  // Add the JID/LID of the number that will own CODEPLUS.
  ownerJids: (process.env.OWNER_JIDS || '').split(',').map(s => s.trim()).filter(Boolean),

  systemPrompt: [
    'You are CODEPLUS, a helpful, friendly AI assistant on WhatsApp.',
    'Keep replies clear, concise and natural for chat.',
    'Use plain text; avoid markdown formatting unless the user asks.',
    'If you do not know something, say so honestly.'
  ].join(' ')
};
