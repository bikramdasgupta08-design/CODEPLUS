'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');
const logger = require('../logger');
const { isOwner } = require('./util');

const file = path.isAbsolute(config.autoReplyFile)
  ? config.autoReplyFile
  : path.resolve(process.cwd(), config.autoReplyFile);

let enabled = true;
let rules = [];

function load() {
  try {
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(data)) {
        rules = data.filter(rule => rule && rule.keyword && rule.reply);
      }
    }
  } catch (error) {
    logger.warn('Could not load auto-reply rules:', error.message);
  }
}

function save() {
  try {
    fs.writeFileSync(file, JSON.stringify(rules, null, 2));
  } catch (error) {
    logger.warn('Could not save auto-reply rules:', error.message);
  }
}

load();

function list() {
  return rules.slice();
}

function findReply(body) {
  if (!enabled || !rules.length) return null;
  const text = String(body || '').toLowerCase();
  const match = rules.find(rule => text.includes(String(rule.keyword).toLowerCase()));
  return match ? match.reply : null;
}

function add(keyword, reply) {
  const key = String(keyword || '').trim();
  const value = String(reply || '').trim();
  if (!key || !value) throw new Error('Keyword and reply are both required.');

  const existing = rules.find(rule => rule.keyword.toLowerCase() === key.toLowerCase());
  if (existing) {
    existing.reply = value;
  } else {
    rules.push({ keyword: key, reply: value });
  }
  save();
  return existing ? 'updated' : 'added';
}

function remove(keyword) {
  const key = String(keyword || '').trim().toLowerCase();
  const before = rules.length;
  rules = rules.filter(rule => rule.keyword.toLowerCase() !== key);
  save();
  return before - rules.length;
}

function setEnabled(value) {
  enabled = Boolean(value);
}

async function autoreply({ sock, jid, senderJid, args, config }) {
  if (!isOwner(senderJid || jid, config)) {
    await sock.sendMessage(jid, { text: 'This command is only available to the bot owner.' });
    return;
  }

  const [action, ...rest] = args;
  const command = (action || 'status').toLowerCase();
  const value = rest.join(' ').trim();

  if (command === 'on' || command === 'off') {
    setEnabled(command === 'on');
    await sock.sendMessage(jid, {
      text: `Keyword auto-replies are now ${command === 'on' ? 'ON' : 'OFF'}.`
    });
    return;
  }

  if (command === 'add') {
    let keyword;
    let reply;
    const pipe = value.indexOf('|');
    if (pipe !== -1) {
      keyword = value.slice(0, pipe).trim();
      reply = value.slice(pipe + 1).trim();
    } else {
      const split = value.match(/^(\S+)\s+([\s\S]+)$/);
      keyword = split?.[1] || '';
      reply = split?.[2] || '';
    }

    try {
      const result = add(keyword, reply);
      await sock.sendMessage(jid, {
        text: `Auto-reply ${result}: "${keyword}" → "${reply}"`
      });
    } catch (error) {
      await sock.sendMessage(jid, { text: `Usage: !autoreply add <keyword> | <reply>\n${error.message}` });
    }
    return;
  }

  if (command === 'remove' || command === 'delete') {
    const count = remove(value);
    await sock.sendMessage(jid, {
      text: count ? `Removed auto-reply for "${value}".` : `No auto-reply found for "${value}".`
    });
    return;
  }

  if (command === 'list') {
    const rows = list().map((rule, index) => `${index + 1}. ${rule.keyword} → ${rule.reply}`);
    await sock.sendMessage(jid, {
      text: [
        `Keyword auto-replies: ${enabled ? 'ON' : 'OFF'}`,
        rows.length ? rows.join('\n') : 'No rules yet.'
      ].join('\n')
    });
    return;
  }

  await sock.sendMessage(jid, {
    text: [
      'CODEPLUS auto-reply:',
      '• !autoreply add <keyword> | <reply> — Add or update a rule',
      '• !autoreply remove <keyword> — Delete a rule',
      '• !autoreply list — Show all rules',
      '• !autoreply on — Enable keyword replies',
      '• !autoreply off — Disable keyword replies'
    ].join('\n')
  });
}

module.exports = {
  autoreply,
  findReply,
  list,
  add,
  remove,
  setEnabled
};
