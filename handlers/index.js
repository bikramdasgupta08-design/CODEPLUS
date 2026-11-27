'use strict';

const send = (sock, jid, text) => sock.sendMessage(jid, { text });
const SINGLE_SELECT = 1;
const { resetHistory, askOnce } = require('../ai');
const { generateImage } = require('../image');
const { rembgAvailable } = require('../media');
const { istNow } = require('../web');
const logger = require('../logger');
const { status: spamStatus } = require('./spam');
const { list: autoReplyList } = require('./autoreply');
const media = require('./media');
const { aiutils } = require('./extra');
const { callerid, isEnabled: callerIdOn } = require('../callerid');
const { safe } = require('../safechat');
const { guard } = require('../groupguard');
const {
  enable,
  disable,
  status: chatStatus,
  isChatEnabled
} = require('./chatstate');

// Row ids are sent back as `!command` when tapped, so every menu item runs
// exactly the same handler as its typed `!` equivalent.
const COMMAND_MENU_SECTIONS = [
  {
    title: 'Quick',
    rows: [
      ['ping', 'Instant pong reply'],
      ['time', 'Current IST time'],
      ['id', 'Show this chat ID'],
      ['echo', 'Echo text back'],
      ['status', 'Chat switch status'],
      ['help', 'Full text command list']
    ]
  },
  {
    title: 'AI tools',
    rows: [
      ['ai', 'AI providers and status'],
      ['aireset', 'Clear this chat memory'],
      ['improve', 'Rewrite text clearly'],
      ['summarize', 'Summarize recent chat'],
      ['translate', 'Translate text'],
      ['img', 'Generate an image']
    ]
  },
  {
    title: 'Images',
    rows: [
      ['pdf', 'Image to PDF'],
      ['png', 'Image to PNG'],
      ['nobg', 'Remove background'],
      ['removebg', 'Remove background'],
      ['describe', 'AI image description'],
      ['caption', 'AI image caption']
    ]
  },
  {
    title: 'Safety',
    rows: [
      ['callerid', 'Caller ID mode'],
      ['safe', 'Scam / unsafe checks'],
      ['guard', 'Group protection']
    ]
  },
  {
    title: 'Controls',
    rows: [
      ['enable', 'Enable in this chat'],
      ['disable', 'Pause this chat'],
      ['away', 'Away auto-reply'],
      ['spam', 'Spam control'],
      ['autoreply', 'Keyword auto-replies']
    ]
  }
];

const handlers = {
  enable,
  disable,
  status: chatStatus,

  ping: async ({ sock, jid }) => send(sock, jid, 'pong 🏓'),

  // WhatsApp's selectable list window. Opening it is instant (no AI/web call).
  menu: async ({ sock, jid, config }) => {
    const sections = COMMAND_MENU_SECTIONS.map(section => ({
      title: section.title,
      rows: section.rows.map(([command, description]) => ({
        title: `/${command}`,
        description,
        rowId: `run:${command}`
      }))
    }));

    try {
      await sock.sendMessage(jid, {
        listMessage: {
          title: 'CODEPLUS commands',
          description: 'Tap a command to run it instantly.',
          buttonText: 'Select command',
          footerText: `Both ! and / work • ${isChatEnabled(jid, config) ? 'ON' : 'PAUSED'}`,
          listType: SINGLE_SELECT,
          sections
        }
      });
    } catch (error) {
      logger.warn('COMMAND_MENU_FAILED', error.message);
      await send(sock, jid, 'Command menu is not supported here. Send /help or !help for the full text list.');
    }
  },

  id: async ({ sock, jid }) => send(sock, jid, `Chat ID: ${jid}`),

  echo: async ({ sock, jid, args }) => {
    const text = args.join(' ').trim();
    await send(sock, jid, text ? text : 'Usage: !echo <text>');
  },

  time: async ({ sock, jid }) => send(sock, jid, `🕐 ${istNow()}`),

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

  summarize: aiutils.summarize,
  translate: aiutils.translate,

  pdf: media.pdf,
  png: media.png,
  nobg: media.nobg,
  removebg: media.removebg,
  describe: media.describe,
  caption: media.caption,

  callerid,
  safe,
  guard,

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
      `• Image generation: Gemini > Pollinations (keyless)`,
      `• Image tools: PDF, PNG, background removal (${rembgAvailable() ? 'AI cutout' : 'offline fill'}), AI captions`,
      `• Image understanding: Gemini vision`,
      `• Caller ID mode: ${callerIdOn() ? 'on' : 'off'}`,
      `• Web lookup: ${config.webSearchEnabled ? 'on (Wikipedia + Google News)' : 'off'}`,
      `• Time zone: ${config.timeZone} (IST)`,
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
    '• Send / to open the tap-to-select command window',
    '• /help opens that window; !help shows this text list',
    '• Every command works with either ! or /',
    '',
    'SWITCH (owner only):',
    '• !enable — enable CODEPLUS in THIS chat only',
    '• !disable — pause CODEPLUS in THIS chat only',
    '• !status — show this chat\'s state',
    '',
    'AI:',
    '• (no prefix) — chat with AI using fresh web data',
    '• !ai — AI providers, models and features',
    '• !aireset — clear this chat\'s AI memory',
    '• !improve <text> — rewrite text more clearly',
    '• !summarize [count] — summarize recent chat',
    '• !translate <language> <text> — translate text',
    '• !img <prompt> — generate an image',
    '',
    'IMAGE TOOLS (send an image with the command as caption, or reply to an image):',
    '• !pdf — image to PDF',
    '• !png — image to PNG',
    '• !nobg — remove background',
    '• !describe [question] — AI description of an image',
    '• !caption — AI-generated social caption',
    '• You can also caption an image with: "make pdf", "make png",',
    '  "remove background", "caption" or "describe".',
    '',
    'SAFETY & UTILITIES (owner only):',
    '• !callerid on|off|status|lookup <number>|save <number> | <name> | <tag>',
    '• !safe on|off|check <text> — scam / unsafe content checks',
    '• !guard on|off|snapshot|antiprune on|off|antinuke on|off — group protection',
    '• !away [off|message] — away auto-reply',
    '• !spam [status|on|off|unblock] — spam control',
    '• !autoreply [add|remove|list|on|off] — keyword auto-replies',
    '',
    'BASIC:',
    '• !ping — pong 🏓',
    '• !id — current chat ID',
    '• !echo <text> — echo text',
    '• !time — current IST date and time',
    '• !menu — tap-to-select command window',
    '• !help — this list'
  ].join('\n')),

  away: require('./away').away,
  spam: require('./spam').spam,
  autoreply: require('./autoreply').autoreply
};

module.exports = handlers;
