// lib/isAdmin.js
//
// Admin detection that works with both phone-number (PN) and LID addressed groups.
//
// WhatsApp now identifies group members by LID (e.g. 57707683905562@lid) and often hides
// the phone number, while sock.user.id is still a phone-number JID with a device suffix
// (254758982712:5@s.whatsapp.net). Comparing raw strings therefore fails, which made the
// bot think it was never an admin. Here every identity is reduced to its bare digits and
// expanded with the PN <-> LID mapping (Baileys signal repository + session mapping files)
// before comparing.

const jidHelper = require('./jidHelper');

const isLidJid = (jid) => /@(hosted\.)?lid$/.test(String(jid || ''));

// "12345:7@s.whatsapp.net" -> "12345"
const digitsOf = (jid) => {
    if (!jid) return '';
    return String(jid).split('@')[0].split(':')[0].replace(/\D/g, '');
};

async function lidToPn(sock, lidDigits) {
    try {
        const repo = sock?.signalRepository?.lidMapping;
        if (repo?.getPNForLID) {
            const pn = await repo.getPNForLID(`${lidDigits}@lid`);
            const d = digitsOf(pn);
            if (d) return d;
        }
    } catch { /* ignore */ }
    try {
        const d = digitsOf(jidHelper.getLidMappingValue(lidDigits, 'lidToPn'));
        if (d) return d;
    } catch { /* ignore */ }
    return '';
}

async function pnToLid(sock, pnDigits) {
    try {
        const repo = sock?.signalRepository?.lidMapping;
        if (repo?.getLIDForPN) {
            const lid = await repo.getLIDForPN(`${pnDigits}@s.whatsapp.net`);
            const d = digitsOf(lid);
            if (d) return d;
        }
    } catch { /* ignore */ }
    try {
        const d = digitsOf(jidHelper.getLidMappingValue(pnDigits, 'pnToLid'));
        if (d) return d;
    } catch { /* ignore */ }
    return '';
}

// Turn a list of JIDs into the set of every digit-string that identifies the same person
async function expandIds(sock, jids) {
    const out = new Set();
    for (const jid of jids) {
        const d = digitsOf(jid);
        if (!d) continue;
        out.add(d);
        const counterpart = isLidJid(jid) ? await lidToPn(sock, d) : await pnToLid(sock, d);
        if (counterpart) out.add(counterpart);
    }
    return out;
}

const intersects = (a, b) => {
    for (const x of a) if (b.has(x)) return true;
    return false;
};

const warnedAt = new Map();
function warnOnce(chatId, text) {
    const now = Date.now();
    if (now - (warnedAt.get(chatId) || 0) < 60000) return;
    warnedAt.set(chatId, now);
    console.warn(text);
}

function botJids(sock) {
    const me = sock?.authState?.creds?.me || {};
    return [sock?.user?.id, sock?.user?.lid, me.id, me.lid].filter(Boolean);
}

const participantJids = (p) => [p.id, p.lid, p.phoneNumber, p.jid, p.userJid].filter(Boolean);
const flaggedAdmin = (p) =>
    p.admin === 'admin' || p.admin === 'superadmin' || p.isAdmin === true || p.isSuperAdmin === true;

async function isAdmin(sock, chatId, senderId) {
    try {
        const metadata = await sock.groupMetadata(chatId);
        const participants = metadata?.participants || [];

        const botIds = await expandIds(sock, botJids(sock));

        // Messages sent from the bot's own account can arrive without a participant,
        // in which case senderId is the group JID itself. The sender is then the bot.
        const senderIsBot = !senderId || String(senderId).endsWith('@g.us');
        const senderIds = senderIsBot ? botIds : await expandIds(sock, [senderId]);

        let isBotAdmin = false;
        let isSenderAdmin = false;
        const adminSummary = [];

        for (const p of participants) {
            if (!flaggedAdmin(p)) continue;

            const pIds = await expandIds(sock, participantJids(p));
            adminSummary.push([...pIds].join('/'));

            if (!isBotAdmin && intersects(pIds, botIds)) isBotAdmin = true;
            if (!isSenderAdmin && intersects(pIds, senderIds)) isSenderAdmin = true;
        }

        if (!isBotAdmin) {
            warnOnce(
                chatId,
                `⚠️ [isAdmin] Bot not found among admins of ${chatId}. ` +
                `bot ids: ${[...botIds].join('/') || 'none'} | admin ids: ${adminSummary.join(' , ') || 'none'}`
            );
        }

        return { isSenderAdmin, isBotAdmin };
    } catch (err) {
        console.error('❌ Error in isAdmin:', err?.message || err);
        return { isSenderAdmin: false, isBotAdmin: false };
    }
}

/**
 * Convert mentioned / replied JIDs into the exact participant ids used by the group,
 * so groupParticipantsUpdate (kick / promote / demote) accepts them.
 * Returns [{ jid, participantId, isBot, isAdmin }] — participantId is null if not in the group.
 */
async function resolveTargets(sock, chatId, jids) {
    const metadata = await sock.groupMetadata(chatId);
    const participants = metadata?.participants || [];
    const botIds = await expandIds(sock, botJids(sock));

    const results = [];
    for (const jid of jids) {
        const targetIds = await expandIds(sock, [jid]);
        let match = null;
        for (const p of participants) {
            const pIds = await expandIds(sock, participantJids(p));
            if (intersects(pIds, targetIds)) { match = { p, pIds }; break; }
        }
        results.push({
            jid,
            participantId: match ? match.p.id : null,
            isBot: intersects(targetIds, botIds) || (match ? intersects(match.pIds, botIds) : false),
            isAdmin: match ? flaggedAdmin(match.p) : false,
        });
    }
    return results;
}

module.exports = isAdmin;
module.exports.isAdmin = isAdmin; // lets `const { isAdmin } = require(...)` work too
module.exports.resolveTargets = resolveTargets;
module.exports.digitsOf = digitsOf;
module.exports.expandIds = expandIds;
