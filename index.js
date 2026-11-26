'use strict';

const pino = require('pino');
const qrcode = require('qrcode-terminal');
const config = require('./config');
const { askGemini, resetHistory } = require('./ai');
const logger = require('./logger');

let reconnecting = false;
let baileys;

async function loadBaileys() {
  if (!baileys) baileys = await import('@whiskeysockets/baileys');
  return baileys;
}

function digits(jid) {
  return (jid || '').split('@')[0].replace(/\D/g, '');
}

function isOwner(jid) {
  if (!config.ownerJids.length) return true;
  const sender = digits(jid);
  return config.ownerJids.some(owner => digits(owner) === sender);
}

async function start() {
  const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion
  } = await loadBaileys();

  const { state, saveCreds } = await useMultiFileAuthState(config.authDir);

  let version;
  try {
    ({ version } = await fetchLatestBaileysVersion());
  } catch (error) {
    logger.warn('Could not fetch Baileys version, using default:', error.message);
  }

  const sock = makeWASocket({
    version,
    auth: state,
    browser: [config.botName, 'Chrome', '1.0.0'],
    printQRInTerminal: false,
    logger: pino({ level: 'warn' }),
    shouldSyncHistoryMessage: ({ syncType }) => syncType !== 2
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      logger.info(`Scan this QR to link ${config.botName}`);
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const status = lastDisconnect?.error?.output?.statusCode;
      if (status === DisconnectReason.loggedOut) {
        logger.warn('Logged out. Delete auth_info/ and restart to pair again.');
      } else if (!reconnecting) {
        reconnecting = true;
        logger.warn('Connection closed, reconnecting...');
        await new Promise(resolve => setTimeout(resolve, 3000));
        await start();
      }
      return;
    }

    if (connection === 'open') {
      reconnecting = false;
      logger.info(`${config.botName} is ready as ${sock.user?.name || 'WhatsApp'}`);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages || []) {
      try {
        await handleMessage(sock, msg);
      } catch (error) {
        logger.error('Failed to handle message:', error);
      }
    }
  });

  sock.ev.on('error', error => logger.error('Socket error:', error));
}

async function handleMessage(sock, msg) {
  if (!msg.message || msg.key.fromMe) return;

  const jid = msg.key.senderPn || msg.key.participantPn || msg.key.remoteJid;
  if (!jid || jid === 'status@broadcast') return;

  if (jid.endsWith('@g.us') && !config.replyInGroups) return;

  const body = (
    msg.message.conversation ||
    msg.message.extendedTextMessage?.text ||
    msg.message.imageMessage?.caption ||
    msg.message.videoMessage?.caption ||
    ''
  ).trim();

  if (!body) return;

  logger.debug('INCOMING', { jid, body });

  if (body.startsWith(config.prefix)) {
    await handleCommand(sock, jid, body);
    return;
  }

  const reply = await askGemini(jid, body);
  await sock.sendMessage(jid, { text: reply });
  logger.debug('REPLY', { jid, reply });
}

async function handleCommand(sock, jid, body) {
  const [rawCommand, ...args] = body.slice(config.prefix.length).trim().split(/\s+/);
  const command = rawCommand.toLowerCase();

  if (command === 'help') {
    await sock.sendMessage(jid, {
      text: [
        `${config.botName} commands (owner only):`,
        `• ${config.prefix}help — Show this list`,
        `• ${config.prefix}reset — Clear this chat's memory`,
        `• ${config.prefix}prompt <text> — Change the system prompt`,
        `• ${config.prefix}status — Show current settings`
      ].join('\n')
    });
    return;
  }

  if (!isOwner(jid)) {
    await sock.sendMessage(jid, { text: 'That command is only available to the owner.' });
    return;
  }

  if (command === 'reset') {
    resetHistory(jid);
    await sock.sendMessage(jid, { text: 'Conversation memory cleared.' });
    return;
  }

  if (command === 'prompt') {
    const value = args.join(' ').trim();
    if (!value) {
      await sock.sendMessage(jid, { text: `Usage: ${config.prefix}prompt <text>` });
      return;
    }
    config.systemPrompt = value;
    await sock.sendMessage(jid, { text: 'System prompt updated.' });
    return;
  }

  if (command === 'status') {
    await sock.sendMessage(jid, {
      text: `${config.botName} | model: ${config.model} | groups: ${config.replyInGroups ? 'on' : 'off'}`
    });
    return;
  }

  await sock.sendMessage(jid, { text: `Unknown command. Type ${config.prefix}help.` });
}

if (!config.apiKey) {
  logger.warn('GEMINI_API_KEY is not set. Add it to .env before chatting.');
}

process.on('unhandledRejection', reason => {
  logger.error('Unhandled rejection:', reason);
});

start().catch(error => {
  logger.error('Failed to start bot:', error);
  process.exit(1);
});
