require('dotenv').config();

const settings = {
  packname: 'JAHIM BOT',
  author: '‎',
  botName: "JAHIM BOT",
  botOwner: 'MR TONY', // Your name
  ownerNumber: process.env.OWNER_NUMBER || '254711745588', //Set your number here without + symbol, just add country code & number without any space
  giphyApiKey: 'qnl7ssQChTdPjsKta2Ax2LMaGXz303tq',
  commandMode: "public",
  timezone: process.env.TIMEZONE || 'Africa/Nairobi', // used for timestamps in antidelete reports
  maxStoreMessages: 20, 
  storeWriteInterval: 10000,
  description: "This is a bot for managing group commands and automating tasks.",
  version: "3.0.8",
  updateZipUrl: process.env.UPDATE_ZIP_URL || "", // set to your own repo zip, e.g. https://github.com/<you>/<repo>/archive/refs/heads/main.zip
  pairServerUrl: process.env.PAIR_SERVER_URL || "", // your own pair server, e.g. https://<yourdomain>.onrender.com
  // Media / Knight API (song, video, cards, etc.)
  knightApiUrl: process.env.KNIGHT_API_URL || 'https://knightbotapi.stream',
  knightApiKey: process.env.KNIGHT_API_KEY || 'knight',
  mediaApiUrl: process.env.MEDIA_API_URL || 'https://knightbotapi.stream',
  mediaApiKey: process.env.MEDIA_API_KEY || 'knight',
  princeApiUrl: process.env.PRINCE_API_URL || 'https://api.princetechn.com',
  princeApiKey: process.env.PRINCE_API_KEY || 'prince',
};

module.exports = settings;
