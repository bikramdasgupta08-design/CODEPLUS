'use strict';

const config = require('../config');
const logger = require('../logger');
const { isOwner } = require('./util');

let enabled = config.spamEnabled !== false;
const hits = new Map();       // senderJid -> message timestamps
const mutedUntil = new Map(); // senderJid -> timestamp until which messages are ignored
const warned = new Set();     // send a warning only once per mute period

function status() {
  const now = Date.now();
  const muted = [...mutedUntil.entries()]
    .filter(([, until]) => until > now)
    .map(([jid, until]) => `${jid} (${Math.ceil((until - now) / 60000)}m left)`);

  return { enabled, tracked: hits.size, muted };
}

function setEnabled(value) {
  enabled = Boolean(value);
  if (!enabled) {
    hits.clear();
    mutedUntil.clear();
    warned.clear();
  }
}

async function unblock({ sock, jid }) {
  if (!jid) return 0;

  mutedUntil.delete(jid);
  warned.delete(jid);
  hits.delete(jid);

  if (config.spamAutoBlock && sock) {
    try {
      await sock.updateBlockStatus(jid, 'unblock');
    } catch (error) {
      logger.warn('SPAM_UNBLOCK_FAILED', { jid, error: error.message });
    }
  }
  return 1;
}

// Returns true when the message should be dropped.
async function checkIncoming({ sock, chatJid, senderJid }) {
  if (!enabled || isOwner(senderJid, config)) return false;

  const now = Date.now();
  const until = mutedUntil.get(senderJid) || 0;

  if (until > now) {
    if (!warned.has(senderJid)) {
      warned.add(senderJid);
      await sock.sendMessage(chatJid, {
        text: '🚫 You are temporarily blocked for sending too many messages. Please try again later.'
      }).catch(() => {});
    }
    logger.debug('SPAM_IGNORE', {
      senderJid,
      secondsLeft: Math.ceil((until - now) / 1000)
    });
    return true;
  }

  if (mutedUntil.has(senderJid)) {
    mutedUntil.delete(senderJid);
    warned.delete(senderJid);
  }

  const timestamps = (hits.get(senderJid) || []).filter(t => now - t < config.spamWindowMs);
  timestamps.push(now);
  hits.set(senderJid, timestamps);

  // Bound memory if many unique senders appear.
  if (hits.size > 1000) {
    for (const [jid, times] of hits) {
      if (!times.length || now - times[times.length - 1] > config.spamWindowMs) {
        hits.delete(jid);
      }
      if (hits.size <= 1000) break;
    }
  }

  if (timestamps.length > config.spamMaxMessages) {
    mutedUntil.set(senderJid, now + config.spamBlockDurationMs);
    hits.delete(senderJid);
    warned.delete(senderJid);
    logger.warn('SPAM_BLOCK', { senderJid, messages: timestamps.length });

    if (config.spamAutoBlock) {
      try {
        await sock.updateBlockStatus(senderJid, 'block');
        logger.warn('SPAM_WHATSAPP_BLOCK', { senderJid });
      } catch (error) {
        logger.warn('SPAM_WHATSAPP_BLOCK_FAILED', {
          senderJid,
          error: error.message
        });
      }
    }

    await sock.sendMessage(chatJid, {
      text: '🚫 CODEPLUS blocked you for spamming. Please try again in a few minutes.'
    }).catch(() => {});
    return true;
  }

  return false;
}

async function spam({ sock, jid, senderJid, args, config }) {
  if (!isOwner(senderJid || jid, config)) {
    await sock.sendMessage(jid, { text: 'This command is only available to the bot owner.' });
    return;
  }

  const [action, ...rest] = args;
  const command = (action || 'status').toLowerCase();

  if (command === 'on' || command === 'off') {
    setEnabled(command === 'on');
    await sock.sendMessage(jid, {
      text: `Spam protection is now ${command === 'on' ? 'ON' : 'OFF'}.`
    });
    return;
  }

  if (command === 'status') {
    const s = status();
    await sock.sendMessage(jid, {
      text: [
        `Spam protection: ${s.enabled ? 'ON' : 'OFF'}`,
        `• Threshold: ${config.spamMaxMessages} messages / ${Math.round(config.spamWindowMs / 1000)}s`,
        `• Block time: ${Math.round(config.spamBlockDurationMs / 60000)} minutes`,
        `• WhatsApp block: ${config.spamAutoBlock ? 'on' : 'off'}`,
        `• Tracked senders: ${s.tracked}`,
        `• Muted: ${s.muted.length ? s.muted.join(', ') : 'none'}`
      ].join('\n')
    });
    return;
  }

  if (command === 'unblock') {
    const target = rest.join(' ').trim();
    if (!target) {
      const count = await unblockAll({ sock });
      await sock.sendMessage(jid, { text: `Unblocked ${count} muted sender(s).` });
      return;
    }
    await unblock({ sock, jid: target });
    await sock.sendMessage(jid, { text: `Unblocked ${target}.` });
    return;
  }

  await sock.sendMessage(jid, {
    text: [
      'CODEPLUS spam control:',
      '• !spam status — Show spam protection status',
      '• !spam on — Enable spam protection',
      '• !spam off — Disable spam protection',
      '• !spam unblock <jid> — Unblock one sender',
      '• !spam unblock — Unblock all muted senders'
    ].join('\n')
  });
}

async function unblockAll({ sock }) {
  const jids = [...mutedUntil.keys()];
  let count = 0;
  for (const jid of jids) count += await unblock({ sock, jid });
  return count;
}

module.exports = {
  spam,
  checkIncoming,
  status,
  setEnabled,
  unblock,
  unblockAll
};
