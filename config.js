'use strict';

require('dotenv').config();

module.exports = {
  // Character that marks a message as a command.
  prefix: '!',

  // Folder where the WhatsApp login is stored. Keep it private.
  authDir: './auth_info',

  // Render-only mode: no QR is printed or saved unless FORCE_QR=true is set
  // deliberately. A missing session is restored from the Render Secret File.
  forceQr: String(process.env.FORCE_QR || '').toLowerCase() === 'true',

  // Pairing mode is opt-in too. Set USE_PAIRING_CODE=true only when you
  // intentionally want a fresh 8-character link code.
  usePairingCode: String(process.env.USE_PAIRING_CODE || '').toLowerCase() === 'true',
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
  // Best-quality first. Gemini 4 Hydrogen is currently the strongest model
  // available on this key; the rest are tried if it is rate-limited/full.
  aiModel: process.env.GEMINI_MODEL || 'gemini-4-hydrogen',
  aiFallbackModels: [
    'gemini-3.8-flash',
    'gemini-3.7-flash',
    'gemini-3.6-flash',
    'gemini-3.5-flash',
    'gemini-3.1-pro-preview',
    'gemini-flash-latest',
    'gemini-flash-lite-latest'
  ],
  aiHistoryLength: 20,
  aiReplyInGroups: true,
  aiRequestTimeoutMs: 10000,

  // Time shown by !time and injected into AI prompts (Indian Standard Time).
  timeZone: 'Asia/Kolkata',

  // Fresh web context (Wikipedia + Google News) for AI replies.
  webSearchEnabled: true,
  webContextTimeoutMs: 6000,
  webCacheMs: 10 * 60 * 1000,
  webMaxChars: 1400,

  // Extra AI providers. Add any key you have; they are tried in order after
  // Gemini. All use the OpenAI-compatible chat-completions format.
  groqApiKey: process.env.GROQ_API_KEY || '',
  groqModel: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
  openrouterApiKey: process.env.OPENROUTER_API_KEY || '',
  openrouterModel: process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.3-70b-instruct:free',
  openaiApiKey: process.env.OPENAI_API_KEY || '',
  openaiModel: process.env.OPENAI_MODEL || 'gpt-4o-mini',

  // --- Image generation (Gemini first, keyless Pollinations fallback) ---
  imageModels: ['gemini-2.5-flash-image', 'gemini-3.1-flash-image'],
  imageFallbackUrl: 'https://image.pollinations.ai/prompt/',
  imageTimeoutMs: 60000,
  imagePrompt: 'Generate a clear, high-quality image of: ',

  // --- Spam control ---
  spamEnabled: true,
  spamWindowMs: 10000,
  spamMaxMessages: 8,
  spamBlockDurationMs: 10 * 60 * 1000,
  spamAutoBlock: true,

  // --- Group protection ---
  // Anti-prune restores members when this many are removed at once.
  antiPruneThreshold: 2,

  // --- Keyword auto-replies (owner managed) ---
  autoReplyFile: './autoreply.json',

  // --- Master on/off switch (owner managed) ---
  // CODEPLUS stays silent in every chat and group until !enable is sent.
  botStateFile: './bot-state.json',

  systemPrompt: [
    'You are CODEPLUS, a highly capable AI assistant on WhatsApp. Your goal is to be genuinely useful and accurate.',
    'Think carefully before answering. For reasoning, coding, study or planning tasks, work through the problem internally and give the correct, complete answer with practical steps.',
    'Use any "Latest information fetched from the web" provided to you when it is relevant; prefer it over older training data, and mention when information may be time-sensitive.',
    'If you are unsure, do not guess — say what is known, what is uncertain, and what the user should check.',
    'Never claim you took an action you did not actually take.',
    'Keep replies clear, concise and natural for chat. Use plain text and short numbered lists when helpful; avoid heavy markdown unless asked.'
  ].join(' ')
};
