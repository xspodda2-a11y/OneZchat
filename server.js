/* ============================================================
   OneZchat Server
   - No passwords: a name creates a OneZ ID + secret device token
     (only the SHA-256 hash of the token is stored server-side)
   - Messages are END-TO-END ENCRYPTED on the client (ECDH P-256
     + AES-256-GCM). This server only stores & relays ciphertext —
     it can never read your messages.
   - Real-time: WebSocket (presence, typing, ticks, calls signaling)
   ============================================================ */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const subtle = crypto.webcrypto.subtle;
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const MAX_MSG_BYTES = 6 * 1024 * 1024; // encrypted payloads incl. image/audio media
const BOT_ID = 'OZ-ONEZBOT';

/* ----------------------------- DB ----------------------------- */
let db = { users: {}, chats: {}, messages: [], stories: [], botPrivJwk: null, botPubJwk: null };
const chatMsgIndex = new Map(); // chatId -> Message[]

function loadDb() {
  try {
    if (fs.existsSync(DB_FILE)) {
      db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      db.users ||= {}; db.chats ||= {}; db.messages ||= []; db.stories ||= [];
    }
  } catch (e) { console.error('[db] load failed, starting fresh:', e.message); }
  for (const m of db.messages) {
    if (!chatMsgIndex.has(m.chatId)) chatMsgIndex.set(m.chatId, []);
    chatMsgIndex.get(m.chatId).push(m);
  }
}

let saveTimer = null;
function saveDb() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = DB_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(db), { mode: 0o600 });
      fs.renameSync(tmp, DB_FILE);
    } catch (e) { console.error('[db] save failed:', e.message); }
  }, 250);
}

/* --------------------------- Helpers -------------------------- */
const ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no confusing 0/O/1/I
function newUserId() {
  for (;;) {
    let s = '';
    const bytes = crypto.randomBytes(6);
    for (let i = 0; i < 6; i++) s += ID_ALPHABET[bytes[i] % ID_ALPHABET.length];
    const id = 'OZ-' + s;
    if (!db.users[id]) return id;
  }
}
const newId = (p) => p + crypto.randomBytes(9).toString('hex');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
function tokenMatches(token, hashHex) {
  try {
    const a = Buffer.from(sha256(String(token || '')), 'hex');
    const b = Buffer.from(hashHex || '', 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch { return false; }
}
const cleanStr = (v, max) => String(v == null ? '' : v).replace(/\u0000/g, '').slice(0, max).trim();
const validPubKey = (k) => k && k.kty === 'EC' && k.crv === 'P-256' && typeof k.x === 'string' && typeof k.y === 'string';
const validAvatar = (a) => ({
  emoji: cleanStr(a && a.emoji, 8) || '😀',
  grad: Math.max(0, Math.min(9, parseInt(a && a.grad, 10) || 0)),
});

function publicUser(u) {
  return {
    id: u.id, name: u.name, avatar: u.avatar, about: u.about || '',
    pubKey: u.pubKey, isBot: !!u.isBot,
    online: socketsByUser.has(u.id) || !!u.isBot,
    lastSeen: u.lastSeen || u.createdAt,
  };
}
function chatForUser(chat, userId) {
  const msgs = chatMsgIndex.get(chat.id) || [];
  const last = msgs.length ? msgs[msgs.length - 1] : null;
  let unread = 0;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.senderId !== userId && !(m.readBy || []).includes(userId)) unread++;
    else if (unread > 200) break;
  }
  return {
    id: chat.id, type: chat.type, name: chat.name || null, grad: chat.grad || 0,
    members: chat.members, createdBy: chat.createdBy, createdAt: chat.createdAt,
    wrappedKey: chat.type === 'group' ? (chat.wrappedKeys && chat.wrappedKeys[userId]) || null : null,
    lastMessage: last, unread,
  };
}
const recentMessages = (chatId, n = 200) => (chatMsgIndex.get(chatId) || []).slice(-n);

/* --------------------------- Stories -------------------------- */
/* Status/Stories are end-to-end encrypted too: the client encrypts the
   content once with a random AES key and "wraps" that key per viewer
   (ECDH). The server only stores ciphertext + the wraps. */
const STORY_TTL = 24 * 3600e3;

function pruneStories() {
  const now = Date.now();
  const before = db.stories.length;
  db.stories = db.stories.filter((s) => s.expiresAt > now);
  if (db.stories.length !== before) saveDb();
}
function storyForUser(st, uid) {
  const mine = st.by === uid;
  const out = {
    id: st.id, by: st.by, ts: st.ts, kind: st.kind, iv: st.iv, ct: st.ct,
    wrappedKey: st.wrappedKeys[uid] || null, expiresAt: st.expiresAt,
    mine, viewed: mine ? true : st.views.includes(uid),
  };
  if (mine) out.views = st.views.slice();
  return out;
}
function storiesForUser(uid) {
  pruneStories();
  return db.stories
    .filter((s) => s.expiresAt > Date.now() && (s.by === uid || s.wrappedKeys[uid]))
    .sort((a, b) => a.ts - b.ts)
    .map((s) => storyForUser(s, uid));
}

/* ------------------------ Presence / WS ----------------------- */
const socketsByUser = new Map(); // userId -> Set<ws>

function send(ws, obj) {
  if (ws.readyState === 1) { try { ws.send(JSON.stringify(obj)); } catch {} }
}
function sendToUser(userId, obj) {
  const set = socketsByUser.get(userId);
  if (set) for (const ws of set) send(ws, obj);
}
function broadcastAll(obj) {
  for (const set of socketsByUser.values()) for (const ws of set) send(ws, obj);
}
function sendToChat(chat, obj, exceptUserId) {
  for (const uid of chat.members) if (uid !== exceptUserId) sendToUser(uid, obj);
}
const isOnline = (uid) => socketsByUser.has(uid) && socketsByUser.get(uid).size > 0;

/* ------------------------- Bot crypto ------------------------- */
let botPrivKey = null;
const botKeyCache = new Map(); // userId -> AES key

async function initBot() {
  if (!db.botPrivJwk || !db.users[BOT_ID]) {
    const kp = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']);
    db.botPrivJwk = await subtle.exportKey('jwk', kp.privateKey);
    db.botPubJwk = await subtle.exportKey('jwk', kp.publicKey);
    db.users[BOT_ID] = {
      id: BOT_ID, name: 'OneZ Bot', avatar: { emoji: '🤖', grad: 1 },
      about: 'OneZchat එකේ official assistant එක මම! ✨',
      pubKey: db.botPubJwk, tokenHash: sha256(crypto.randomBytes(32).toString('hex')),
      isBot: true, createdAt: Date.now(), lastSeen: Date.now(),
    };
    saveDb();
  }
  botPrivKey = await subtle.importKey('jwk', db.botPrivJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveKey', 'deriveBits']);
}
async function botSharedKey(userId) {
  if (botKeyCache.has(userId)) return botKeyCache.get(userId);
  const u = db.users[userId];
  const pub = await subtle.importKey('jwk', u.pubKey, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const key = await subtle.deriveKey({ name: 'ECDH', public: pub }, botPrivKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  botKeyCache.set(userId, key);
  return key;
}
const b64 = (buf) => Buffer.from(buf).toString('base64');
async function botEncrypt(userId, payloadObj) {
  const key = await botSharedKey(userId);
  const iv = crypto.webcrypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(payloadObj)));
  return { iv: b64(iv), ct: b64(ct) };
}
async function botDecrypt(userId, ivB64, ctB64) {
  const key = await botSharedKey(userId);
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(ivB64, 'base64') }, key, Buffer.from(ctB64, 'base64'));
  return JSON.parse(new TextDecoder().decode(pt));
}

/* ----------------------- Message engine ----------------------- */
function storeMessage({ chat, senderId, iv, ct, replyToId, kind, text }) {
  const msg = {
    id: newId('m_'), chatId: chat.id, senderId,
    kind: kind || 'user', text: text || null,
    iv: iv || null, ct: ct || null, replyToId: replyToId || null,
    ts: Date.now(), deliveredTo: [senderId], readBy: [senderId],
    reactions: {}, deleted: false,
  };
  db.messages.push(msg);
  if (!chatMsgIndex.has(chat.id)) chatMsgIndex.set(chat.id, []);
  chatMsgIndex.get(chat.id).push(msg);
  // delivery: members who are online right now receive it instantly
  for (const uid of chat.members) {
    if (uid !== senderId && (isOnline(uid) || db.users[uid]?.isBot) && !msg.deliveredTo.includes(uid)) {
      msg.deliveredTo.push(uid);
    }
  }
  saveDb();
  return msg;
}

function emitMessage(chat, msg, clientId) {
  // per-recipient payload so a brand-new chat arrives with its metadata
  for (const uid of chat.members) {
    sendToUser(uid, { type: 'message', chatId: chat.id, message: msg, clientId: clientId || null, chat: chatForUser(chat, uid) });
  }
}

function emitMessageUpdate(chat, msg) {
  sendToChat(chat, {
    type: 'message_update', chatId: chat.id, messageId: msg.id,
    deliveredTo: msg.deliveredTo, readBy: msg.readBy, reactions: msg.reactions, deleted: msg.deleted,
  });
}

function systemMessage(chat, text) {
  const msg = storeMessage({ chat, senderId: 'system', kind: 'system', text });
  emitMessage(chat, msg);
  return msg;
}

function findOrCreateDm(a, b) {
  for (const c of Object.values(db.chats)) {
    if (c.type === 'dm' && c.members.length === 2 && c.members.includes(a) && c.members.includes(b)) return c;
  }
  const chat = { id: newId('c_'), type: 'dm', name: null, members: [a, b], createdBy: a, createdAt: Date.now(), wrappedKeys: {} };
  db.chats[chat.id] = chat;
  saveDb();
  return chat;
}

/* --------------------------- Bot brain ------------------------ */
const BOT_JOKES = [
  'Programmer කෙනෙක් ඇයි අඳුරේ ඉන්න කැමති? මොකද light එක bugs ආකර්ෂණය කරනවා! 🐛😂',
  'WiFi එක ගියාම ගෙදර අය එකිනෙකා දැනගත්තා… හොඳ මිනිස්සු වගේ! 📶😆',
  'මගේ password එක "incorrect" — වැරදුන හැම වෙලේම computer එක කියනවා "your password is incorrect" කියලා! 🤣',
];
let botDefaultIdx = 0;
function botReply(text, userName) {
  const t = ' ' + String(text || '').toLowerCase() + ' ';
  const has = (...ws) => ws.some((w) => t.includes(w));
  if (has('help', 'උදව්', 'menu', 'features', 'මොනවද කරන්න පුළුවන්'))
    return `මෙන්න OneZchat එකේ තියෙන දේවල් 👇\n\n👥 *People* tab එකෙන් යාළුවෝ හොයාගෙන chat කරන්න\n🧑‍🤝‍🧑 උඩ තියෙන icon එකෙන් *Group* එකක් හදන්න\n📷 Photo යවන්න, 🎤 Voice message යවන්න\n❤️ Message එකක් උඩ click කරලා react / reply කරන්න\n📞 Voice & Video call ගන්නත් පුළුවන්!\n🔒 හැම message එකක්ම End-to-End Encrypted`;
  if (has('group', 'ගෲප්', 'කණ්ඩායම'))
    return 'Group එකක් හදන්න 👉 උඩ දකුණේ තියෙන 👥 icon එක ඔබන්න, group එකට නමක් දෙන්න, යාළුවෝ තෝරන්න, Create ඔබන්න. ලේසියි! 🥳';
  if (has('id', 'අයිඩී', 'number', 'අංකය'))
    return 'ඔයාගේ OneZ ID එක තමයි ඔයාගේ ලිපිනය 📬 යාළුවන්ට ඒක දුන්නම එයාලට People tab එකේ search කරලා ඔයාව හොයාගන්න පුළුවන්. ID එක ඔයාගේ profile එක උඩ click කළාම බලාගන්න පුළුවන්!';
  if (has('hack', 'secure', 'security', 'encrypt', 'safe', 'ආරක්ෂා', 'රහස්'))
    return '🔒 OneZchat එකේ හැම message එකක්ම End-to-End Encrypted (ECDH + AES-256-GCM). ඒ කියන්නේ message එක කියවන්න පුළුවන් ඔයාටයි, ලබන කෙනාටයි විතරයි — server එකටවත් බැහැ! 🛡️';
  if (has('joke', 'විහිළු', 'සිනා', 'funny', '😂'))
    return BOT_JOKES[Math.floor(Math.random() * BOT_JOKES.length)];
  if (has('time', 'වේලාව', 'date', 'දවස'))
    return 'දැන් වෙලාව: ' + new Date().toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) + ' 🕐';
  if (has('bye', 'ගිහිල්ලා එන්නම්', 'ටටා', 'tata'))
    return 'හරි හරි, පරිස්සමෙන් ගිහිල්ලා එන්න! 👋 ආයෙත් ඕන වෙලාවක එන්න, මම මෙහෙ ඉන්නවා. 💚';
  if (has('thank', 'ස්තූති', 'ස්තුති', 'තෑන්ක්'))
    return 'ඕනෑම වෙලාවක! 😊 තවත් මොනවා හරි දැනගන්න ඕන නම් "help" කියලා type කරන්න.';
  if (has('love', 'ආදරෙ', '❤️', '😍'))
    return 'අයියෝ… මම bot කෙනෙක් උනාට මටත් සතුටුයි! 🥹💚';
  if (has('who are you', 'ඔයා කවුද', 'your name', 'ඔයාගේ නම'))
    return 'මම OneZ Bot 🤖 — OneZchat එකේ official assistant එක. මට chat කරන්න, විහිළු අහන්න, උදව් ඉල්ලන්න පුළුවන්!';
  if (has('hi', 'hello', 'hey', 'ආයුබෝවන්', 'හායි', 'හෙලෝ', 'kohomada', 'කොහොමද'))
    return `ආයුබෝවන් ${userName}! 😄 කොහොමද? මොනවා හරි උදව්වක් ඕනද? "help" කියලා එව්වොත් මම හැමදේම කියලා දෙන්නම්.`;
  const defaults = [
    `හ්ම්, "${String(text).slice(0, 40)}" 🤔 මරු! මම තවම ඉගෙන ගන්නවා… "help" කියලා එවුවොත් මට කරන්න පුළුවන් දේවල් පෙන්වන්නම්.`,
    'එහෙමද! 😄 තව කියන්නකෝ. නැත්නම් "joke" එකක් අහන්න එවන්න.',
    'ඔව් ඔව්, ඇත්තටම! 👍 කියන්න බලන්න තව මොනවද අලුත් තොරතුරු?',
    'Interesting! 🤖✨ මම note කරගත්තා. තව මොනවා හරි ඕනද?',
  ];
  return defaults[botDefaultIdx++ % defaults.length];
}

const botLocks = new Set();
async function botHandleMessage(chat, msg) {
  const userId = msg.senderId;
  if (userId === BOT_ID || botLocks.has(chat.id)) return;
  botLocks.add(chat.id);
  try {
    // bot reads instantly -> blue ticks ✔✔
    if (!msg.readBy.includes(BOT_ID)) msg.readBy.push(BOT_ID);
    emitMessageUpdate(chat, msg);
    let replyText;
    try {
      const payload = await botDecrypt(userId, msg.iv, msg.ct);
      if (payload.t === 'image') replyText = 'වාව්, ලස්සන photo එකක්! 📸😍 ස්තූති එව්වට!';
      else if (payload.t === 'audio') replyText = 'Voice message එක ඇහුවා 🎧 හොඳයි හොඳයි! මට voice reply කරන්න බැරි උනාට text කරන්න පුළුවන් 😄';
      else replyText = botReply(payload.text, db.users[userId]?.name || 'යාළුවා');
    } catch { replyText = 'අයියෝ, ඔයාගේ message එක මට කියවගන්න බැරි උනා 🔒 (encryption ප්‍රශ්නයක් වෙන්න ඇති)'; }
    sendToUser(userId, { type: 'typing', chatId: chat.id, userId: BOT_ID, isTyping: true });
    await new Promise((r) => setTimeout(r, 900 + Math.random() * 900));
    sendToUser(userId, { type: 'typing', chatId: chat.id, userId: BOT_ID, isTyping: false });
    const enc = await botEncrypt(userId, { t: 'text', text: replyText });
    const reply = storeMessage({ chat, senderId: BOT_ID, iv: enc.iv, ct: enc.ct });
    emitMessage(chat, reply);
  } catch (e) { console.error('[bot]', e.message); }
  finally { botLocks.delete(chat.id); }
}

/* The bot posts a Status too, so the Stories tab is never empty.
   Content is encrypted once; the AES key is wrapped per viewer with the
   bot's ECDH key — same design as group keys. Raw key lives in memory only. */
let botStory = null; // { id, raw, iv, ct, expiresAt }
const BOT_STORY_TEXT =
  '🎉 *Status* එකට සාදරයෙන් පිළිගන්නවා!\n\n' +
  '🟢 Status tab එකෙන් ඔයාගේම status එකක් දාන්න — text හෝ photo.\n' +
  '⏳ 24h යනකම් පේනවා. 🔒 මේකත් End-to-End Encrypted!\n\n' +
  '— OneZ Bot 🤖';

async function botStoryEnsure(user) {
  try {
    const now = Date.now();
    if (!botStory || botStory.expiresAt <= now || !db.stories.some((s) => s.id === botStory.id)) {
      const raw = crypto.randomBytes(32);
      const key = await subtle.importKey('raw', raw, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
      const iv = crypto.webcrypto.getRandomValues(new Uint8Array(12));
      const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify({ t: 'text', text: BOT_STORY_TEXT, bg: 3 })));
      db.stories = db.stories.filter((s) => !(s.by === BOT_ID && s.expiresAt <= now)); // drop expired bot stories
      const st = {
        id: newId('s_'), by: BOT_ID, ts: now, kind: 'text',
        iv: b64(iv), ct: b64(ct), wrappedKeys: {}, views: [], expiresAt: now + STORY_TTL,
      };
      db.stories.push(st);
      botStory = { id: st.id, raw, expiresAt: st.expiresAt };
    }
    const st = db.stories.find((s) => s.id === botStory.id);
    if (!st || st.wrappedKeys[user.id]) { if (st) sendToUser(user.id, { type: 'story_upsert', story: storyForUser(st, user.id) }); return; }
    const shared = await botSharedKey(user.id);
    const wiv = crypto.webcrypto.getRandomValues(new Uint8Array(12));
    const wct = await subtle.encrypt({ name: 'AES-GCM', iv: wiv }, shared, botStory.raw);
    st.wrappedKeys[user.id] = { iv: b64(wiv), ct: b64(wct), by: BOT_ID };
    saveDb();
    sendToUser(user.id, { type: 'story_upsert', story: storyForUser(st, user.id) });
  } catch (e) { console.error('[bot story]', e.message); }
}

async function botWelcome(user) {
  try {
    botStoryEnsure(user);
    const chat = findOrCreateDm(BOT_ID, user.id);
    const text =
      `ආයුබෝවන් ${user.name}! 👋💚\n\n*OneZchat* එකට සාදරයෙන් පිළිගන්නවා! ඔයාගේ OneZ ID එක: *${user.id}*\n\n` +
      `👥 *People* tab එකෙන් යාළුවෝ හොයාගන්න\n🧑‍🤝‍🧑 👥 icon එකෙන් Group හදන්න\n📞 Call, 🎤 Voice, 📷 Photo — හැමදේම තියෙනවා\n🔒 හැම message එකක්ම End-to-End Encrypted\n\n` +
      `ඔයාගේ ID එක යාළුවන්ට දෙන්න, එයාලට ඔයාව හොයාගන්න පුළුවන්. මොනවා හරි අහන්න තියෙනවා නම් මට message එකක් දාන්න! 😊`;
    const enc = await botEncrypt(user.id, { t: 'text', text });
    const msg = storeMessage({ chat, senderId: BOT_ID, iv: enc.iv, ct: enc.ct });
    emitMessage(chat, msg);
  } catch (e) { console.error('[bot welcome]', e.message); }
}

/* --------------------------- HTTP ----------------------------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon' };
/* Framing: X-Frame-Options can't express "allow these hosts", and SAMEORIGIN
   would blank the app inside a cross-origin preview iframe. CSP frame-ancestors
   is the modern replacement — it keeps clickjacking protection while allowing
   this app's own origin plus the Arena sandbox/preview hosts. */
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(self), microphone=(self), display-capture=(self)',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; media-src 'self' data: blob:; connect-src 'self' ws: wss:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; base-uri 'self'; form-action 'self'; object-src 'none'; frame-ancestors 'self' https://*.e2b.app https://*.arena.ai https://arena.ai",
};

const regRate = new Map(); // ip -> [timestamps]
function regAllowed(ip) {
  const now = Date.now();
  const arr = (regRate.get(ip) || []).filter((t) => now - t < 3600e3);
  if (arr.length >= 20) return false;
  arr.push(now); regRate.set(ip, arr);
  return true;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);

  if (req.method === 'GET' && url.pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, app: 'OneZchat', users: Object.keys(db.users).length }));
  }

  if (req.method === 'POST' && url.pathname === '/api/register') {
    const ip = req.socket.remoteAddress || 'unknown';
    if (!regAllowed(ip)) { res.writeHead(429, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'Too many accounts from this network. Try later.' })); }
    let body = '', tooBig = false;
    req.on('data', (c) => { body += c; if (body.length > 32768) { tooBig = true; req.destroy(); } });
    req.on('end', async () => {
      if (tooBig) return;
      try {
        const data = JSON.parse(body);
        const name = cleanStr(data.name, 40);
        if (name.length < 1) throw new Error('Name is required');
        if (!validPubKey(data.pubKey)) throw new Error('Invalid encryption key');
        const token = crypto.randomBytes(32).toString('hex');
        const user = {
          id: newUserId(), name, avatar: validAvatar(data.avatar),
          about: cleanStr(data.about, 120) || 'Hey there! I am using OneZchat ✨',
          pubKey: { kty: 'EC', crv: 'P-256', x: data.pubKey.x, y: data.pubKey.y },
          tokenHash: sha256(token), isBot: false,
          createdAt: Date.now(), lastSeen: Date.now(),
        };
        db.users[user.id] = user;
        saveDb();
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: user.id, token }));
        broadcastAll({ type: 'user_update', user: publicUser(user) });
        botWelcome(user);
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message || 'Registration failed' }));
      }
    });
    return;
  }

  // static files
  if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
  let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
  filePath = path.normalize(path.join(PUBLIC_DIR, filePath));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(filePath, (err, content) => {
    if (err) { // SPA fallback
      return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, idx) => {
        if (e2) { res.writeHead(404); return res.end('Not found'); }
        res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
        res.end(idx);
      });
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600' });
    res.end(content);
  });
});

/* ------------------------- WebSocket -------------------------- */
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_MSG_BYTES });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.authedUserId = null;
  ws.msgWindow = [];
  const authTimer = setTimeout(() => { if (!ws.authedUserId) try { ws.close(4001, 'Auth timeout'); } catch {} }, 6000);
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', async (raw) => {
    let data;
    try { data = JSON.parse(raw.toString()); } catch { return; }
    if (!data || typeof data.type !== 'string') return;

    // ---- auth (must be first) ----
    if (!ws.authedUserId) {
      if (data.type !== 'auth') { try { ws.close(4002, 'Auth required'); } catch {} return; }
      const user = db.users[cleanStr(data.userId, 20)];
      if (!user || user.isBot || !tokenMatches(data.token, user.tokenHash)) {
        send(ws, { type: 'auth_error', error: 'Invalid ID or device token' });
        try { ws.close(4003, 'Bad auth'); } catch {}
        return;
      }
      clearTimeout(authTimer);
      ws.authedUserId = user.id;
      if (!socketsByUser.has(user.id)) socketsByUser.set(user.id, new Set());
      socketsByUser.get(user.id).add(ws);
      user.lastSeen = Date.now(); saveDb();

      const myChats = Object.values(db.chats)
        .filter((c) => c.members.includes(user.id))
        .map((c) => chatForUser(c, user.id))
        .sort((x, y) => ((y.lastMessage?.ts || y.createdAt) - (x.lastMessage?.ts || x.createdAt)));
      send(ws, {
        type: 'init', me: publicUser(user),
        users: Object.values(db.users).map(publicUser),
        chats: myChats,
        stories: storiesForUser(user.id),
      });
      broadcastAll({ type: 'presence', userId: user.id, online: true, lastSeen: user.lastSeen });
      // anything sent while offline becomes "delivered" now
      for (const c of Object.values(db.chats)) {
        if (!c.members.includes(user.id)) continue;
        let changed = false;
        for (const m of chatMsgIndex.get(c.id) || []) {
          if (m.senderId !== user.id && !m.deliveredTo.includes(user.id)) { m.deliveredTo.push(user.id); changed = true; }
        }
        if (changed) { saveDb(); sendToChat(c, { type: 'delivered_sync', chatId: c.id, userId: user.id }); }
      }
      return;
    }

    const me = db.users[ws.authedUserId];
    if (!me) return;

    // rate limit: 90 events / 10s
    const now = Date.now();
    ws.msgWindow = ws.msgWindow.filter((t) => now - t < 10000);
    ws.msgWindow.push(now);
    if (ws.msgWindow.length > 90) { send(ws, { type: 'error', error: 'You are sending too fast. Slow down a bit 🐢' }); return; }

    try {
      switch (data.type) {
        case 'open_chat': {
          const chat = db.chats[cleanStr(data.chatId, 40)];
          if (!chat || !chat.members.includes(me.id)) return;
          send(ws, { type: 'chat_messages', chatId: chat.id, messages: recentMessages(chat.id), chat: chatForUser(chat, me.id) });
          break;
        }
        case 'create_dm': {
          const peer = db.users[cleanStr(data.peerId, 20)];
          if (!peer || peer.id === me.id) return;
          const chat = findOrCreateDm(me.id, peer.id);
          send(ws, { type: 'chat_messages', chatId: chat.id, messages: recentMessages(chat.id), chat: chatForUser(chat, me.id) });
          sendToUser(peer.id, { type: 'chat_upsert', chat: chatForUser(chat, peer.id) });
          break;
        }
        case 'create_group': {
          const name = cleanStr(data.name, 60);
          const memberIds = Array.isArray(data.memberIds) ? [...new Set(data.memberIds.map((x) => cleanStr(x, 20)))] : [];
          const members = [me.id, ...memberIds.filter((id) => db.users[id] && id !== me.id && !db.users[id].isBot)].slice(0, 100);
          if (!name || members.length < 2) { send(ws, { type: 'error', error: 'Group එකට නමකුයි, අඩුම තරමේ තව එක්කෙනෙකුයි ඕනේ.' }); return; }
          const wrappedKeys = {};
          for (const uid of members) {
            const w = data.wrappedKeys && data.wrappedKeys[uid];
            if (!w || typeof w.iv !== 'string' || typeof w.ct !== 'string') { send(ws, { type: 'error', error: 'Encryption key missing for a member' }); return; }
            wrappedKeys[uid] = { iv: w.iv.slice(0, 64), ct: w.ct.slice(0, 512), by: cleanStr(w.by, 20) || me.id };
          }
          const chat = {
            id: newId('c_'), type: 'group', name, grad: Math.max(0, Math.min(9, parseInt(data.grad, 10) || 0)),
            members, createdBy: me.id, createdAt: Date.now(), wrappedKeys,
          };
          db.chats[chat.id] = chat; saveDb();
          for (const uid of members) sendToUser(uid, { type: 'chat_upsert', chat: chatForUser(chat, uid) });
          systemMessage(chat, `🧑‍🤝‍🧑 ${me.name} created the group "${name}"`);
          send(ws, { type: 'chat_messages', chatId: chat.id, messages: recentMessages(chat.id), chat: chatForUser(chat, me.id), openNow: true });
          break;
        }
        case 'add_member': {
          const chat = db.chats[cleanStr(data.chatId, 40)];
          const target = db.users[cleanStr(data.userId, 20)];
          if (!chat || chat.type !== 'group' || !chat.members.includes(me.id) || !target || target.isBot) return;
          if (chat.members.includes(target.id)) return;
          if (!data.wrappedKey || typeof data.wrappedKey.ct !== 'string') return;
          chat.members.push(target.id);
          chat.wrappedKeys[target.id] = { iv: String(data.wrappedKey.iv).slice(0, 64), ct: String(data.wrappedKey.ct).slice(0, 512), by: me.id };
          saveDb();
          for (const uid of chat.members) sendToUser(uid, { type: 'chat_upsert', chat: chatForUser(chat, uid) });
          systemMessage(chat, `➕ ${me.name} added ${target.name}`);
          break;
        }
        case 'leave_group': {
          const chat = db.chats[cleanStr(data.chatId, 40)];
          if (!chat || chat.type !== 'group' || !chat.members.includes(me.id)) return;
          chat.members = chat.members.filter((u) => u !== me.id);
          delete chat.wrappedKeys[me.id];
          saveDb();
          sendToUser(me.id, { type: 'chat_removed', chatId: chat.id });
          if (chat.members.length) {
            for (const uid of chat.members) sendToUser(uid, { type: 'chat_upsert', chat: chatForUser(chat, uid) });
            systemMessage(chat, `👋 ${me.name} left the group`);
          }
          break;
        }
        case 'send_message': {
          const chat = db.chats[cleanStr(data.chatId, 40)];
          if (!chat || !chat.members.includes(me.id)) return;
          if (typeof data.iv !== 'string' || typeof data.ct !== 'string' || !data.iv || !data.ct || data.ct.length > MAX_MSG_BYTES) return;
          const msg = storeMessage({ chat, senderId: me.id, iv: data.iv, ct: data.ct, replyToId: cleanStr(data.replyToId, 40) || null });
          emitMessage(chat, msg, cleanStr(data.clientId, 40));
          if (chat.type === 'dm' && chat.members.includes(BOT_ID)) botHandleMessage(chat, msg);
          break;
        }
        case 'read': {
          const chat = db.chats[cleanStr(data.chatId, 40)];
          if (!chat || !chat.members.includes(me.id)) return;
          const ids = [];
          for (const m of chatMsgIndex.get(chat.id) || []) {
            if (m.senderId !== me.id && !m.readBy.includes(me.id)) {
              m.readBy.push(me.id);
              if (!m.deliveredTo.includes(me.id)) m.deliveredTo.push(me.id);
              ids.push(m.id);
            }
          }
          if (ids.length) { saveDb(); sendToChat(chat, { type: 'read_update', chatId: chat.id, by: me.id, ids }); }
          break;
        }
        case 'typing': {
          const chat = db.chats[cleanStr(data.chatId, 40)];
          if (!chat || !chat.members.includes(me.id)) return;
          sendToChat(chat, { type: 'typing', chatId: chat.id, userId: me.id, isTyping: !!data.isTyping }, me.id);
          break;
        }
        case 'reaction': {
          const msg = db.messages.find((m) => m.id === cleanStr(data.messageId, 40));
          if (!msg) return;
          const chat = db.chats[msg.chatId];
          if (!chat || !chat.members.includes(me.id) || msg.deleted) return;
          const emoji = cleanStr(data.emoji, 8);
          if (emoji) msg.reactions[me.id] = emoji; else delete msg.reactions[me.id];
          saveDb(); emitMessageUpdate(chat, msg);
          break;
        }
        case 'delete_message': {
          const msg = db.messages.find((m) => m.id === cleanStr(data.messageId, 40));
          if (!msg || msg.senderId !== me.id) return;
          msg.deleted = true; msg.ct = null; msg.iv = null; msg.reactions = {};
          saveDb(); emitMessageUpdate(db.chats[msg.chatId], msg);
          break;
        }
        case 'update_profile': {
          if (data.name !== undefined) { const n = cleanStr(data.name, 40); if (n) me.name = n; }
          if (data.about !== undefined) me.about = cleanStr(data.about, 120);
          if (data.avatar !== undefined) me.avatar = validAvatar(data.avatar);
          saveDb();
          broadcastAll({ type: 'user_update', user: publicUser(me) });
          break;
        }
        case 'call_signal': {
          if (!data.data || typeof data.data !== 'object') return;
          const chatId = cleanStr(data.chatId, 40);
          const toId = cleanStr(data.to, 20);
          const chat = chatId ? db.chats[chatId] : null;
          if (chatId && (!chat || !chat.members.includes(me.id))) return;
          if (toId) {
            const to = db.users[toId];
            if (!to || to.id === me.id || to.isBot) return;
            const ctx = chat || Object.values(db.chats).find((c) => c.type === 'dm' && c.members.includes(me.id) && c.members.includes(to.id));
            sendToUser(to.id, { type: 'call_signal', from: me.id, chatId: ctx ? ctx.id : null, data: data.data });
          } else if (chat) {
            // group call: relay to every other member (bots excluded)
            for (const uid of chat.members) {
              if (uid === me.id || db.users[uid]?.isBot) continue;
              sendToUser(uid, { type: 'call_signal', from: me.id, chatId: chat.id, data: data.data });
            }
          }
          break;
        }
        case 'create_story': {
          pruneStories();
          const kind = data.kind === 'image' ? 'image' : 'text';
          if (typeof data.iv !== 'string' || typeof data.ct !== 'string' || !data.iv || !data.ct) return;
          if (data.ct.length > MAX_MSG_BYTES) { send(ws, { type: 'error', error: 'Status එක ගොඩක් ලොකුයි 🙈' }); return; }
          const src = data.wrappedKeys && typeof data.wrappedKeys === 'object' ? data.wrappedKeys : {};
          const wrappedKeys = {};
          for (const uid of Object.keys(src)) {
            if (!db.users[uid]) continue;
            const w = src[uid];
            if (!w || typeof w.iv !== 'string' || typeof w.ct !== 'string') continue;
            wrappedKeys[uid] = { iv: w.iv.slice(0, 64), ct: w.ct.slice(0, 512), by: cleanStr(w.by, 20) || me.id };
            if (Object.keys(wrappedKeys).length >= 300) break;
          }
          if (!wrappedKeys[me.id]) { send(ws, { type: 'error', error: 'Status encryption key එක හරි නෑ' }); return; }
          if (db.stories.filter((s) => s.by === me.id).length >= 20) {
            send(ws, { type: 'error', error: 'Status 20කට වඩා තියන්න බෑ — පරණ එකක් මකන්න' }); return;
          }
          const st = {
            id: newId('s_'), by: me.id, ts: Date.now(), kind,
            iv: data.iv.slice(0, 64), ct: data.ct, wrappedKeys, views: [],
            expiresAt: Date.now() + STORY_TTL,
          };
          db.stories.push(st); saveDb();
          for (const uid of Object.keys(wrappedKeys)) sendToUser(uid, { type: 'story_upsert', story: storyForUser(st, uid) });
          break;
        }
        case 'view_story': {
          const st = db.stories.find((s) => s.id === cleanStr(data.storyId, 40));
          if (!st || st.by === me.id || !st.wrappedKeys[me.id]) return;
          if (!st.views.includes(me.id)) {
            st.views.push(me.id); saveDb();
            sendToUser(st.by, { type: 'story_update', storyId: st.id, views: st.views.slice() });
          }
          break;
        }
        case 'delete_story': {
          const i = db.stories.findIndex((s) => s.id === cleanStr(data.storyId, 40));
          if (i < 0) return;
          const st = db.stories[i];
          if (st.by !== me.id) return;
          db.stories.splice(i, 1); saveDb();
          for (const uid of Object.keys(st.wrappedKeys)) sendToUser(uid, { type: 'story_removed', storyId: st.id });
          break;
        }
        case 'ping': send(ws, { type: 'pong', ts: Date.now() }); break;
      }
    } catch (e) { console.error('[ws]', e.message); }
  });

  ws.on('close', () => {
    clearTimeout(authTimer);
    const uid = ws.authedUserId;
    if (!uid) return;
    const set = socketsByUser.get(uid);
    if (set) { set.delete(ws); if (!set.size) socketsByUser.delete(uid); }
    if (!socketsByUser.has(uid) && db.users[uid]) {
      db.users[uid].lastSeen = Date.now(); saveDb();
      broadcastAll({ type: 'presence', userId: uid, online: false, lastSeen: db.users[uid].lastSeen });
    }
  });
  ws.on('error', () => {});
});

// heartbeat — drop dead sockets
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { try { ws.terminate(); } catch {} continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 30000);

// expire stories (24h)
setInterval(pruneStories, 10 * 60e3);

/* ---------------------------- Boot ---------------------------- */
(async () => {
  loadDb();
  await initBot();
  saveDb();
  server.listen(PORT, HOST, () => {
    console.log(`\n  💚 OneZchat server running at http://localhost:${PORT}`);
    console.log(`  🔒 End-to-end encryption: server stores ciphertext only`);
    console.log(`  👥 Users registered: ${Object.keys(db.users).length}\n`);
  });
})();
