'use strict';

require('dotenv').config();

module.exports = {
  // Character that marks a message as a command.
  prefix: '!',

  // Folder where the WhatsApp login is stored. Keep it private.
  authDir: './auth_info',

  // Use WhatsApp's 8-character pairing code instead of a QR code.
  // Digits only, with country code. Set PHONE_NUMBER in .env to override.
  phoneNumber: process.env.PHONE_NUMBER || '919073846974',

  // Only these JIDs may use admin commands (e.g. !away).
  // Official owner number: +91 90738 46974 -> '919073846974@s.whatsapp.net'.
  ownerJids: [
    '919073846974@s.whatsapp.net',
    // WhatsApp's private LID alias for the same account (seen in message events).
    '9239128965203@lid'
  ],

  // How long to wait before replying again to the same person in away mode.
  awayCooldownMs: 60 * 1000,

  defaultAwayMessage: 'I am away right now. I will get back to you soon.',

  // --- CODEPLUS AI (no prefix needed for normal chat) ---
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  aiModel: process.env.GEMINI_MODEL || 'gemini-3.8-flash',
  aiFallbackModels: ['gemini-flash-lite-latest', 'gemini-3.5-flash'],
  aiHistoryLength: 20,
  aiReplyInGroups: false,
  aiRequestTimeoutMs: 10000,

  // Extra AI providers. Add any key you have; they are tried in order after
  // Gemini. All use the OpenAI-compatible chat-completions format.
  groqApiKey: process.env.GROQ_API_KEY || '',
  groqModel: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
  openrouterApiKey: process.env.OPENROUTER_API_KEY || '',
  openrouterModel: process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.3-70b-instruct:free',
  openaiApiKey: process.env.OPENAI_API_KEY || '',
  openaiModel: process.env.OPENAI_MODEL || 'gpt-4o-mini',

  systemPrompt: [
    'You are CODEPLUS, a helpful, friendly AI assistant on WhatsApp.',
    'Keep replies clear, concise and natural for chat.',
    'Use plain text; avoid markdown formatting unless the user asks.',
    'If you do not know something, say so honestly.'
  ].join(' ')
};
