/**
 * JAHIM BOT - pair server
 * GET /code?number=2547XXXXXXXX  ->  { "code": "ABCD-EFGH" }
 * After the user enters the code in WhatsApp > Linked devices > Link with phone number,
 * this server sends creds.json to that user's own WhatsApp chat ("Message yourself"),
 * then deletes the temporary session and disconnects.
 */
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const pino = require('pino');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
  DisconnectReason,
  jidNormalizedUser,
  delay,
} = require('@whiskeysockets/baileys');

const PORT = process.env.PORT || 3000;
const MAX_ACTIVE = Number(process.env.MAX_ACTIVE || 3);        // simultaneous pairing sessions
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 3 * 60 * 1000); // how long a code stays usable
const RATE_LIMIT_PER_MIN = Number(process.env.RATE_LIMIT_PER_MIN || 5);

const logger = pino({ level: 'silent' });
const app = express();
app.set('trust proxy', 1);

let active = 0;
const hits = new Map(); // ip -> [timestamps]

function rateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < 60000);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > RATE_LIMIT_PER_MIN;
}
setInterval(() => { // keep the map small
  const now = Date.now();
  for (const [ip, arr] of hits) if (!arr.some((t) => now - t < 60000)) hits.delete(ip);
}, 60000).unref();

const mask = (n) => n.slice(0, 4) + '****' + n.slice(-2);

function startSession(number) {
  return new Promise((resolve, reject) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pair-'));
    let finished = false;
    let codeIssued = false;
    let credsSent = false;
    let sock;
    let ttl;

    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(ttl);
      active = Math.max(0, active - 1);
      try { sock && sock.end(undefined); } catch {}
      setTimeout(() => fs.rmSync(dir, { recursive: true, force: true }), 2000);
    };
    ttl = setTimeout(() => {
      if (!codeIssued) reject(new Error('timeout'));
      finish();
    }, SESSION_TTL_MS);

    const connect = async () => {
      const { state, saveCreds } = await useMultiFileAuthState(dir);
      const { version } = await fetchLatestBaileysVersion();
      sock = makeWASocket({
        version,
        logger,
        printQRInTerminal: false,
        browser: Browsers.macOS('Safari'),
        markOnlineOnConnect: false,
        auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
      });
      sock.ev.on('creds.update', saveCreds);

      if (!sock.authState.creds.registered && !codeIssued) {
        codeIssued = true;
        await delay(1500);
        const code = await sock.requestPairingCode(number);
        resolve(code?.match(/.{1,4}/g)?.join('-') || code);
      }

      sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
        if (connection === 'open' && !credsSent) {
          credsSent = true;
          try {
            await delay(3000); // let creds.json flush
            const credsFile = path.join(dir, 'creds.json');
            const me = jidNormalizedUser(sock.user.id);
            await sock.sendMessage(me, {
              document: fs.readFileSync(credsFile),
              mimetype: 'application/json',
              fileName: 'creds.json',
            });
            await sock.sendMessage(me, {
              text: '*JAHIM BOT*\n\nUpload this creds.json into the bot\'s `session/` folder, then start the bot.\n\nNever share this file with anyone.',
            });
            await delay(2000);
          } catch (e) {
            console.error('send creds failed:', e.message);
          }
          finish();
        } else if (connection === 'close') {
          const status = lastDisconnect?.error?.output?.statusCode;
          if (finished) return;
          if (status === DisconnectReason.restartRequired) {
            connect().catch(() => finish()); // normal right after a successful pairing
          } else {
            finish();
          }
        }
      });
    };

    connect().catch((e) => { reject(e); finish(); });
  });
}

app.get('/health', (_req, res) => res.json({ ok: true, active }));

app.get('/code', async (req, res) => {
  const number = String(req.query.number || '').replace(/[^0-9]/g, '');
  if (number.length < 8 || number.length > 15) return res.status(400).json({ code: 'Invalid number' });
  if (rateLimited(req.ip)) return res.status(429).json({ code: 'Too many requests' });
  if (active >= MAX_ACTIVE) return res.status(503).json({ code: 'Service Unavailable' });

  active++;
  console.log(`[pair] request for ${mask(number)} (active: ${active})`);
  try {
    const code = await startSession(number);
    res.json({ code });
  } catch (e) {
    console.error('[pair] failed:', e.message);
    active = Math.max(0, active - 1);
    res.status(500).json({ code: 'Service Unavailable' });
  }
});

app.get('/', (_req, res) => {
  res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>JAHIM BOT - Pair code</title>
<style>body{font-family:system-ui,sans-serif;background:#0b0b0f;color:#eee;display:grid;place-items:center;min-height:100vh;margin:0}
main{max-width:360px;width:90%;text-align:center}input,button{width:100%;padding:12px;margin:6px 0;border-radius:8px;border:0;font-size:16px;box-sizing:border-box}
button{background:#25d366;font-weight:600;cursor:pointer}#out{font-size:28px;letter-spacing:3px;margin-top:16px}small{color:#999}</style>
<main><h2>JAHIM BOT</h2><p>Enter your WhatsApp number with country code, no + or spaces.</p>
<input id="n" placeholder="2547XXXXXXXX" inputmode="numeric"><button id="b">Get pair code</button><div id="out"></div>
<small>Then open WhatsApp &gt; Linked devices &gt; Link with phone number and enter the code. Your creds.json will arrive in your own chat.</small></main>
<script>b.onclick=async()=>{out.textContent='...';try{const r=await fetch('/code?number='+encodeURIComponent(n.value));const j=await r.json();out.textContent=j.code}catch(e){out.textContent='Error'}}</script>`);
});

app.listen(PORT, () => console.log('JAHIM BOT pair server on :' + PORT));
