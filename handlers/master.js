'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');
const logger = require('../logger');
const { isOwner } = require('./util');

const file = path.isAbsolute(config.botStateFile)
  ? config.botStateFile
  : path.resolve(process.cwd(), config.botStateFile);

// CODEPLUS starts silent. The owner must explicitly send !enable.
let enabled = false;
let enabledAt = null;
let enabledBy = null;

function load() {
  try {
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      enabled = Boolean(data.enabled);
      enabledAt = data.enabledAt || null;
      enabledBy = data.enabledBy || null;
    }
  } catch (error) {
    logger.warn('Could not load bot state:', error.message);
  }
}

function save() {
  try {
    fs.writeFileSync(file, JSON.stringify({ enabled, enabledAt, enabledBy }, null, 2));
  } catch (error) {
    logger.warn('Could not save bot state:', error.message);
  }
}

load();

function isEnabled() {
  return enabled;
}

function info() {
  return { enabled, enabledAt, enabledBy };
}

function setEnabled(value, by) {
  enabled = Boolean(value);
  enabledAt = enabled ? new Date().toISOString() : null;
  enabledBy = enabled ? (by || null) : null;
  save();
  logger.info(`CODEPLUS master switch ${enabled ? 'ENABLED' : 'DISABLED'}${by ? ` by ${by}` : ''}`);
}

async function requireOwner({ sock, jid, senderJid, config }) {
  if (isOwner(senderJid || jid, config)) return true;
  await sock.sendMessage(jid, { text: 'This command is only available to the bot owner.' });
  return false;
}

async function enable({ sock, jid, senderJid, config }) {
  if (!await requireOwner({ sock, jid, senderJid, config })) return;

  if (enabled) {
    await sock.sendMessage(jid, { text: 'CODEPLUS is already ENABLED.' });
    return;
  }

  setEnabled(true, senderJid || jid);
  await sock.sendMessage(jid, {
    text: '✅ CODEPLUS is now ENABLED. I will reply in all chats and groups.'
  });
}

async function disable({ sock, jid, senderJid, config }) {
  if (!await requireOwner({ sock, jid, senderJid, config })) return;

  setEnabled(false);
  await sock.sendMessage(jid, {
    text: '🛑 CODEPLUS is now DISABLED. Send !enable to turn me back on.'
  });
}

async function status({ sock, jid, senderJid, config }) {
  if (!await requireOwner({ sock, jid, senderJid, config })) return;

  const when = enabledAt ? new Date(enabledAt).toLocaleString() : 'never';
  await sock.sendMessage(jid, {
    text: [
      `CODEPLUS is ${enabled ? 'ENABLED' : 'DISABLED'}.`,
      `• Enabled at: ${when}`,
      `• Enabled by: ${enabledBy || 'nobody'}`,
      enabled
        ? '• I reply to normal messages in all chats and groups.'
        : '• I am ignoring every chat and group until you send !enable.'
    ].join('\n')
  });
}

module.exports = {
  enable,
  disable,
  status,
  isEnabled,
  setEnabled,
  info
};
