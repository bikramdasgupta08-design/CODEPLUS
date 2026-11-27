'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const config = require('./config');
const handlers = require('./handlers');
const { handleAwayMessage, state: awayState } = require('./handlers/away');
const { checkIncoming } = require('./handlers/spam');
const { findReply } = require('./handlers/autoreply');
const { isChatEnabled, isSelfChat } = require('./handlers/chatstate');
const { isOwner } = require('./handlers/util');
const { handleImageCaption } = require('./handlers/media');
const { askAI } = require('./ai');
const callerid = require('./callerid');
const safechat = require('./safechat');
const groupguard = require('./groupguard');
const logger = require('./logger');

// Per-chat switches are controlled with these, even when the chat is paused.
const SWITCH_COMMANDS = new Set(['enable', 'disable', 'status']);

let reconnecting = false;
let pairingRequested = false;
let missingSessionReported = false;
let loggedOutRetries = 0;
let silentRetryTimer = null;
let startRetryTimer = null;
let socketSwitching = false;
let currentSock = null;
let rejectedSessionHash = null;
let baileys;
const outgoingIds = new Set();
const outgoingTexts = new Map();

// Render's free plan has an ephemeral disk. A Secret File (or local backup)
// restores the WhatsApp credentials so redeploys never need a QR code.
const SESSION_ENV_KEYS = ['WA_CREDENTIALS', 'WA_CREDS_JSON', 'WHATSAPP_CREDENTIALS'];
const SECRET_PATHS = [
  process.env.WA_CREDENTIALS_PATH,
  '/etc/secrets/wa-creds.json',
  '/etc/secrets/creds.json',
  path.join(__dirname, 'wa-creds.secret.json'),
  path.join(__dirname, 'wa-creds.json')
].filter(Boolean);

function readSessionFromEnvironment() {
  for (const key of SESSION_ENV_KEYS) {
    const raw = process.env[key];
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      if (parsed?.me?.id || parsed?.signedIdentityKey) return parsed;
    } catch (error) {
      logger.warn(`${key} is not valid JSON:`, error.message);
    }
  }
  return null;
}

function readSessionFromSecretFile() {
  for (const file of SECRET_PATHS) {
    try {
      if (!fs.existsSync(file)) continue;
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed?.me?.id || parsed?.signedIdentityKey) {
        logger.info(`Restoring WhatsApp session from secret file: ${file}`);
        return parsed;
      }
    } catch (error) {
      logger.warn(`Could not read secret session file ${file}:`, error.message);
    }
  }
  return null;
}

function findGeneratedBackup() {
  try {
    return fs.readdirSync(__dirname)
      .filter(name => /^wa-creds-backup-.*\.json$/.test(name))
      .sort()
      .pop();
  } catch {
    return null;
  }
}

function restoreSession(force = false) {
  const target = path.join(config.authDir, 'creds.json');
  if (!force && fs.existsSync(target)) return false;
  let creds = readSessionFromSecretFile() || readSessionFromEnvironment();
  if (!creds) {
    const backup = findGeneratedBackup();
    if (backup) {
      try {
        creds = JSON.parse(fs.readFileSync(path.join(__dirname, backup), 'utf8'));
        logger.info(`Restoring WhatsApp session from local backup: ${backup}`);
      } catch (error) {
        logger.warn(`Could not read session backup ${backup}:`, error.message);
      }
    }
  }
  if (!creds || !isLinkedSession(creds)) return false;
  fs.mkdirSync(config.authDir, { recursive: true });
  // Write atomically so a restart during deploy never leaves a broken session.
  const temp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(creds), { mode: 0o600 });
  fs.renameSync(temp, target);
  logger.info('WhatsApp session restored; QR is disabled.');
  return true;
}

function isLinkedSession(creds) {
  return Boolean(creds?.me?.id) && creds.me.name !== '~';
}

function backupSession() {
  // Render has no persistent disk, so a generated backup cannot be downloaded
  // after a redeploy. The uploaded Secret File is the single source of truth.
  if (process.env.RENDER) return null;
  const source = path.join(config.authDir, 'creds.json');
  if (!fs.existsSync(source)) return null;
  try {
    const raw = fs.readFileSync(source);
    const parsed = JSON.parse(raw.toString());
    if (!isLinkedSession(parsed)) return null;
    const hash = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 12);
    const nickname = String(parsed.me.name || '').replace(/[^\w-]/g, '').slice(0, 24);
    const file = path.join(__dirname, `wa-creds-backup-${nickname}-${hash}.json`);
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, raw, { mode: 0o600 });
      logger.warn(`IMPORTANT: save this file as a Render Secret File named wa-creds.json: ${file}`);
    }
    return file;
  } catch (error) {
    logger.warn('Could not prepare session backup:', error.message);
    return null;
  }
}

function sessionHash() {
  const target = path.join(config.authDir, 'creds.json');
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
  } catch {
    return null;
  }
}

async function restartWithoutQr() {
  if (socketSwitching) return;
  socketSwitching = true;
  // Prevent the old socket's close event from starting a second connection.
  reconnecting = true;
  try {
    await currentSock?.end?.();
  } catch (error) {
    logger.warn('Could not close previous socket cleanly:', error.message);
  }
  await new Promise(resolve => setTimeout(resolve, 1000));
  currentSock = null;
  reconnecting = false;
  socketSwitching = false;
  await start();
}

function scheduleSilentRetry() {
  if (silentRetryTimer) return;
  logger.warn('Keeping the service alive. Session restore will retry every 30 seconds without QR.');
  silentRetryTimer = setInterval(async () => {
    if (socketSwitching) return;
    const existing = sessionHash();
    // Do not loop forever on a credential file WhatsApp already rejected.
    if (existing && existing === rejectedSessionHash) return;
    if (!restoreSession(true)) return;
    if (sessionHash() === rejectedSessionHash) return;
    clearInterval(silentRetryTimer);
    silentRetryTimer = null;
    logger.info('Saved session changed; reconnecting without QR...');
    try {
      await restartWithoutQr();
    } catch (error) {
      logger.error('Silent reconnect failed:', error);
      scheduleStartRetry();
    }
  }, 30000);
}

function scheduleStartRetry() {
  if (startRetryTimer) return;
  startRetryTimer = setTimeout(() => {
    startRetryTimer = null;
    start().catch(error => {
      logger.error('Failed to start bot; retrying silently:', error);
      scheduleStartRetry();
    });
  }, 30000);
}

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

  restoreSession();

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
  currentSock = sock;

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
    // "registered" stays false for QR-paired sessions, and an abandoned
    // pairing request leaves me.name = "~". Only a real linked account counts.
    const hasSession = isLinkedSession(state.creds);

    if (qr && !hasSession) {
      if (config.forceQr || config.usePairingCode) {
        if (config.forceQr && !config.usePairingCode) {
          const qrFile = path.join(__dirname, 'qr.txt');
          try {
            fs.writeFileSync(qrFile, `${qr}\n`);
          } catch (error) {
            logger.warn('Could not save QR:', error.message);
          }
          logger.info(`QR ready (manual opt-in). View it with: cat ${qrFile}`);
          logger.info('Scan this QR with WhatsApp -> Linked Devices');
          qrcode.generate(qr, { small: true });
        }
      } else if (!missingSessionReported) {
        missingSessionReported = true;
        logger.warn('No linked WhatsApp session found. QR generation is disabled; the service stays online.');
        logger.warn('Upload the saved wa-creds.json as a Render Secret File to restore the session automatically.');
        scheduleSilentRetry();
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
        logger.warn('WhatsApp reported this session as logged out. Restoring saved credentials and reconnecting without QR...');
        if (loggedOutRetries < 2) {
          loggedOutRetries += 1;
          restoreSession(true);
          await new Promise(resolve => setTimeout(resolve, 3000));
          await start();
        } else {
          rejectedSessionHash = sessionHash();
          logger.warn('Saved WhatsApp session is no longer linked. QR is disabled; the service stays online.');
          logger.warn('Upload a fresh wa-creds.json Render Secret File to reconnect automatically.');
          scheduleSilentRetry();
        }
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
      missingSessionReported = false;
      loggedOutRetries = 0;
      rejectedSessionHash = null;
      if (silentRetryTimer) {
        clearInterval(silentRetryTimer);
        silentRetryTimer = null;
      }
      backupSession();
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

  // Group protection: member changes, settings changes and deleted messages.
  sock.ev.on('group-participants.update', async event => {
    try { await groupguard.onParticipantsUpdate(sock, event); }
    catch (error) { logger.error('Group participant guard failed:', error); }
  });
  sock.ev.on('groups.update', async updates => {
    try { await groupguard.onGroupsUpdate(sock, updates); }
    catch (error) { logger.error('Group settings guard failed:', error); }
  });
  sock.ev.on('messages.delete', async event => {
    try { await groupguard.onMessageDelete(sock, event); }
    catch (error) { logger.error('Message delete guard failed:', error); }
  });

  // Caller ID mode: alerts for incoming calls (Baileys exposes call updates).
  sock.ev.on('call', async calls => {
    for (const call of calls || []) {
      try { await callerid.alertCall(sock, call); }
      catch (error) { logger.error('Caller ID alert failed:', error); }
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
    body,
    chatEnabled: isChatEnabled(chatJid, config)
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

  const isCommand = body.startsWith(config.prefix);
  let command = '';
  let args = [];
  if (isCommand) {
    const [rawCommand, ...rest] = body.slice(config.prefix.length).trim().split(/\s+/);
    command = rawCommand.toLowerCase();
    args = rest;
  }

  // Per-chat switches always work for the owner, even when the chat is paused.
  // Non-owners are ignored silently so a paused chat produces no reaction.
  if (SWITCH_COMMANDS.has(command)) {
    if (isOwner(senderJid, config)) {
      await handlers[command]({ sock, jid: chatJid, senderJid, args, body, msg, config });
    } else {
      logger.debug('SWITCH_IGNORED', { chatJid, senderJid, command });
    }
    return;
  }

  // A paused chat ignores everything. The owner's own chat is the exception:
  // all commands keep working there, so you never lose control of the bot.
  if (!isChatEnabled(chatJid, config)) {
    if (!(isSelfChat(chatJid, config) && isCommand)) {
      logger.debug('CHAT_PAUSED_IGNORE', { chatJid, senderJid, body });
      return;
    }
  }

  // Rate-limit senders before commands or AI so spam cannot trigger either.
  if (await checkIncoming({ sock, chatJid, senderJid })) return;

  // Keep recent group messages in memory for anti-nuke message recovery.
  if (chatJid.endsWith('@g.us')) groupguard.remember(msg, body);

  if (isCommand) {
    const handler = handlers[command];

    if (handler) {
      await handler({ sock, jid: chatJid, senderJid, args, body, msg, config });
    } else {
      await sock.sendMessage(chatJid, { text: `Unknown command. Type ${config.prefix}help for a list.` });
    }
    return;
  }

  // Image sent with a natural caption like "make pdf" or "remove background".
  if (await handleImageCaption(sock, chatJid, msg, body, config)) return;

  // Caller ID mode: a bare phone number becomes a formatted lookup.
  if (callerid.isEnabled() && /^\+?[\d\s()-]{10,25}$/.test(body) && body.replace(/\D/g, '').length >= 10) {
    await sock.sendMessage(chatJid, { text: await callerid.lookup(body) });
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
    const safeOn = safechat.isEnabled(chatJid);
    const reply = await askAI(senderJid, body, safeOn ? safechat.guardPrompt() : '');
    const warning = safeOn ? safechat.warningFor(body) : '';
    const finalText = warning ? `${warning}\n\n${reply}` : reply;
    await sock.sendMessage(chatJid, { text: finalText });
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
  logger.error('Failed to start bot; retrying silently:', error);
  scheduleStartRetry();
});
