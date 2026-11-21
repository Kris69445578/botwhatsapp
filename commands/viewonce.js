const { resolveViewOnce, buildPayload } = require('../lib/viewOnce');

// .vv — reply to a view-once image / video / voice note and the bot re-sends it here
async function viewonceCommand(sock, chatId, message) {
    try {
        const result = await resolveViewOnce(sock, message);
        if (result.error) {
            await sock.sendMessage(chatId, { text: result.error }, { quoted: message });
            return;
        }
        await sock.sendMessage(chatId, buildPayload(result), { quoted: message });
    } catch (error) {
        console.error('[vv]', error?.message || error);
        await sock.sendMessage(chatId, { text: '❌ Failed to reveal the view-once message: ' + (error?.message || 'unknown error') }, { quoted: message });
    }
}

module.exports = viewonceCommand;
