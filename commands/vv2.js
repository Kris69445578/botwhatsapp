const { resolveViewOnce, buildPayload, jidNormalizedUser } = require('../lib/viewOnce');

// Where to deliver the media: the bot's own chat if the owner ran it, otherwise the sender's DM
function dmJid(sock, message, senderId) {
    if (message.key.fromMe) return jidNormalizedUser(sock.user.id);
    let jid = senderId || message.key.participant || '';
    if (!jid || String(jid).endsWith('@g.us')) jid = message.key.participant || '';
    return jid ? jidNormalizedUser(jid) : '';
}

// .vv2 — same as .vv but the media is sent to your DM instead of the chat
async function vv2Command(sock, chatId, message, senderId) {
    const fail = (text) => sock.sendMessage(chatId, { text }, { quoted: message });

    try {
        const dest = dmJid(sock, message, senderId);
        if (!dest || dest.endsWith('@g.us') || dest.endsWith('@broadcast')) {
            return fail('❌ Could not find your DM.');
        }

        const result = await resolveViewOnce(sock, message);
        if (result.error) return fail(result.error);

        await sock.sendMessage(dest, buildPayload(result));

        if (dest !== chatId) {
            await sock.sendMessage(chatId, { text: '✅ Sent to your DM.' }, { quoted: message });
        }
    } catch (error) {
        console.error('[vv2]', error?.message || error);
        await fail('❌ Error processing view-once message: ' + (error?.message || 'Unknown error'));
    }
}

module.exports = vv2Command;
