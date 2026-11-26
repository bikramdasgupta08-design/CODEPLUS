'use strict';

function digits(jid) {
  return (jid || '').split('@')[0].replace(/\D/g, '');
}

// Owner JIDs may contain both a phone number and WhatsApp's private LID alias,
// so match the exact JID first, then fall back to comparing digits.
function isOwner(jid, config) {
  if (!config.ownerJids || !config.ownerJids.length) return true;
  if (config.ownerJids.includes(jid)) return true;
  const sender = digits(jid);
  if (!sender) return false;
  return config.ownerJids.some(owner => digits(owner) === sender);
}

module.exports = { digits, isOwner };
