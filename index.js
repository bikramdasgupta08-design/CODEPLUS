'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const config = require('./config');
const handlers = require('./handlers');
const { handleAwayMessage, state: awayState } = require('./handlers/away');
const { checkIncoming } = require('./handlers/spam');
const { findReply } = require('./handlers/autoreply');
const { askAI } = require('./ai');
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
    // WhatsApp sometimes echoes a sent message back with a different id.
    const text = typeof args?.[1]?.text === 'string' ? args[1].text.trim() : '';
    if (text) {
      outgoingTexts.set(text, Date.now());
      if (outgoingTexts.size > 500) outgoingTexts.delete(outgoingTexts.keys().next().value);
    }
    return result;
  };

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    // "registered" stays false for QR-paired sessions, and a stale pairing
    // request leaves me.name = "~". Only a real linked account counts.
    const hasSession = Boolean(state.creds.me?.id) && state.creds.me.name !== '~';

    if (qr && !hasSession) {
      const qrFile = path.join(__dirname, 'qr.txt');
      try {
        fs.writeFileSync(qrFile, `${qr}\n`);
      } catch (error) {
        logger.warn('Could not save QR:', error.message);
      }
      logger.info(`QR ready. View it with: cat ${qrFile}`);
      if (!config.usePairingCode) {
        logger.info('Scan this QR with WhatsApp -> Linked Devices');
        qrcode.generate(qr, { small: true });
      }
    }

    if (connection === 'connecting' && config.usePairingCode && config.phoneNumber && !hasSession && !pairingRequested) {
      pairingRequested = true;
      await new Promise(resolve => setTimeout(resolve, 2000));
      await requestPairingCode(sock);
    }

    if (connection === 'close') {
      pairingRequested = false;
      const status = lastDisconnect?.error?.output?.statusCode;
      if (status === DisconnectReason.loggedOut) {
        logger.warn('Logged out. Clearing stale session; a fresh QR will be generated.');
        try {
          fs.rmSync(config.authDir, { recursive: true, force: true });
        } catch (error) {
          logger.warn('Could not clear auth folder:', error.message);
        }
        process.exit(0);
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

  // Always reply in the chat the message came from. In groups that is the
  // group JID, even when WhatsApp also gives us the sender's phone JID.
  const chatJid = msg.key.remoteJid;
  const senderJid = msg.key.senderPn || msg.key.participantPn || msg.key.participant || chatJid;
  if (!chatJid || chatJid === 'status@broadcast') return;

  const content = msg.message;
  const body = (
    content.conversation ||
    content.extendedTextMessage?.text ||
    content.imageMessage?.caption ||
    content.videoMessage?.caption ||
    ''
  ).trim();

  logger.debug('INCOMING', {
    chatJid,
    senderJid,
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

  // Rate-limit senders before commands or AI so spam cannot trigger either.
  if (await checkIncoming({ sock, chatJid, senderJid })) return;

  if (body.startsWith(config.prefix)) {
    const [rawCommand, ...args] = body.slice(config.prefix.length).trim().split(/\s+/);
    const command = rawCommand.toLowerCase();
    const handler = handlers[command];

    if (handler) {
      await handler({ sock, jid: chatJid, senderJid, args, body, msg, config });
    } else {
      await sock.sendMessage(chatJid, { text: `Unknown command. Type ${config.prefix}help for a list.` });
    }
    return;
  }

  // While away mode is ON, incoming private messages get the away reply
  // instead of an AI answer. The owner's self-chat still uses AI.
  if (!msg.key.fromMe && !chatJid.endsWith('@g.us') && awayState.enabled) {
    await handleAwayMessage({ sock, jid: chatJid, config });
    return;
  }

  // Keyword auto-replies run before AI and work in groups too.
  const autoText = findReply(body);
  if (autoText) {
    await sock.sendMessage(chatJid, { text: autoText });
    logger.debug('AUTO_REPLY', { chatJid, senderJid });
    return;
  }

  // Normal chat = CODEPLUS AI, no prefix required.
  if (chatJid.endsWith('@g.us') && !config.aiReplyInGroups) return;

  try {
    const reply = await askAI(senderJid, body);
    await sock.sendMessage(chatJid, { text: reply });
    logger.debug('AI_REPLY', { chatJid, senderJid, reply });
  } catch (error) {
    logger.error('AI reply failed:', error);
    await sock.sendMessage(chatJid, {
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
