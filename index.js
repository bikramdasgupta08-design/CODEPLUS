'use strict';

const http = require('http');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const config = require('./config');
const handlers = require('./handlers');
const { handleAwayMessage, state: awayState } = require('./handlers/away');
const { askGemini, resetHistory } = require('./ai');
const logger = require('./logger');

let reconnecting = false;
let pairingRequested = false;
let baileys;
const outgoingIds = new Set();
const outgoingTexts = new Map();

async function loadBaileys() {
  if (!baileys) baileys = await import('@whiskeysockets/baileys');
  return baileys;
}

async function requestPairingCode(sock) {
  const phone = (config.phoneNumber || '').replace(/\D/g, '');
  if (!phone) return;

  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const code = await sock.requestPairingCode(phone);
      logger.info(`CODEPLUS pairing code: ${code}`);
      logger.info('WhatsApp -> Linked Devices -> Link with phone number -> enter this code.');
      return;
    } catch (error) {
      logger.warn(`Pairing code attempt ${attempt} failed:`, error.message);
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }
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
    browser: ['CODEPLUS', 'Chrome', '1.0.0'],
    printQRInTerminal: false,
    logger: pino({ level: 'warn' }),
    // Required for v7 to build LID <-> phone-number mappings.
    shouldSyncHistoryMessage: ({ syncType }) => syncType !== 2
  });

  // Remember every message we send so we never feed our own replies back into AI.
  const originalSend = sock.sendMessage.bind(sock);
  sock.sendMessage = async (...args) => {
    const result = await originalSend(...args);
    const id = result?.key?.id;
    if (id) {
      outgoingIds.add(id);
      if (outgoingIds.size > 500) outgoingIds.delete(outgoingIds.values().next().value);
    }
    // Also remember the text: WhatsApp sometimes echoes a sent message back
    // with a different id, and history sync can replay old bot replies.
    const text = typeof args?.[1]?.text === 'string' ? args[1].text.trim() : '';
    if (text) {
      outgoingTexts.set(text, Date.now());
      if (outgoingTexts.size > 500) outgoingTexts.delete(outgoingTexts.keys().next().value);
    }
    return result;
  };

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    // Never print a big QR on Render (logs are hard to scan). Pairing uses a
    // short 8-character code instead. QR is only a local fallback.
    if (qr && !config.phoneNumber) {
      if (process.env.PORT) {
        logger.info('Set PHONE_NUMBER in the environment to pair with a short code.');
      } else {
        logger.info('Scan this QR with WhatsApp -> Linked Devices');
        qrcode.generate(qr, { small: true });
      }
    }

    // "registered" is only set by the pairing-code flow, so it stays false
    // for QR-paired sessions. Check for a linked account instead.
    const hasSession = Boolean(state.creds.me?.id);
    if (connection === 'connecting' && config.phoneNumber && !hasSession && !pairingRequested) {
      pairingRequested = true;
      await new Promise(resolve => setTimeout(resolve, 2000));
      await requestPairingCode(sock);
    }

    if (connection === 'close') {
      pairingRequested = false;
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
      logger.info(`Bot is ready as ${sock.user?.name || 'WhatsApp'}`);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    logger.debug('UPSERT', { type, count: messages?.length });

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
  if (!msg.message) return;

  // Prefer the real phone number when WhatsApp supplies it alongside an @lid JID.
  const jid = msg.key.senderPn || msg.key.participantPn || msg.key.remoteJid;
  if (!jid || jid === 'status@broadcast') return;

  const content = msg.message;
  const body = (
    content.conversation ||
    content.extendedTextMessage?.text ||
    content.imageMessage?.caption ||
    content.videoMessage?.caption ||
    ''
  ).trim();

  logger.debug('INCOMING', {
    jid,
    remoteJid: msg.key.remoteJid,
    fromMe: msg.key.fromMe,
    body
  });
  if (!body) return;

  // Never feed the bot's own replies back into the loop. The owner's own
  // self-chat messages are fromMe too, but they are not in these collections.
  if (msg.key.fromMe) {
    if (outgoingIds.has(msg.key.id)) return;
    const sentAt = outgoingTexts.get(body);
    if (sentAt && Date.now() - sentAt < 10 * 60 * 1000) {
      outgoingTexts.delete(body);
      return;
    }
  }

  if (body.startsWith(config.prefix)) {
    const [rawCommand, ...args] = body.slice(config.prefix.length).trim().split(/\s+/);
    const command = rawCommand.toLowerCase();
    const handler = handlers[command];

    if (handler) {
      await handler({ sock, jid, args, body, msg, config });
    } else {
      await sock.sendMessage(jid, { text: `Unknown command. Type ${config.prefix}help for a list.` });
    }
    return;
  }

  // While away mode is ON, incoming private messages get the away reply
  // instead of an AI answer. The owner's self-chat still uses AI.
  if (!msg.key.fromMe && !jid.endsWith('@g.us') && awayState.enabled) {
    await handleAwayMessage({ sock, jid, config });
    return;
  }

  // Normal chat = CODEPLUS AI, no prefix required.
  if (jid.endsWith('@g.us') && !config.aiReplyInGroups) return;

  try {
    const reply = await askGemini(jid, body);
    await sock.sendMessage(jid, { text: reply });
    logger.debug('AI_REPLY', { jid, reply });
  } catch (error) {
    logger.error('AI reply failed:', error);
    await sock.sendMessage(jid, {
      text: 'Sorry, CODEPLUS is temporarily unavailable. Please try again in a moment.'
    }).catch(() => {});
  }
}

// Render Web Services must bind a port or the deploy is killed. This is a
// no-op locally (PORT is only set by hosting platforms).
if (process.env.PORT) {
  const port = Number(process.env.PORT) || 10000;
  http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('CODEPLUS is running');
  }).listen(port, '0.0.0.0', () => logger.info(`Health server listening on port ${port}`));
}

process.on('unhandledRejection', reason => {
  logger.error('Unhandled rejection:', reason);
});

start().catch(error => {
  logger.error('Failed to start bot:', error);
  process.exit(1);
});
