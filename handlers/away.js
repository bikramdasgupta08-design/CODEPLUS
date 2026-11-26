'use strict';

const { isOwner } = require('./util');

const state = { enabled: false, message: '' };
const lastReplyAt = new Map();

async function away({ sock, jid, senderJid, args, config }) {
  if (!isOwner(senderJid || jid, config)) {
    await sock.sendMessage(jid, { text: 'This command is only available to the bot owner.' });
    return;
  }

  const value = args.join(' ').trim();

  if (!value || /^status$/i.test(value)) {
    await sock.sendMessage(jid, {
      text: state.enabled ? `Away mode is ON: "${state.message}"` : 'Away mode is OFF.'
    });
    return;
  }

  if (/^(off|false|0|disable)$/i.test(value)) {
    state.enabled = false;
    state.message = '';
    lastReplyAt.clear();
    await sock.sendMessage(jid, { text: 'Away mode is now OFF.' });
    return;
  }

  state.enabled = true;
  state.message = value;
  await sock.sendMessage(jid, { text: `Away mode is now ON: "${value}"` });
}

async function handleAwayMessage({ sock, jid, config }) {
  if (!state.enabled) return;

  const now = Date.now();
  const last = lastReplyAt.get(jid) || 0;
  if (now - last < config.awayCooldownMs) return;

  lastReplyAt.set(jid, now);
  await sock.sendMessage(jid, { text: state.message || config.defaultAwayMessage });
}

module.exports = { away, handleAwayMessage, state };
