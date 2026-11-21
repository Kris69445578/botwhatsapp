# JAHIM BOT

A WhatsApp group-management and utility bot built on Baileys (Node.js). Credits: **MR TONY**.

## Features
Group tools (tagall, hidetag, kick, promote/demote, mute, warn, welcome/goodbye), anti-link / anti-bot / anti-delete, stickers, TTS, downloaders (song, video, TikTok, Instagram, Facebook, Twitter), AI chat, games and more. Send `.menu` to see every command.

## Setup
1. Install Node.js 18+ and clone your repo.
2. `cp .env.example .env` and fill it in (at least `OWNER_NUMBER`).
3. `npm install`
4. `npm start` and enter your WhatsApp number when asked; type the pairing code into WhatsApp > Linked devices > Link with phone number.

## Pair server (for `.pair`)
The `pair-server/` folder is a small service you deploy yourself (e.g. on Render). Deploy it, then set `PAIR_SERVER_URL` in the bot's `.env`.
- `GET /code?number=2547XXXXXXXX` returns `{ "code": "ABCD-EFGH" }`.
- After the user enters the code, their `creds.json` is sent to their own WhatsApp chat and the temporary session is deleted. Upload that file to the bot's `session/` folder.
- Tell your users plainly that this server briefly handles their linked-session credentials.

## Disclaimer
Unofficial; not affiliated with or endorsed by WhatsApp. Using bots can get an account banned. Do not use it for spam or anything illegal; use at your own risk.

## License and credits
Released under the ISC License (see `LICENSE`).
Based on Knight Bot by Professor (Copyright (c) 2024). Built with [Baileys](https://github.com/WhiskeySockets/Baileys).
Modifications Copyright (c) 2026 MR TONY.
