const isAdmin = require('../lib/isAdmin');

async function kickCommand(sock, chatId, senderId, mentionedJids, message) {
    const fromMe = !!message.key.fromMe;

    const { isSenderAdmin, isBotAdmin } = await isAdmin(sock, chatId, senderId);

    if (!isBotAdmin) {
        await sock.sendMessage(chatId, { text: 'Please make the bot an admin first.' }, { quoted: message });
        return;
    }

    // The bot owner (messages from the bot's own account) may always use the command
    if (!fromMe && !isSenderAdmin) {
        await sock.sendMessage(chatId, { text: 'Only group admins can use the kick command.' }, { quoted: message });
        return;
    }

    const ctx = message.message?.extendedTextMessage?.contextInfo;
    let usersToKick = [];

    if (mentionedJids && mentionedJids.length > 0) {
        usersToKick = mentionedJids;
    } else if (ctx?.participant) {
        usersToKick = [ctx.participant];
    }

    if (usersToKick.length === 0) {
        await sock.sendMessage(chatId, {
            text: 'Please mention the user or reply to their message to kick!'
        }, { quoted: message });
        return;
    }

    try {
        const targets = await isAdmin.resolveTargets(sock, chatId, usersToKick);

        if (targets.some(t => t.isBot)) {
            await sock.sendMessage(chatId, { text: "I can't kick myself🤖" }, { quoted: message });
            return;
        }

        const notInGroup = targets.filter(t => !t.participantId);
        const valid = targets.filter(t => t.participantId);

        if (valid.length === 0) {
            await sock.sendMessage(chatId, {
                text: 'That user is not in this group.',
                mentions: notInGroup.map(t => t.jid)
            }, { quoted: message });
            return;
        }

        const result = await sock.groupParticipantsUpdate(chatId, valid.map(t => t.participantId), 'remove');

        // Baileys returns one status entry per participant ("200" = success)
        const statusOf = (t) => {
            const entry = Array.isArray(result)
                ? result.find(r => r.jid === t.participantId || String(r.jid || '').split('@')[0] === t.participantId.split('@')[0])
                : null;
            return entry ? String(entry.status) : '200';
        };
        const kicked = valid.filter(t => statusOf(t) === '200');
        const failed = valid.filter(t => statusOf(t) !== '200');

        if (kicked.length) {
            await sock.sendMessage(chatId, {
                text: `${kicked.map(t => `@${t.jid.split('@')[0]}`).join(', ')} has been kicked successfully!`,
                mentions: kicked.map(t => t.jid)
            });
        }
        if (failed.length) {
            await sock.sendMessage(chatId, {
                text: `Could not remove ${failed.map(t => `@${t.jid.split('@')[0]}`).join(', ')} (WhatsApp refused — the group creator cannot be removed).`,
                mentions: failed.map(t => t.jid)
            });
        }
    } catch (error) {
        console.error('Error in kick command:', error);
        await sock.sendMessage(chatId, { text: 'Failed to kick user(s)!' });
    }
}

module.exports = kickCommand;
