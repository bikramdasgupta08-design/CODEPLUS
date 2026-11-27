'use strict';

const fs = require('fs');
const path = require('path');
const { parsePhoneNumberFromString } = require('libphonenumber-js/max');
const config = require('./config');
const logger = require('./logger');
const { newsContext } = require('./web');
const { isOwner } = require('./handlers/util');

const file = path.resolve(process.cwd(), 'callerid.json');
let state = { enabled: false, numbers: {}, lastAlert: {} };

function load() {
  try {
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (data && typeof data === 'object') {
        state = {
          enabled: Boolean(data.enabled),
          numbers: data.numbers && typeof data.numbers === 'object' ? data.numbers : {},
          lastAlert: data.lastAlert && typeof data.lastAlert === 'object' ? data.lastAlert : {}
        };
      }
    }
  } catch (error) {
    logger.warn('Could not load caller ID data:', error.message);
  }
}

function save() {
  try {
    fs.writeFileSync(file, JSON.stringify(state, null, 2));
  } catch (error) {
    logger.warn('Could not save caller ID data:', error.message);
  }
}

load();

function parse(numberText) {
  if (!numberText) return null;
  const cleaned = String(numberText).replace(/[^\d+]/g, '');
  if (cleaned.replace(/\D/g, '').length < 8) return null;
  const phone = parsePhoneNumberFromString(cleaned, 'IN') ||
    parsePhoneNumberFromString(cleaned.replace(/^\+/, ''), 'IN');
  if (!phone || !phone.isValid()) return null;
  return phone;
}

function keyFor(phone) {
  return phone.number;
}

function labelFor(phone) {
  return state.numbers[keyFor(phone)] || null;
}

function riskFromReports(text) {
  const lower = String(text || '').toLowerCase();
  const words = ['scam', 'fraud', 'spam', 'fake', 'cheated', 'complaint', 'harassment', 'phishing'];
  return words.filter(word => lower.includes(word));
}

async function lookup(numberText) {
  const phone = parse(numberText);
  if (!phone) {
    return 'That does not look like a valid phone number. Example: 919073846974 or +91 90738 46974';
  }

  const label = labelFor(phone);
  let reports = '';
  try {
    reports = await newsContext(`"${keyFor(phone)}" scam fraud complaint`);
  } catch (error) {
    logger.debug('CALLERID_WEB_FAILED', error.message);
  }

  const flags = riskFromReports(reports);
  let risk = 'unknown';
  if (label?.tag === 'scam') risk = 'HIGH — saved as scam';
  else if (label?.tag === 'safe') risk = 'LOW — saved as trusted';
  else if (flags.length) risk = 'ELEVATED — public pages mention ' + flags.slice(0, 3).join(', ');

  const lines = [
    `📞 Caller ID: ${phone.formatInternational()}`,
    `• Country: ${phone.country || 'unknown'}`,
    `• Type: ${phone.getType() || 'unknown'}`,
    `• Valid number: ${phone.isValid() ? 'yes' : 'no'}`
  ];

  if (label) {
    lines.push(`• Saved name: ${label.name || 'not set'}`);
    lines.push(`• Saved tag: ${label.tag || 'unrated'}`);
    if (label.note) lines.push(`• Note: ${label.note}`);
  }

  lines.push(`• Risk: ${risk}`);
  lines.push(reports ? `• Public pages: ${reports.replace(/^Latest news: /, '').slice(0, 420)}` : '• Public pages: no public reports found');
  lines.push('⚠️ Public caller-ID data is limited. Never share OTPs, passwords or payment details based on a caller ID alone.');

  return lines.join('\n');
}

function setLabel(numberText, name, tag, note) {
  const phone = parse(numberText);
  if (!phone) return 'Invalid number. Example: !callerid save 919073846974 | Ramesh | safe';
  const allowed = ['safe', 'scam', 'spam', 'unknown'];
  const cleanTag = allowed.includes(String(tag || '').toLowerCase()) ? String(tag).toLowerCase() : 'unknown';
  state.numbers[keyFor(phone)] = {
    name: String(name || '').trim().slice(0, 80),
    tag: cleanTag,
    note: String(note || '').trim().slice(0, 200),
    updatedAt: new Date().toISOString()
  };
  save();
  return `Saved ${phone.formatInternational()} as "${name || 'unnamed'}" (${cleanTag}).`;
}

function removeLabel(numberText) {
  const phone = parse(numberText);
  if (!phone) return 'Invalid number.';
  const deleted = delete state.numbers[keyFor(phone)];
  save();
  return deleted ? `Removed ${phone.formatInternational()} from caller ID memory.` : 'That number was not saved.';
}

function isEnabled() {
  return state.enabled;
}

function toggle(value) {
  state.enabled = Boolean(value);
  save();
  return state.enabled;
}

function statusText() {
  return [
    `Caller ID mode: ${state.enabled ? 'ON' : 'OFF'}`,
    `• Saved numbers: ${Object.keys(state.numbers).length}`,
    '• Send any phone number in chat to get a formatted lookup.',
    '• Incoming calls send an alert with number details.',
    '• Save labels with: !callerid save <number> | <name> | <safe|scam|spam>'
  ].join('\n');
}

// Called from the Baileys `call` event. Only "offer" is a new incoming call;
// other statuses are updates for the same call and would duplicate alerts.
async function alertCall(sock, call) {
  if (!state.enabled) return;
  if (call?.status !== 'offer') return;

  const number = call.callerPn || call.from || '';
  const digits = String(number).replace(/\D/g, '');
  if (digits.length < 8) return;

  const last = state.lastAlert[digits] || 0;
  if (Date.now() - last < 5 * 60 * 1000) return;
  state.lastAlert[digits] = Date.now();
  save();

  const jid = config.ownerJids[0];
  const label = parse(digits) ? labelFor(parse(digits)) : null;
  const lines = [
    `📲 Incoming call detected${call.isVideo ? ' (video)' : ''}`,
    `• Number: ${number}`,
    label ? `• Saved as: ${label.name} (${label.tag})` : '• Saved as: unknown'
  ];

  if ((process.env.CALLERID_LOOKUP_ON_CALL || '').toLowerCase() === 'true') {
    try {
      lines.push((await lookup(digits)).split('\n').slice(1).join('\n'));
    } catch (error) {
      logger.debug('CALL_ALERT_LOOKUP_FAILED', error.message);
    }
  }

  try {
    await sock.sendMessage(jid, { text: lines.join('\n') });
    logger.debug('CALLERID_ALERT', { number });
  } catch (error) {
    logger.warn('Could not send caller ID alert:', error.message);
  }
}

async function callerid({ sock, jid, senderJid, args, body, config: cfg }) {
  if (!isOwner(senderJid || jid, cfg)) {
    await sock.sendMessage(jid, { text: 'Caller ID controls are owner only.' });
    return;
  }

  const [sub, ...rest] = args;
  const action = String(sub || '').toLowerCase();

  if (!action || action === 'status') {
    await sock.sendMessage(jid, { text: statusText() });
    return;
  }

  if (action === 'on' || action === 'off') {
    await sock.sendMessage(jid, { text: `Caller ID mode is now ${toggle(action === 'on') ? 'ON' : 'OFF'}.` });
    return;
  }

  if (action === 'save') {
    const raw = body.slice(body.indexOf('save') + 4).trim();
    const [numberPart, namePart, tagPart, ...noteParts] = raw.split('|').map(part => part.trim());
    await sock.sendMessage(jid, {
      text: setLabel(numberPart, namePart, tagPart || 'unknown', noteParts.join(' '))
    });
    return;
  }

  if (action === 'remove' || action === 'delete') {
    await sock.sendMessage(jid, { text: removeLabel(rest.join(' ')) });
    return;
  }

  if (action === 'lookup') {
    await sock.sendMessage(jid, { text: await lookup(rest.join(' ')) });
    return;
  }

  await sock.sendMessage(jid, {
    text: [
      'Caller ID usage:',
      '!callerid on / off / status',
      '!callerid lookup <number>',
      '!callerid save <number> | <name> | <safe|scam|spam> | <optional note>',
      '!callerid remove <number>'
    ].join('\n')
  });
}

module.exports = {
  callerid,
  lookup,
  parse,
  isEnabled,
  alertCall,
  statusText
};
