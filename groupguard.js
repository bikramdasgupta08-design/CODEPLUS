'use strict';

const fs = require('fs');
const path = require('path');
const config = require('./config');
const logger = require('./logger');
const { isOwner } = require('./handlers/util');

const file = path.resolve(process.cwd(), 'groupguard.json');
let state = { groups: {} };

function load() {
  try {
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (data && typeof data === 'object' && data.groups) state.groups = data.groups;
    }
  } catch (error) {
    logger.warn('Could not load group guard state:', error.message);
  }
}

function save() {
  try {
    fs.writeFileSync(file, JSON.stringify(state, null, 2));
  } catch (error) {
    logger.warn('Could not save group guard state:', error.message);
  }
}

load();

// Recent messages are only kept in memory, never on disk.
const recent = new Map();
const MAX_RECENT = 400;

function remember(msg, body) {
  const jid = msg?.key?.remoteJid;
  const id = msg?.key?.id;
  if (!jid || !id || !jid.endsWith('@g.us') || !body) return;
  recent.set(id, {
    jid,
    sender: msg.key.participant || msg.key.senderPn || jid,
    text: String(body).slice(0, 400),
    at: Date.now()
  });
  if (recent.size > MAX_RECENT) recent.delete(recent.keys().next().value);
}

function digits(jid) {
  return String(jid || '').replace(/\D/g, '');
}

function botJids(sock) {
  const id = sock?.user?.id || '';
  const bare = id.split(':')[0];
  return new Set([id, `${bare}@s.whatsapp.net`, ...config.ownerJids]);
}

async function isAdmin(sock, jid) {
  try {
    const meta = await sock.groupMetadata(jid);
    const ids = botJids(sock);
    const me = (meta.participants || []).find(p => ids.has(p.id));
    return Boolean(me && me.admin);
  } catch (error) {
    logger.debug('GROUP_ADMIN_CHECK_FAILED', error.message);
    return false;
  }
}

function settings(jid) {
  if (!state.groups[jid]) {
    state.groups[jid] = { antiPrune: false, antiNuke: false, snapshot: null, incidents: [] };
  }
  return state.groups[jid];
}

function reset(jid) {
  settings(jid).snapshot = null;
  save();
}

function addIncident(jid, type, details) {
  const group = settings(jid);
  group.incidents.unshift({ type, details, at: new Date().toISOString() });
  group.incidents = group.incidents.slice(0, 20);
  save();
}

async function alert(sock, jid, text) {
  const targets = [jid, config.ownerJids[0]].filter((value, index, all) => all.indexOf(value) === index);
  for (const target of targets) {
    try {
      await sock.sendMessage(target, { text });
    } catch (error) {
      logger.debug('GROUP_GUARD_ALERT_FAILED', { target, error: error.message });
    }
  }
}

async function takeSnapshot(sock, jid) {
  try {
    const meta = await sock.groupMetadata(jid);
    let inviteCode;
    try { inviteCode = await sock.groupInviteCode(jid); } catch (_) { /* bot may not be admin */ }
    const group = settings(jid);
    group.snapshot = {
      subject: meta.subject || '',
      description: meta.desc || '',
      inviteCode: inviteCode || null,
      participants: (meta.participants || []).map(p => p.id),
      updatedAt: new Date().toISOString()
    };
    save();
    return true;
  } catch (error) {
    logger.warn('GROUP_SNAPSHOT_FAILED', { jid, error: error.message });
    return false;
  }
}

async function onParticipantsUpdate(sock, event) {
  const jid = event?.id;
  if (!jid || !jid.endsWith('@g.us')) return;
  const group = state.groups[jid];
  if (!group || (!group.antiPrune && !group.antiNuke)) return;

  const action = event.action;
  const participants = event.participants || [];
  const actor = event.author || event.authorPn || 'unknown';
  const ids = botJids(sock);

  if (action === 'remove' && participants.length) {
    const botRemoved = participants.some(p => ids.has(p));
    if (botRemoved) {
      addIncident(jid, 'BOT_REMOVED', { actor, participants });
      const code = group.snapshot?.inviteCode;
      let rejoined = false;
      if (code) {
        try {
          await sock.groupAcceptInvite(code);
          rejoined = true;
        } catch (error) {
          logger.warn('AUTO_REJOIN_FAILED', error.message);
        }
      }
      await alert(sock, config.ownerJids[0],
        `🛡️ Anti-nuke: I was removed from ${group.snapshot?.subject || jid} by ${actor}.` +
        (rejoined ? ' I rejoined using the saved invite link.' : ' No saved invite link was available — please re-add me.'));
      return;
    }

    addIncident(jid, 'MEMBERS_REMOVED', { actor, count: participants.length });
    if (group.antiPrune && participants.length >= (config.antiPruneThreshold || 2)) {
      if (await isAdmin(sock, jid)) {
        try {
          await sock.groupParticipantsUpdate(jid, participants, 'add');
          await alert(sock, jid,
            `🛡️ Anti-prune: ${actor} removed ${participants.length} member(s). I restored them.`);
        } catch (error) {
          await alert(sock, jid,
            `🛡️ Anti-prune detected ${participants.length} removals by ${actor}, but I could not restore them: ${error.message}`);
        }
      } else {
        await alert(sock, jid,
          `🛡️ Anti-prune detected ${participants.length} removals by ${actor}. I need admin rights to restore members.`);
      }
    }
    return;
  }

  if (group.antiNuke && (action === 'demote' || action === 'promote')) {
    addIncident(jid, `MEMBERS_${action.toUpperCase()}`, { actor, participants });
    await alert(sock, jid, `🛡️ Anti-nuke: ${actor} changed admin rights for ${participants.length} member(s).`);
  }
}

async function onGroupsUpdate(sock, updates) {
  for (const update of updates || []) {
    const jid = update?.id;
    if (!jid || !jid.endsWith('@g.us')) continue;
    const group = state.groups[jid];
    if (!group?.antiNuke || !group.snapshot) continue;

    const changes = [];
    if (update.subject && group.snapshot.subject && update.subject !== group.snapshot.subject) {
      changes.push(`subject "${group.snapshot.subject}" → "${update.subject}"`);
    }
    if (typeof update.desc === 'string' && group.snapshot.description && update.desc !== group.snapshot.description) {
      changes.push('group description');
    }
    if (!changes.length) continue;

    addIncident(jid, 'SETTINGS_CHANGED', { actor: update.author || 'unknown', changes });
    const canRestore = await isAdmin(sock, jid);
    const actions = [];
    if (canRestore) {
      try {
        if (changes.some(c => c.startsWith('subject'))) {
          await sock.groupUpdateSubject(jid, group.snapshot.subject);
          actions.push('subject restored');
        }
        if (changes.includes('group description')) {
          await sock.groupUpdateDescription(jid, group.snapshot.description);
          actions.push('description restored');
        }
      } catch (error) {
        actions.push(`restore failed: ${error.message}`);
      }
    } else {
      actions.push('I need admin rights to restore settings');
    }
    await alert(sock, jid,
      `🛡️ Anti-nuke: ${update.author || 'Someone'} changed ${changes.join(', ')}. ${actions.join('; ')}`);
  }
}

async function onMessageDelete(sock, event) {
  for (const key of event?.keys || []) {
    const jid = key?.remoteJid;
    if (!jid || !jid.endsWith('@g.us')) continue;
    const group = state.groups[jid];
    if (!group?.antiNuke) continue;
    const saved = recent.get(key.id);
    if (!saved || saved.jid !== jid) continue;

    addIncident(jid, 'MESSAGE_DELETED', { sender: saved.sender, text: saved.text });
    await alert(sock, jid,
      `🛡️ Anti-nuke: ${saved.sender?.split('@')[0] || 'A member'} deleted a message: ${saved.text}`);
  }
}

async function guard({ sock, jid, senderJid, args, config: cfg }) {
  if (!isOwner(senderJid || jid, cfg)) {
    await sock.sendMessage(jid, { text: 'Group guard controls are owner only.' });
    return;
  }

  // Allow targeting a group from the owner chat: !guard on <groupJid>
  const maybeJid = args.find(arg => arg.endsWith('@g.us'));
  const target = maybeJid || jid;
  if (!target.endsWith('@g.us')) {
    await sock.sendMessage(jid, { text: 'Use this command inside a group, or add the group JID as the last argument.' });
    return;
  }

  const action = String(args[0] || '').toLowerCase();
  const group = settings(target);

  if (action === 'on' || action === 'off') {
    const value = action === 'on';
    group.antiPrune = value;
    group.antiNuke = value;
    save();
    if (value) await takeSnapshot(sock, target);
    await sock.sendMessage(jid, {
      text: `Group guard is now ${value ? 'ON' : 'OFF'} for ${target}. ` +
        (value ? 'A safety snapshot was saved.' : '')
    });
    return;
  }

  if (action === 'antiprune') {
    const value = String(args[1] || '').toLowerCase() === 'on';
    group.antiPrune = value;
    save();
    await sock.sendMessage(jid, { text: `Anti-prune is now ${value ? 'ON' : 'OFF'} for ${target}.` });
    return;
  }

  if (action === 'antinuke') {
    const value = String(args[1] || '').toLowerCase() === 'on';
    group.antiNuke = value;
    save();
    if (value && !group.snapshot) await takeSnapshot(sock, target);
    await sock.sendMessage(jid, { text: `Anti-nuke is now ${value ? 'ON' : 'OFF'} for ${target}.` });
    return;
  }

  if (action === 'snapshot') {
    const ok = await takeSnapshot(sock, target);
    await sock.sendMessage(jid, { text: ok ? `Group snapshot saved for ${target}.` : 'Could not read that group. Is the bot still a member?' });
    return;
  }

  await sock.sendMessage(jid, {
    text: [
      `Group guard for ${target}:`,
      `• Anti-prune: ${group.antiPrune ? 'ON' : 'OFF'}`,
      `• Anti-nuke: ${group.antiNuke ? 'ON' : 'OFF'}`,
      `• Snapshot: ${group.snapshot ? 'saved ' + new Date(group.snapshot.updatedAt).toLocaleString() : 'none'}`,
      `• Incidents logged: ${group.incidents.length}`,
      group.incidents[0] ? `• Last: ${group.incidents[0].type} at ${new Date(group.incidents[0].at).toLocaleString()}` : '',
      '',
      'Usage: !guard on|off|snapshot|antiprune on|off|antinuke on|off'
    ].filter(Boolean).join('\n')
  });
}

module.exports = {
  guard,
  remember,
  onParticipantsUpdate,
  onGroupsUpdate,
  onMessageDelete,
  takeSnapshot
};
