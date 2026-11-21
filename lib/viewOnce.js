// lib/viewOnce.js
// Shared helpers for .vv / .vv2 (reveal view-once media).
//
// Why this exists: when you reply to a view-once message, WhatsApp usually delivers only a
// stripped "stub" of it in contextInfo.quotedMessage (no media key), so downloading from the
// quote throws. The full original message is kept in a small cache (filled as messages arrive)
// and in the bot's message store, and is used first.

const { downloadContentFromMessage, downloadMediaMessage, jidNormalizedUser } = require('@whiskeysockets/baileys');

let store = null;
try { store = require('./lightweight_store'); } catch { /* optional */ }

const CACHE_MAX = 300;
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const cache = new Map(); // messageId -> { message, at }

const WRAPPERS = [
    'ephemeralMessage',
    'viewOnceMessage',
    'viewOnceMessageV2',
    'viewOnceMessageV2Extension',
    'documentWithCaptionMessage',
    'editedMessage',
];

const MEDIA_KEYS = [
    ['imageMessage', 'image'],
    ['videoMessage', 'video'],
    ['audioMessage', 'audio'],
];

function unwrap(content) {
    let cur = content;
    let wasViewOnce = false;
    for (let i = 0; i < 6 && cur; i++) {
        const key = WRAPPERS.find(k => cur[k]?.message);
        if (!key) break;
        if (key.startsWith('viewOnce')) wasViewOnce = true;
        cur = cur[key].message;
    }
    return { content: cur, wasViewOnce };
}

function mediaOf(content) {
    if (!content) return null;
    for (const [key, type] of MEDIA_KEYS) {
        if (content[key]) return { node: content[key], key, type };
    }
    return null;
}

function inspect(messageContent) {
    const { content, wasViewOnce } = unwrap(messageContent);
    const media = mediaOf(content);
    return { content, media, viewOnce: !!(wasViewOnce || media?.node?.viewOnce) };
}

/** Remember a message if it is view-once, so .vv can find the full original later. */
function cacheViewOnce(message) {
    try {
        if (!message?.message || !message.key?.id) return;
        const info = inspect(message.message);
        if (!info.media || !info.viewOnce) return;

        cache.set(message.key.id, { message, at: Date.now() });

        if (cache.size > CACHE_MAX) {
            const now = Date.now();
            for (const [id, v] of cache) {
                if (now - v.at > CACHE_TTL_MS || cache.size > CACHE_MAX) cache.delete(id);
                if (cache.size <= CACHE_MAX) break;
            }
        }
    } catch { /* never break message handling */ }
}

function findOriginal(chatId, stanzaId) {
    if (!stanzaId) return null;
    const cached = cache.get(stanzaId);
    if (cached) return { message: cached.message, fromCache: true };

    if (store?.messages) {
        const lists = [store.messages[chatId], ...Object.values(store.messages)];
        for (const list of lists) {
            if (!Array.isArray(list)) continue;
            const found = list.find(m => m?.key?.id === stanzaId);
            if (found) return { message: found, fromCache: false };
        }
    }
    return null;
}

// Messages reloaded from baileys_store.json have Buffers as { type: 'Buffer', data: [...] }
function revive(node) {
    for (const field of ['mediaKey', 'fileSha256', 'fileEncSha256']) {
        const v = node[field];
        if (!v || v instanceof Uint8Array) continue;
        if (v.type === 'Buffer' && Array.isArray(v.data)) node[field] = Buffer.from(v.data);
        else if (typeof v === 'object') node[field] = Buffer.from(Object.values(v));
    }
    return node;
}

async function streamToBuffer(stream) {
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return Buffer.concat(chunks);
}

function getContextInfo(message) {
    const { content } = unwrap(message.message);
    if (!content) return null;
    for (const v of Object.values(content)) {
        if (v && typeof v === 'object' && v.contextInfo) return v.contextInfo;
    }
    return null;
}

/**
 * Resolve and download the view-once media the command message is replying to.
 * Returns { buffer, type, caption, mimetype } or { error } (error is a user-facing string).
 */
async function resolveViewOnce(sock, message) {
    const chatId = message.key.remoteJid;
    const ctx = getContextInfo(message);

    if (!ctx?.quotedMessage) {
        return { error: '🗑️ Reply to a *view-once* image, video or voice note with this command.' };
    }

    const quoted = inspect(ctx.quotedMessage);
    const original = findOriginal(chatId, ctx.stanzaId);
    const originalInfo = original ? inspect(original.message.message) : null;

    const looksViewOnce = quoted.viewOnce || originalInfo?.viewOnce || !!original?.fromCache;

    if (!quoted.media && !originalInfo?.media) {
        return { error: '❌ Please reply to a view-once image, video or voice note.' };
    }
    if (!looksViewOnce) {
        return { error: '❌ That message is not a view-once message.' };
    }

    const attempts = [];

    // 1) Full original message (has the media key) — most reliable
    if (original && originalInfo?.media) {
        attempts.push(async () => {
            const buffer = await downloadMediaMessage(
                original.message,
                'buffer',
                {},
                { reuploadRequest: sock.updateMediaMessage?.bind(sock) }
            );
            return { buffer, media: originalInfo.media };
        });
        attempts.push(async () => {
            const media = originalInfo.media;
            const buffer = await streamToBuffer(await downloadContentFromMessage(revive(media.node), media.type));
            return { buffer, media };
        });
    }

    // 2) The quoted payload itself
    if (quoted.media) {
        attempts.push(async () => {
            const media = quoted.media;
            const buffer = await streamToBuffer(await downloadContentFromMessage(revive(media.node), media.type));
            return { buffer, media };
        });
    }

    let lastError = null;
    for (const attempt of attempts) {
        try {
            const { buffer, media } = await attempt();
            if (buffer && buffer.length) {
                return {
                    buffer,
                    type: media.type,
                    caption: media.node.caption || '',
                    mimetype: media.node.mimetype || '',
                };
            }
        } catch (err) {
            lastError = err;
        }
    }

    console.error('[viewOnce] download failed:', lastError?.message || lastError);
    return {
        error: '❌ Could not fetch that view-once media. It may already have been opened/expired, ' +
            'or it arrived before the bot saw it. Try again on a *new* view-once message.',
    };
}

function buildPayload(result) {
    if (result.type === 'video') {
        return { video: result.buffer, caption: result.caption, mimetype: 'video/mp4' };
    }
    if (result.type === 'audio') {
        return { audio: result.buffer, mimetype: result.mimetype || 'audio/ogg; codecs=opus', ptt: true };
    }
    return { image: result.buffer, caption: result.caption };
}

module.exports = { cacheViewOnce, resolveViewOnce, buildPayload, jidNormalizedUser };
