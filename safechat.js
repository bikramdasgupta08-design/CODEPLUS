'use strict';

const fs = require('fs');
const path = require('path');
const config = require('./config');
const logger = require('./logger');
const { isOwner } = require('./handlers/util');

const file = path.resolve(process.cwd(), 'safechat.json');
let state = { chats: {} };

function load() {
  try {
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (data && typeof data === 'object' && data.chats) state.chats = data.chats;
    }
  } catch (error) {
    logger.warn('Could not load safe-chat state:', error.message);
  }
}

function save() {
  try {
    fs.writeFileSync(file, JSON.stringify(state, null, 2));
  } catch (error) {
    logger.warn('Could not save safe-chat state:', error.message);
  }
}

load();

const RULES = [
  {
    tag: 'OTP / verification code request',
    level: 'high',
    pattern: /\b(otp|one[- ]?time (password|code)|verification code|verify (your|the) (account|number)|share (me )?(the )?(code|otp))\b/i
  },
  {
    tag: 'password / credential request',
    level: 'high',
    pattern: /\b(password|pin|card number|cvv|upi pin|net banking|login credentials)\b/i
  },
  {
    tag: 'payment or prize request',
    level: 'medium',
    pattern: /\b(send money|pay now|upi|gpay|phonepe|paytm|transfer|processing fee|claim (your )?(prize|reward|money)|lottery|won (\d|rs|inr|₹))\b/i
  },
  {
    tag: 'suspicious link',
    level: 'medium',
    pattern: /\b(bit\.ly|tinyurl|t\.me|wa\.me|click here|verify now|limited time|urgent action)\b/i
  },
  {
    tag: 'job / investment offer',
    level: 'medium',
    pattern: /\b(work from home|earn (rs|₹|\d)|part[- ]time job|guaranteed returns|double your money|trading tips)\b/i
  },
  {
    tag: 'threat or pressure',
    level: 'medium',
    pattern: /\b(blocked|legal action|police case|arrest|account will be (closed|deleted)|last chance)\b/i
  }
];

function analyze(text) {
  const value = String(text || '');
  const reasons = [];
  let level = 'none';

  for (const rule of RULES) {
    if (rule.pattern.test(value)) {
      reasons.push(rule.tag);
      if (rule.level === 'high') level = 'high';
      else if (level !== 'high') level = 'medium';
    }
  }

  // Several raw links in one message are itself a common scam pattern.
  const links = value.match(/https?:\/\/[^\s]+/gi) || [];
  if (links.length >= 3) {
    reasons.push('multiple links in one message');
    if (level === 'none') level = 'medium';
  }

  return { level, reasons };
}

// Masks identifying details in stored/logged text and in AI replies when the
// owner asks for privacy mode. Keeps the message readable.
function redact(text) {
  return String(text || '')
    .replace(/\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g, '•••• •••• •••• ••••')
    .replace(/\b\d{4,8}\b/g, '••••')
    .replace(/\b[\w.+-]+@[\w-]+\.[\w.]+\b/g, '••••@••••')
    .replace(/(\+?\d[\d\s-]{8,}\d)/g, '••••');
}

function guardPrompt() {
  return [
    'Safe-chat mode is ON for this chat.',
    'Warn the user about scams, OTP/password sharing, suspicious payment requests and unsafe links.',
    'Do not help with fraud, impersonation, harassment or anything that could harm another person.',
    'Never ask the user for OTPs, passwords, card details or private keys.'
  ].join(' ');
}

function warningFor(text) {
  const result = analyze(text);
  if (result.level === 'none') return '';

  const title = result.level === 'high' ? '🚨 Scam alert' : '⚠️ Be careful';
  return [
    `${title}: this message mentions ${result.reasons.slice(0, 3).join(', ')}.`,
    'Do not share OTPs, passwords, UPI PINs or payment details. Verify the person by another method before acting.'
  ].join('\n');
}

function isEnabled(jid) {
  return Boolean(state.chats[jid]);
}

function toggle(jid, value) {
  if (value) state.chats[jid] = { enabledAt: new Date().toISOString() };
  else delete state.chats[jid];
  save();
  return Boolean(value);
}

async function safe({ sock, jid, senderJid, args, config: cfg }) {
  if (!isOwner(senderJid || jid, cfg)) {
    await sock.sendMessage(jid, { text: 'Safe-chat controls are owner only.' });
    return;
  }

  const action = String(args[0] || '').toLowerCase();

  if (action === 'on' || action === 'off') {
    await sock.sendMessage(jid, {
      text: `Safe chat is now ${toggle(jid, action === 'on') ? 'ON' : 'OFF'} in this chat.`
    });
    return;
  }

  if (action === 'check') {
    const text = args.slice(1).join(' ').trim();
    if (!text) {
      await sock.sendMessage(jid, { text: 'Usage: !safe check <message or link>' });
      return;
    }
    const result = analyze(text);
    await sock.sendMessage(jid, {
      text: [
        `Safe-chat scan: ${result.level === 'none' ? 'looks normal' : result.level.toUpperCase() + ' RISK'}`,
        result.reasons.length ? `• Flags: ${result.reasons.join(', ')}` : '• No known risk patterns found.',
        '• This is a heuristic check, not a guarantee. Verify independently.'
      ].join('\n')
    });
    return;
  }

  await sock.sendMessage(jid, {
    text: [
      `Safe chat in this chat: ${isEnabled(jid) ? 'ON' : 'OFF'}`,
      '',
      'Usage:',
      '!safe on      — enable scam/payment safety checks here',
      '!safe off     — disable them here',
      '!safe check <text> — scan a message or link'
    ].join('\n')
  });
}

module.exports = {
  safe,
  analyze,
  redact,
  guardPrompt,
  warningFor,
  isEnabled
};
