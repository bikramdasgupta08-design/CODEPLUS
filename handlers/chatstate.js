'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');
const logger = require('../logger');
const { isOwner, digits } = require('./util');

const file = path.isAbsolute(config.botStateFile)
  ? config.botStateFile
  : path.resolve(process.cwd(), config.botStateFile);

// Each chat/group has its own switch. The owner's own chat is enabled by
// default; every other chat stays silent until !enable is sent there.
let chats = {};

function load() {
  try {
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (data && typeof data === 'object' && data.chats && typeof data.chats === 'object') {
        chats = data.chats;
      }
    }
  } catch (error) {
    logger.warn('Could not load chat state:', error.message);
  }
}

function save() {
  try {
    fs.writeFileSync(file, JSON.stringify({ chats }, null, 2));
  } catch (error) {
    logger.warn('Could not save chat state:', error.message);
  }
}

load();

function isSelfChat(jid, chatConfig) {
  const cfg = chatConfig || config;
  if (!jid) return false;
  if (cfg.ownerJids.includes(jid)) return true;
  const mine = digits(jid);
  return Boolean(mine) && cfg.ownerJids.some(owner => digits(owner) === mine);
}

function isChatEnabled(jid, chatConfig) {
  if (isSelfChat(jid, chatConfig)) {
    // The owner's own chat defaults to on. An explicit !disable can pause it.
    const own = chats[jid];
    return own ? own.enabled !== false : true;
  }
  return Boolean(chats[jid]?.enabled);
}

function chatInfo(jid, chatConfig) {
  const entry = chats[jid] || {};
  return {
    enabled: isChatEnabled(jid, chatConfig),
    scope: isSelfChat(jid, chatConfig) ? 'owner chat (commands always available)' : 'this chat only',
    enabledAt: entry.enabledAt || null,
    enabledBy: entry.enabledBy || null
  };
}

function setChatEnabled(jid, value, by) {
  chats[jid] = {
    enabled: Boolean(value),
    enabledAt: value ? new Date().toISOString() : null,
    enabledBy: value ? (by || null) : null
  };
  save();
  logger.info(`CODEPLUS ${value ? 'ENABLED' : 'DISABLED'} for chat ${jid}${by ? ` by ${by}` : ''}`);
}

async function requireOwner({ sock, jid, senderJid, config }) {
  if (isOwner(senderJid || jid, config)) return true;
  await sock.sendMessage(jid, { text: 'This command is only available to the bot owner.' });
  return false;
}

async function enable({ sock, jid, senderJid, config }) {
  if (!await requireOwner({ sock, jid, senderJid, config })) return;
  setChatEnabled(jid, true, senderJid || jid);
  await sock.sendMessage(jid, {
    text: '✅ CODEPLUS is enabled for THIS chat only. Other chats and groups stay paused until you send !enable there.'
  });
}

async function disable({ sock, jid, senderJid, config }) {
  if (!await requireOwner({ sock, jid, senderJid, config })) return;
  setChatEnabled(jid, false);
  await sock.sendMessage(jid, {
    text: '🛑 CODEPLUS is paused for THIS chat only. Send !enable here to turn it back on.'
  });
}

async function status({ sock, jid, senderJid, config }) {
  if (!await requireOwner({ sock, jid, senderJid, config })) return;
  const info = chatInfo(jid, config);
  const when = info.enabledAt ? new Date(info.enabledAt).toLocaleString() : 'not set';

  await sock.sendMessage(jid, {
    text: [
      `CODEPLUS in this chat: ${info.enabled ? 'ENABLED' : 'DISABLED'}`,
      `• Scope: ${info.scope}`,
      `• Enabled at: ${when}`,
      `• Enabled by: ${info.enabledBy || 'nobody'}`,
      '• Other chats and groups have their own switch.'
    ].join('\n')
  });
}

module.exports = {
  enable,
  disable,
  status,
  isChatEnabled,
  isSelfChat,
  chatInfo,
  setChatEnabled
};
