const fs = require('fs');
const path = require('path');
const { downloadContentFromMessage, jidNormalizedUser } = require('@whiskeysockets/baileys');
const isOwnerOrSudo = require('../lib/isOwner');
const settings = require('../settings');

let lidToMention = null;
try { ({ lidToMention } = require('../lib/jidHelper')); } catch { /* optional */ }

const CONFIG_PATH = path.join(__dirname, '../data/antidelete.json');
const TEMP_MEDIA_DIR = path.join(__dirname, '../tmp');
const MAX_STORED = 500;                    // max messages kept in memory
const MAX_AGE_MS = 24 * 60 * 60 * 1000;    // forget messages after 24h
const TIMEZONE = settings.timezone || 'Africa/Nairobi';

const messageStore = new Map();            // messageId -> stored message info
const reported = new Set();                // revoked ids already reported (dedupe)

if (!fs.existsSync(TEMP_MEDIA_DIR)) fs.mkdirSync(TEMP_MEDIA_DIR, { recursive: true });

// ---------- config ----------
function loadAntideleteConfig() {
    try {
        if (!fs.existsSync(CONFIG_PATH)) return { enabled: false };
        return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch {
        return { enabled: false };
    }
}

function saveAntideleteConfig(config) {
    try {
        fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    } catch (err) {
        console.error('Antidelete config save error:', err);
    }
}

// ---------- storage housekeeping ----------
function dropEntry(id) {
    const entry = messageStore.get(id);
    if (entry?.mediaPath) {
        try { fs.unlinkSync(entry.mediaPath); } catch { /* already gone */ }
    }
    messageStore.delete(id);
}

function pruneStore() {
    const now = Date.now();
    for (const [id, entry] of messageStore) {
        if (now - entry.at > MAX_AGE_MS) dropEntry(id);
    }
    while (messageStore.size > MAX_STORED) {
        dropEntry(messageStore.keys().next().value);
    }
}
setInterval(pruneStore, 10 * 60 * 1000).unref?.();

// ---------- helpers ----------
const WRAPPERS = ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension', 'documentWithCaptionMessage', 'editedMessage'];

function unwrapContent(content) {
    let cur = content;
    let viewOnce = false;
    for (let i = 0; i < 6 && cur; i++) {
        const key = WRAPPERS.find(k => cur[k]?.message);
        if (!key) break;
        if (key.startsWith('viewOnce')) viewOnce = true;
        cur = cur[key].message;
    }
    return { content: cur, viewOnce };
}

async function toBuffer(stream) {
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return Buffer.concat(chunks);
}

async function saveMedia(node, type, messageId, ext) {
    const buffer = await toBuffer(await downloadContentFromMessage(node, type));
    const filePath = path.join(TEMP_MEDIA_DIR, `${messageId}.${ext}`);
    await fs.promises.writeFile(filePath, buffer);
    return filePath;
}

function ownerJid(sock) {
    return jidNormalizedUser(sock.user.id);
}

function mentionFor(...candidates) {
    const list = candidates.filter(Boolean);
    if (lidToMention) {
        try {
            const m = lidToMention(list);
            if (m?.jid) return { text: m.text, jid: m.jid };
        } catch { /* fall through */ }
    }
    const jid = list[0] || '';
    return { text: `@${jid.split('@')[0].split(':')[0]}`, jid };
}

function isRevokeMessage(message) {
    const proto = message?.message?.protocolMessage;
    if (!proto) return false;
    return proto.type === 0 || proto.type === 'REVOKE';
}

// ---------- command ----------
async function handleAntideleteCommand(sock, chatId, message, match) {
    const senderId = message.key.participant || message.key.remoteJid;
    const isOwner = await isOwnerOrSudo(senderId, sock, chatId);

    if (!message.key.fromMe && !isOwner) {
        return sock.sendMessage(chatId, { text: '*Only the bot owner can use this command.*' }, { quoted: message });
    }

    const config = loadAntideleteConfig();
    const arg = String(match || '').trim().toLowerCase();

    if (!arg || arg === 'status') {
        return sock.sendMessage(chatId, {
            text: `*ANTIDELETE SETUP*\n\nCurrent Status: ${config.enabled ? '✅ Enabled' : '❌ Disabled'}\n\n*.antidelete on* - Enable\n*.antidelete off* - Disable\n\nDeleted messages are sent to your own chat (saved messages).`
        }, { quoted: message });
    }

    if (arg === 'on' || arg === 'enable') {
        config.enabled = true;
    } else if (arg === 'off' || arg === 'disable') {
        config.enabled = false;
    } else {
        return sock.sendMessage(chatId, { text: '*Invalid command. Use .antidelete to see usage.*' }, { quoted: message });
    }

    saveAntideleteConfig(config);
    return sock.sendMessage(chatId, {
        text: `*Antidelete ${config.enabled ? 'enabled ✅' : 'disabled ❌'}*`
    }, { quoted: message });
}

// ---------- store incoming messages ----------
async function storeMessage(sock, message) {
    try {
        const config = loadAntideleteConfig();
        if (!config.enabled) return;

        const messageId = message?.key?.id;
        if (!messageId || !message.message) return;
        if (message.key.fromMe) return;                        // owner's own messages are never reported
        if (message.key.remoteJid === 'status@broadcast') return;
        if (isRevokeMessage(message)) return;

        const { content: body, viewOnce } = unwrapContent(message.message);
        if (!body) return;

        const sender = message.key.participant || message.key.remoteJid;
        const senderAlt = message.key.participantAlt || message.key.remoteJidAlt || null;

        let text = '';
        let mediaType = '';
        let mediaPath = '';
        let mediaMime = '';
        let ptt = false;
        let fileName = '';

        if (body.conversation) {
            text = body.conversation;
        } else if (body.extendedTextMessage?.text) {
            text = body.extendedTextMessage.text;
        } else if (body.imageMessage) {
            mediaType = 'image';
            text = body.imageMessage.caption || '';
            mediaPath = await saveMedia(body.imageMessage, 'image', messageId, 'jpg');
        } else if (body.videoMessage) {
            mediaType = 'video';
            text = body.videoMessage.caption || '';
            mediaPath = await saveMedia(body.videoMessage, 'video', messageId, 'mp4');
        } else if (body.stickerMessage) {
            mediaType = 'sticker';
            mediaPath = await saveMedia(body.stickerMessage, 'sticker', messageId, 'webp');
        } else if (body.audioMessage) {
            mediaType = 'audio';
            mediaMime = body.audioMessage.mimetype || 'audio/ogg; codecs=opus';
            ptt = !!body.audioMessage.ptt;
            const ext = mediaMime.includes('mpeg') ? 'mp3' : 'ogg';
            mediaPath = await saveMedia(body.audioMessage, 'audio', messageId, ext);
        } else if (body.documentMessage) {
            mediaType = 'document';
            text = body.documentMessage.caption || '';
            mediaMime = body.documentMessage.mimetype || 'application/octet-stream';
            fileName = body.documentMessage.fileName || `${messageId}.bin`;
            mediaPath = await saveMedia(body.documentMessage, 'document', messageId, 'bin');
        } else {
            return;                                                // contacts, locations, polls… not tracked
        }

        messageStore.set(messageId, {
            at: Date.now(),
            content: text,
            mediaType,
            mediaPath,
            mediaMime,
            ptt,
            fileName,
            viewOnce,
            sender,
            senderAlt,
            pushName: message.pushName || '',
            group: message.key.remoteJid.endsWith('@g.us') ? message.key.remoteJid : null,
            chat: message.key.remoteJid,
        });

        // Anti-ViewOnce: forward to the owner right away
        if (viewOnce && (mediaType === 'image' || mediaType === 'video') && mediaPath) {
            try {
                const who = mentionFor(sender, senderAlt);
                const caption = `*Anti-ViewOnce ${mediaType}*\nFrom: ${who.text}${text ? `\n\n${text}` : ''}`;
                const payload = mediaType === 'image'
                    ? { image: { url: mediaPath }, caption, mentions: who.jid ? [who.jid] : [] }
                    : { video: { url: mediaPath }, caption, mentions: who.jid ? [who.jid] : [] };
                await sock.sendMessage(ownerJid(sock), payload);
            } catch (e) {
                console.error('Anti-ViewOnce forward error:', e?.message || e);
            }
        }

        if (messageStore.size > MAX_STORED) pruneStore();
    } catch (err) {
        console.error('storeMessage error:', err?.message || err);
    }
}

// ---------- report a deleted message ----------
async function reportDeleted(sock, messageId, deletedByJid) {
    const original = messageStore.get(messageId);
    if (!original) return false;
    if (reported.has(messageId)) return true;
    reported.add(messageId);
    if (reported.size > 2000) reported.delete(reported.values().next().value);

    const owner = ownerJid(sock);
    const sender = mentionFor(original.sender, original.senderAlt);
    const deleter = mentionFor(deletedByJid || original.sender);

    let groupName = '';
    if (original.group) {
        try { groupName = (await sock.groupMetadata(original.group)).subject; } catch { /* ignore */ }
    }

    const time = new Date().toLocaleString('en-US', {
        timeZone: TIMEZONE,
        hour12: true, hour: '2-digit', minute: '2-digit', second: '2-digit',
        day: '2-digit', month: '2-digit', year: 'numeric'
    });

    let report = `*🔰 ANTIDELETE REPORT 🔰*\n\n` +
        `*🗑️ Deleted By:* ${deleter.text}\n` +
        `*👤 Sender:* ${sender.text}${original.pushName ? ` (${original.pushName})` : ''}\n` +
        `*🕒 Time:* ${time}\n`;
    if (groupName) report += `*👥 Group:* ${groupName}\n`;
    if (original.content) report += `\n*💬 Deleted Message:*\n${original.content}`;
    else if (!original.mediaType) report += `\n*💬 Deleted Message:* (empty)`;

    const mentions = [...new Set([deleter.jid, sender.jid].filter(Boolean))];
    await sock.sendMessage(owner, { text: report, mentions });

    if (original.mediaType && original.mediaPath && fs.existsSync(original.mediaPath)) {
        const caption = `*Deleted ${original.mediaType}*\nFrom: ${sender.text}`;
        const opts = { caption, mentions: sender.jid ? [sender.jid] : [] };
        const file = { url: original.mediaPath };

        try {
            switch (original.mediaType) {
                case 'image':
                    await sock.sendMessage(owner, { image: file, ...opts });
                    break;
                case 'video':
                    await sock.sendMessage(owner, { video: file, ...opts });
                    break;
                case 'sticker':
                    await sock.sendMessage(owner, { sticker: file });
                    break;
                case 'audio':
                    await sock.sendMessage(owner, { audio: file, mimetype: original.mediaMime || 'audio/ogg; codecs=opus', ptt: original.ptt });
                    break;
                case 'document':
                    await sock.sendMessage(owner, { document: file, mimetype: original.mediaMime, fileName: original.fileName || 'file', ...opts });
                    break;
            }
        } catch (err) {
            await sock.sendMessage(owner, { text: `⚠️ Error sending media: ${err.message}` });
        }
    }

    dropEntry(messageId);
    return true;
}

// ---------- deletion via protocolMessage (messages.upsert) ----------
async function handleMessageRevocation(sock, revocationMessage) {
    try {
        const config = loadAntideleteConfig();
        if (!config.enabled) return;
        if (revocationMessage.key?.fromMe) return;             // you deleted it yourself

        const messageId = revocationMessage.message?.protocolMessage?.key?.id;
        if (!messageId) return;

        const deletedBy = revocationMessage.participant ||
            revocationMessage.key.participant ||
            revocationMessage.key.remoteJid;

        await reportDeleted(sock, messageId, deletedBy);
    } catch (err) {
        console.error('handleMessageRevocation error:', err?.message || err);
    }
}

// ---------- deletion via messages.update (fallback path used by newer Baileys) ----------
async function handleMessageUpdates(sock, updates) {
    try {
        const config = loadAntideleteConfig();
        if (!config.enabled) return;

        for (const { key, update } of updates || []) {
            if (!key?.id || key.fromMe) continue;
            const revoked = update?.message === null ||
                update?.messageStubType === 1 ||
                update?.messageStubType === 'REVOKE';
            if (!revoked) continue;
            await reportDeleted(sock, key.id, key.participant || key.remoteJid);
        }
    } catch (err) {
        console.error('handleMessageUpdates error:', err?.message || err);
    }
}

module.exports = {
    handleAntideleteCommand,
    handleMessageRevocation,
    handleMessageUpdates,
    storeMessage,
    isRevokeMessage,
};
