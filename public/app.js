/* ============================================================
   OneZchat — client app
   No login/password: your name -> OneZ ID + device token +
   encryption keys, all generated & saved on THIS device.
   ============================================================ */
'use strict';

/* ---------------- helpers ---------------- */
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const LS_ID = 'onezchat.identity.v1';
const LS_THEME = 'onezchat.theme';
const BOT_ID = 'OZ-ONEZBOT';

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtText(s) {
  let h = esc(s);
  h = h.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
  h = h.replace(/\*([^*\n]+)\*/g, '<b>$1</b>');
  h = h.replace(/_([^_\n]+)_/g, '<i>$1</i>');
  return h;
}
const pad = (n) => String(n).padStart(2, '0');
function fmtTime(ts) {
  const d = new Date(ts);
  let h = d.getHours(); const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
  return `${h}:${pad(d.getMinutes())} ${ap}`;
}
function dayLabel(ts) {
  const d = new Date(ts), now = new Date();
  const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(d, now)) return 'Today';
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (sameDay(d, y)) return 'Yesterday';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
function listTime(ts) {
  if (!ts) return '';
  return dayLabel(ts) === 'Today' ? fmtTime(ts) : dayLabel(ts) === 'Yesterday' ? 'Yesterday'
    : new Date(ts).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: '2-digit' });
}
function toast(msg, isErr) {
  const t = document.createElement('div');
  t.className = 'toast' + (isErr ? ' err' : '');
  t.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 420); }, 3200);
}
async function copyText(txt, okMsg) {
  try { await navigator.clipboard.writeText(txt); toast(okMsg || 'Copied! 📋'); }
  catch { toast('Copy කරන්න බැරි උනා', true); }
}

/* tiny pop sounds (WebAudio, no files) */
let audioCtx = null;
function blip(freq, dur = 0.09, type = 'sine', gain = 0.06, when = 0) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(gain, audioCtx.currentTime + when);
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + when + dur);
    o.connect(g).connect(audioCtx.destination);
    o.start(audioCtx.currentTime + when); o.stop(audioCtx.currentTime + when + dur + 0.02);
  } catch {}
}
const sndSend = () => blip(620, 0.08);
const sndRecv = () => { blip(520, 0.08); blip(780, 0.1, 'sine', 0.05, 0.09); };

/* ---------------- state ---------------- */
const S = {
  identity: null, privKey: null, me: null,
  users: new Map(), chats: new Map(), messages: new Map(),
  payloadCache: new Map(), keyCache: new Map(),
  activeChatId: null, tab: 'chats', search: '',
  replyTo: null, ws: null, wsReady: false, reconnectMs: 1000,
  typingSentAt: 0, typingStopTimer: null,
  menuMsg: null, infoChatId: null,
};
const AVATAR_EMOJIS = ['😀','😎','🤩','🥳','😺','🐶','🦁','🐼','🦊','🐯','🌟','🔥','⚡','🌈','🍀','🎧','🚀','👑','💎','🦋','🌸','🐢','🦄','🤖','🍕','⚽','🎸','🌙','☀️','❤️'];
const PICKER_EMOJIS = ['😀','😁','😂','🤣','😊','😍','😘','😎','🤩','🥳','😏','😌','😴','🤯','🥺','😢','😭','😡','🤔','🤨','😐','🙄','😬','🤐','🤫','🥴','😇','🤠','👍','👎','👏','🙏','💪','🔥','✨','🎉','🎂','❤️','💚','💙','💜','🖤','💔','💯','⭐','🌟','⚡','☀️','🌙','🌈','🍀','🌸','🍕','🍔','☕','🧋','⚽','🏏','🎮','🎧','🎸','🚀','🚗','✈️','🏠','💰','💎','👑','🦁','🐘','🦋','🐶','😺','🙈','👀','💬','🔒','✅','❌','⚠️','🆗','😜','🤗','🫡','🥰','😻','🙌','👋','✌️','🤞','🫶','🇱🇰'];
const REACTIONS = ['❤️','😂','😮','😢','🙏','👍','🔥'];

/* ---------------- theme ---------------- */
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  localStorage.setItem(LS_THEME, t);
  $('#btn-theme').textContent = t === 'dark' ? '☀️' : '🌙';
}
applyTheme(localStorage.getItem(LS_THEME) || 'dark');

/* ============================================================
   BOOT + SPLASH
   ============================================================ */
const splashStart = Date.now();
function hideSplash() {
  const wait = Math.max(0, 2000 - (Date.now() - splashStart));
  setTimeout(() => $('#splash').classList.add('done'), wait);
}

async function boot() {
  if (!OZCrypto.supported) {
    hideSplash();
    document.body.innerHTML = '<div style="padding:40px;font-family:sans-serif;text-align:center;color:#fff">⚠️ OneZchat needs a secure connection (HTTPS or localhost) for end-to-end encryption. Please open it via https:// or localhost.</div>';
    return;
  }
  buildOnboarding();
  buildEmojiPicker();
  bindGlobalUi();
  const raw = localStorage.getItem(LS_ID);
  if (raw) {
    try {
      S.identity = JSON.parse(raw);
      S.privKey = await OZCrypto.importPrivate(S.identity.privJwk);
      connectWs(true);
      return; // splash hides on init
    } catch { localStorage.removeItem(LS_ID); }
  }
  hideSplash();
  setTimeout(() => { $('#onboard').classList.remove('hidden'); $('#ob-name').focus(); }, 2100);
}

/* ============================================================
   ONBOARDING — name -> ID (no password!)
   ============================================================ */
let obEmoji = '😀', obGrad = 0;
function pickerGrid(el, items, get, set, isGrad) {
  el.innerHTML = '';
  items.forEach((it, i) => {
    const b = document.createElement('button');
    if (isGrad) { b.className = 'grad-' + i; if (get() === i) b.classList.add('sel'); b.addEventListener('click', () => { set(i); pickerGrid(el, items, get, set, isGrad); syncObPreview(); }); }
    else { b.textContent = it; if (get() === it) b.classList.add('sel'); b.addEventListener('click', () => { set(it); pickerGrid(el, items, get, set, isGrad); syncObPreview(); }); }
    el.appendChild(b);
  });
}
function syncObPreview() {
  const p = $('#ob-preview');
  p.className = 'avatar lg grad-' + obGrad; p.textContent = obEmoji;
  $('#ob-preview-name').textContent = $('#ob-name').value.trim() || 'Your name';
}
function buildOnboarding() {
  pickerGrid($('#ob-emojis'), AVATAR_EMOJIS, () => obEmoji, (v) => (obEmoji = v), false);
  pickerGrid($('#ob-grads'), Array.from({ length: 10 }), () => obGrad, (v) => (obGrad = v), true);
  $('#ob-name').addEventListener('input', syncObPreview);
  $('#ob-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#ob-start').click(); });
  $('#ob-start').addEventListener('click', register);
  syncObPreview();
}

async function register() {
  const name = $('#ob-name').value.trim();
  const err = $('#ob-error');
  err.classList.add('hidden');
  if (!name) { err.textContent = 'කරුණාකර ඔයාගේ නම දාන්න 🙏'; err.classList.remove('hidden'); $('#ob-name').focus(); return; }
  const btn = $('#ob-start');
  btn.disabled = true; btn.textContent = '🔐 Encryption keys හදනවා…';
  try {
    const idn = await OZCrypto.generateIdentity();
    const res = await fetch('/api/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, pubKey: idn.pubJwk, avatar: { emoji: obEmoji, grad: obGrad } }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Registration failed');
    S.identity = { userId: data.id, token: data.token, privJwk: idn.privJwk, pubJwk: idn.pubJwk };
    S.privKey = idn.privateKey;
    localStorage.setItem(LS_ID, JSON.stringify(S.identity));
    // reveal!
    $('#onboard .onboard-card').classList.add('hidden');
    const rv = $('#id-reveal'); rv.classList.remove('hidden');
    const av = $('#reveal-avatar'); av.className = 'avatar lg grad-' + obGrad; av.textContent = obEmoji;
    $('#reveal-name').textContent = name;
    $('#reveal-id').textContent = data.id;
    blip(880, 0.12); blip(1174, 0.16, 'sine', 0.05, 0.12);
    $('#reveal-copy').onclick = () => copyText(data.id, 'OneZ ID එක copy උනා! 📋');
    $('#reveal-go').onclick = () => { $('#onboard').classList.add('hidden'); connectWs(true); };
  } catch (e) {
    err.textContent = '⚠️ ' + e.message; err.classList.remove('hidden');
    btn.disabled = false; btn.textContent = '🚀 මගේ OneZ ID එක හදන්න';
  }
}

/* ============================================================
   WEBSOCKET
   ============================================================ */
function connectWs(first) {
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  const ws = new WebSocket(proto + location.host + '/ws');
  S.ws = ws;
  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ type: 'auth', userId: S.identity.userId, token: S.identity.token }));
  });
  ws.addEventListener('message', (ev) => {
    let d; try { d = JSON.parse(ev.data); } catch { return; }
    onServerEvent(d, first);
  });
  ws.addEventListener('close', () => {
    S.wsReady = false;
    $('#conn-banner').classList.remove('hidden');
    if (document.body.dataset.loggedOut) return;
    setTimeout(() => connectWs(false), S.reconnectMs);
    S.reconnectMs = Math.min(10000, S.reconnectMs * 1.6);
  });
  ws.addEventListener('error', () => { try { ws.close(); } catch {} });
}
function sendWs(obj) {
  if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(obj));
  else toast('📡 Connection නෑ… reconnect වෙනවා', true);
}

async function onServerEvent(d, first) {
  switch (d.type) {
    case 'auth_error':
      localStorage.removeItem(LS_ID);
      toast('⚠️ මේ device එකේ ID එක වලංගු නෑ. අලුතින් හදන්න.', true);
      setTimeout(() => location.reload(), 1200);
      break;
    case 'init': {
      S.me = d.me; S.wsReady = true; S.reconnectMs = 1000;
      $('#conn-banner').classList.add('hidden');
      S.users = new Map(d.users.map((u) => [u.id, u]));
      const prevActive = S.activeChatId;
      S.chats = new Map(d.chats.map((c) => [c.id, c]));
      showApp();
      renderAll();
      // decrypt list previews
      for (const c of S.chats.values()) decryptPreview(c);
      if (prevActive && S.chats.has(prevActive)) sendWs({ type: 'open_chat', chatId: prevActive });
      hideSplash();
      break;
    }
    case 'error': toast('⚠️ ' + d.error, true); break;
    case 'user_update': {
      S.users.set(d.user.id, d.user);
      if (d.user.id === S.me?.id) { S.me = d.user; syncMeHeader(); }
      renderChatList(); renderPeople(); syncConvHeader(); renderInfoIfOpen();
      break;
    }
    case 'presence': {
      const u = S.users.get(d.userId);
      if (u) { u.online = d.online; u.lastSeen = d.lastSeen; }
      renderChatList(); renderPeople(); syncConvHeader(); renderInfoIfOpen();
      break;
    }
    case 'chat_upsert': {
      const old = S.chats.get(d.chat.id);
      S.chats.set(d.chat.id, { ...d.chat, _preview: old?._preview, _typing: old?._typing });
      S.keyCache.delete(d.chat.id);
      decryptPreview(S.chats.get(d.chat.id));
      renderChatList(); syncConvHeader(); renderInfoIfOpen();
      break;
    }
    case 'chat_removed': {
      S.chats.delete(d.chatId); S.messages.delete(d.chatId);
      if (S.activeChatId === d.chatId) closeConversation();
      renderChatList();
      break;
    }
    case 'chat_messages': {
      const chat = S.chats.get(d.chatId) || d.chat;
      S.chats.set(d.chatId, { ...(d.chat || chat), _preview: chat?._preview, _typing: chat?._typing });
      S.messages.set(d.chatId, d.messages);
      S.chats.get(d.chatId).unread = 0;
      openConversation(d.chatId);
      await decryptAllInChat(d.chatId);
      renderMessages(true);
      sendWs({ type: 'read', chatId: d.chatId });
      renderChatList();
      break;
    }
    case 'message': await onIncomingMessage(d); break;
    case 'message_update': {
      const arr = S.messages.get(d.chatId) || [];
      const m = arr.find((x) => x.id === d.messageId);
      if (m) { m.deliveredTo = d.deliveredTo; m.readBy = d.readBy; m.reactions = d.reactions; m.deleted = d.deleted; refreshBubble(m); }
      const c = S.chats.get(d.chatId);
      if (c?.lastMessage?.id === d.messageId) { Object.assign(c.lastMessage, { deliveredTo: d.deliveredTo, readBy: d.readBy, deleted: d.deleted }); renderChatList(); }
      break;
    }
    case 'read_update': {
      const arr = S.messages.get(d.chatId) || [];
      for (const id of d.ids) {
        const m = arr.find((x) => x.id === id);
        if (m && !m.readBy.includes(d.by)) { m.readBy.push(d.by); if (!m.deliveredTo.includes(d.by)) m.deliveredTo.push(d.by); refreshBubble(m); }
      }
      const c = S.chats.get(d.chatId);
      if (c?.lastMessage && d.ids.includes(c.lastMessage.id)) {
        if (!c.lastMessage.readBy.includes(d.by)) c.lastMessage.readBy.push(d.by);
        renderChatList();
      }
      break;
    }
    case 'delivered_sync': {
      const arr = S.messages.get(d.chatId) || [];
      for (const m of arr) if (m.senderId === S.me.id && !m.deliveredTo.includes(d.userId)) { m.deliveredTo.push(d.userId); refreshBubble(m); }
      const c = S.chats.get(d.chatId);
      if (c?.lastMessage?.senderId === S.me.id && !c.lastMessage.deliveredTo.includes(d.userId)) { c.lastMessage.deliveredTo.push(d.userId); renderChatList(); }
      break;
    }
    case 'typing': {
      const c = S.chats.get(d.chatId); if (!c) break;
      c._typing = c._typing || new Map();
      if (d.isTyping) c._typing.set(d.userId, Date.now()); else c._typing.delete(d.userId);
      renderChatList(); syncConvHeader(); syncTypingBubble();
      break;
    }
    case 'call_signal': onCallSignal(d); break;
  }
}

async function onIncomingMessage(d) {
  const msg = d.message;
  let chat = S.chats.get(d.chatId);
  if (!chat && d.chat) { chat = d.chat; S.chats.set(d.chatId, chat); }
  if (!chat) return;
  if (d.chat) { // keep local-only fields while refreshing server state
    const keep = { _preview: chat._preview, _typing: chat._typing, unread: chat.unread };
    Object.assign(chat, d.chat, keep);
  }
  chat.lastMessage = msg;
  const arr = S.messages.get(d.chatId);
  let live = false, reconciled = false;
  if (arr) {
    const idx = d.clientId ? arr.findIndex((m) => m._cid === d.clientId) : -1;
    if (idx >= 0) {
      const oldCid = arr[idx].id;
      arr[idx] = { ...msg, _p: arr[idx]._p };
      S.payloadCache.set(msg.id, arr[idx]._p);
      reconciled = oldCid;
    } else if (!arr.some((m) => m.id === msg.id)) arr.push(msg);
    live = S.activeChatId === d.chatId;
  }
  const mine = msg.senderId === S.me.id;
  if (!mine && S.activeChatId === d.chatId && !document.hidden) {
    sendWs({ type: 'read', chatId: d.chatId });
    chat.unread = 0;
  } else if (!mine) {
    chat.unread = (chat.unread || 0) + 1;
    sndRecv();
  }
  await decryptPayloadFor(d.chatId, msg);
  decryptPreview(chat);
  if (live && arr) {
    if (reconciled) {
      const row = $(`#messages .msg-row[data-mid="${reconciled}"]`);
      if (row) { row.dataset.mid = msg.id; refreshBubble(msg); }
      else renderMessages(false);
    } else {
      appendMessageRow(chat, msg);
    }
  }
  renderChatList();
  updateTitleBadge();
}

/* ============================================================
   CRYPTO plumbing (keys per chat)
   ============================================================ */
function getChatKey(chat) {
  if (S.keyCache.has(chat.id)) return S.keyCache.get(chat.id);
  const p = (async () => {
    if (chat.type === 'dm') {
      const peerId = chat.members.find((m) => m !== S.me.id);
      const peer = S.users.get(peerId);
      if (!peer) throw new Error('peer missing');
      return OZCrypto.deriveShared(S.privKey, peer.pubKey);
    }
    const w = chat.wrappedKey;
    if (!w) throw new Error('no group key for me');
    const wrapper = S.users.get(w.by || chat.createdBy);
    if (!wrapper) throw new Error('wrapper missing');
    return OZCrypto.unwrapGroupKey(w, S.privKey, wrapper.pubKey);
  })();
  p.catch(() => S.keyCache.delete(chat.id));
  S.keyCache.set(chat.id, p);
  return p;
}

async function decryptPayloadFor(chatId, msg) {
  if (!msg || msg.kind === 'system' || msg.deleted) return null;
  if (S.payloadCache.has(msg.id)) return S.payloadCache.get(msg.id);
  const chat = S.chats.get(chatId);
  if (!chat || !msg.iv || !msg.ct) return null;
  try {
    const key = await getChatKey(chat);
    const payload = await OZCrypto.decryptJSON(key, msg.iv, msg.ct);
    S.payloadCache.set(msg.id, payload);
    return payload;
  } catch {
    S.payloadCache.set(msg.id, '__err__');
    return '__err__';
  }
}
async function decryptAllInChat(chatId) {
  const arr = S.messages.get(chatId) || [];
  await Promise.all(arr.map((m) => decryptPayloadFor(chatId, m)));
}
function payloadPreviewText(msg, payload) {
  if (!msg) return '';
  if (msg.kind === 'system') return msg.text || '';
  if (msg.deleted) return '🚫 This message was deleted';
  if (payload === '__err__') return '🔒 Encrypted message';
  if (!payload) return '🔒 Encrypted message';
  if (payload.t === 'image') return '📷 Photo' + (payload.text ? ' · ' + payload.text : '');
  if (payload.t === 'audio') return '🎤 Voice message';
  return payload.text || '';
}
async function decryptPreview(chat) {
  if (!chat.lastMessage) { chat._preview = ''; return; }
  const p = await decryptPayloadFor(chat.id, chat.lastMessage);
  chat._preview = payloadPreviewText(chat.lastMessage, p);
  if (S.tab === 'chats') renderChatList();
}
async function encryptForChat(chat, payload) {
  const key = await getChatKey(chat);
  return OZCrypto.encryptJSON(key, payload);
}

/* ============================================================
   APP SHELL rendering
   ============================================================ */
function showApp() {
  $('#onboard').classList.add('hidden');
  $('#app').classList.remove('hidden');
  syncMeHeader();
}
function syncMeHeader() {
  if (!S.me) return;
  const av = $('#me-avatar');
  av.className = 'avatar grad-' + (S.me.avatar?.grad ?? 0);
  av.textContent = S.me.avatar?.emoji || '😀';
  $('#me-name').textContent = S.me.name;
  $('#me-id').textContent = S.me.id;
  $('#empty-my-id').textContent = S.me.id;
}
function renderAll() { renderChatList(); renderPeople(); }

function chatPeer(chat) {
  if (chat.type !== 'dm') return null;
  return S.users.get(chat.members.find((m) => m !== S.me.id));
}
function chatTitle(chat) {
  if (chat.type === 'group') return chat.name || 'Group';
  return chatPeer(chat)?.name || 'Unknown';
}
function avatarHtml({ emoji, grad, text, size }) {
  const cls = `avatar ${size || ''} grad-${grad ?? 0}` + (text ? ' txt' : '');
  return `<span class="${cls}">${esc(text || emoji || '😀')}</span>`;
}
function groupInitials(name) {
  return (name || 'G').trim().split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase();
}
function chatAvatarHtml(chat, size) {
  if (chat.type === 'group') return avatarHtml({ text: groupInitials(chat.name), grad: chat.grad, size });
  const p = chatPeer(chat);
  return avatarHtml({ emoji: p?.avatar?.emoji, grad: p?.avatar?.grad, size });
}
function ticksHtml(chat, msg) {
  if (!msg || msg.senderId !== S.me.id) return '';
  const others = chat.members.filter((m) => m !== S.me.id);
  const readAll = others.length && others.every((o) => (msg.readBy || []).includes(o));
  const delAll = others.length && others.every((o) => (msg.deliveredTo || []).includes(o));
  if (readAll) return '<span class="ticks read">✓✓</span>';
  if (delAll) return '<span class="ticks">✓✓</span>';
  return '<span class="ticks">✓</span>';
}
function isTyping(chat) {
  if (!chat._typing) return [];
  const now = Date.now();
  return [...chat._typing.entries()].filter(([, t]) => now - t < 4000).map(([u]) => u);
}

function renderChatList() {
  const el = $('#chat-list');
  const q = S.search.toLowerCase();
  const chats = [...S.chats.values()]
    .filter((c) => !q || chatTitle(c).toLowerCase().includes(q))
    .sort((a, b) => ((b.lastMessage?.ts || b.createdAt) - (a.lastMessage?.ts || a.createdAt)));
  const totalUnread = [...S.chats.values()].reduce((n, c) => n + (c.unread || 0), 0);
  const badge = $('#chats-badge');
  badge.textContent = totalUnread; badge.classList.toggle('hidden', !totalUnread);
  updateTitleBadge(totalUnread);

  if (!chats.length) {
    el.innerHTML = `<div class="list-empty"><span class="big-ic">💬</span>තවම chats නෑ.<br><b>People</b> tab එකෙන් කාටහරි message එකක් දාන්න!</div>`;
    return;
  }
  el.innerHTML = '';
  for (const chat of chats) {
    const p = chatPeer(chat);
    const typing = isTyping(chat);
    const row = document.createElement('div');
    row.className = 'row' + (S.activeChatId === chat.id ? ' active' : '');
    const lm = chat.lastMessage;
    let preview;
    if (typing.length) {
      preview = chat.type === 'group' ? `${esc(S.users.get(typing[0])?.name || 'Someone')} typing…` : 'typing…';
    } else if (lm) {
      const prefix = lm.senderId === S.me.id ? '' : (chat.type === 'group' && lm.kind !== 'system' ? esc(S.users.get(lm.senderId)?.name?.split(' ')[0] || '') + ': ' : '');
      preview = prefix + esc(chat._preview ?? '🔒 Encrypted message');
    } else preview = chat.type === 'group' ? 'Group created' : 'Say hi! 👋';
    row.innerHTML = `
      <div class="avatar-wrap">${chatAvatarHtml(chat)}
        ${chat.type === 'dm' ? `<span class="online-dot ${p?.online ? 'on' : ''}"></span>` : ''}
      </div>
      <div class="row-main">
        <div class="row-top"><span class="row-name">${esc(chatTitle(chat))}${p?.isBot ? '<span class="bot-tag">BOT</span>' : ''}</span>
        <span class="row-time ${chat.unread ? 'unread' : ''}">${listTime(lm?.ts || chat.createdAt)}</span></div>
        <div class="row-sub">${lm && lm.senderId === S.me.id ? ticksHtml(chat, lm) : ''}
          <span class="preview ${typing.length ? 'typing' : ''}">${preview}</span>
          ${chat.unread ? `<span class="unread-badge">${chat.unread}</span>` : ''}</div>
      </div>`;
    row.addEventListener('click', () => requestOpenChat(chat.id));
    el.appendChild(row);
  }
}

function renderPeople() {
  const el = $('#people-list');
  const q = S.search.toLowerCase();
  const users = [...S.users.values()]
    .filter((u) => u.id !== S.me.id)
    .filter((u) => !q || u.name.toLowerCase().includes(q) || u.id.toLowerCase().includes(q))
    .sort((a, b) => (b.isBot - a.isBot) || (b.online - a.online) || a.name.localeCompare(b.name));
  if (!users.length) {
    el.innerHTML = `<div class="list-empty"><span class="big-ic">🔍</span>කවුරුත් හම්බුනේ නෑ.<br>යාළුවාගේ <b>OZ-ID</b> එක search කරලා බලන්න.</div>`;
    return;
  }
  el.innerHTML = '';
  for (const u of users) {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `
      <div class="avatar-wrap">${avatarHtml({ emoji: u.avatar?.emoji, grad: u.avatar?.grad })}
        <span class="online-dot ${u.online ? 'on' : ''}"></span></div>
      <div class="row-main">
        <div class="row-top"><span class="row-name">${esc(u.name)}${u.isBot ? '<span class="bot-tag">BOT</span>' : ''}</span>
        <span class="row-time">${u.online ? '🟢 online' : ''}</span></div>
        <div class="row-sub"><span class="preview">${esc(u.about || u.id)}</span></div>
      </div>`;
    row.addEventListener('click', () => sendWs({ type: 'create_dm', peerId: u.id }));
    el.appendChild(row);
  }
}
function updateTitleBadge(n) {
  if (n === undefined) n = [...S.chats.values()].reduce((a, c) => a + (c.unread || 0), 0);
  document.title = n ? `(${n}) OneZchat 💬` : 'OneZchat — Chat Freely. Chat Securely.';
}

/* ============================================================
   CONVERSATION
   ============================================================ */
function requestOpenChat(chatId) {
  sendWs({ type: 'open_chat', chatId });
}
function openConversation(chatId) {
  S.activeChatId = chatId;
  $('#empty-state').classList.add('hidden');
  $('#conversation').classList.remove('hidden');
  $('#app').classList.add('chat-open');
  clearReply();
  syncConvHeader();
  renderChatList();
}
function closeConversation() {
  S.activeChatId = null;
  $('#conversation').classList.add('hidden');
  $('#empty-state').classList.remove('hidden');
  $('#app').classList.remove('chat-open');
  hideInfo();
  renderChatList();
}
function lastSeenText(u) {
  if (!u) return '';
  if (u.isBot) return 'always online 🤖';
  if (u.online) return 'online';
  const d = dayLabel(u.lastSeen);
  return `last seen ${d === 'Today' ? 'today' : d === 'Yesterday' ? 'yesterday' : d} at ${fmtTime(u.lastSeen)}`;
}
function syncConvHeader() {
  const chat = S.chats.get(S.activeChatId);
  if (!chat) return;
  const p = chatPeer(chat);
  $('#conv-avatar').outerHTML = chatAvatarHtml(chat).replace('class="avatar', 'id="conv-avatar" class="avatar');
  $('#conv-name').textContent = chatTitle(chat);
  const st = $('#conv-status');
  const typing = isTyping(chat);
  st.className = 'conv-status';
  if (typing.length) {
    st.textContent = chat.type === 'group' ? `${S.users.get(typing[0])?.name || 'Someone'} is typing…` : 'typing…';
    st.classList.add('typing');
  } else if (chat.type === 'group') {
    const names = chat.members.slice(0, 4).map((id) => id === S.me.id ? 'You' : (S.users.get(id)?.name || '…'));
    st.textContent = names.join(', ') + (chat.members.length > 4 ? ` +${chat.members.length - 4}` : '');
  } else {
    st.textContent = lastSeenText(p);
    if (p?.online || p?.isBot) st.classList.add('online');
  }
  const canCall = chat.type === 'dm' && !p?.isBot;
  $('#btn-call-audio').style.display = canCall ? '' : 'none';
  $('#btn-call-video').style.display = canCall ? '' : 'none';
}

function senderColor(chat, senderId) {
  const idx = Math.abs([...senderId].reduce((a, c) => a + c.charCodeAt(0), 0)) % 8;
  return ['#ff8a65','#4fc3f7','#ba68c8','#81c784','#ffd54f','#f06292','#4db6ac','#a1887f'][idx];
}

function bubbleInnerHtml(chat, msg) {
  const mine = msg.senderId === S.me.id;
  const sender = S.users.get(msg.senderId);
  let html = '';
  if (chat.type === 'group' && !mine && msg.kind !== 'system') {
    html += `<div class="sender-tag" style="color:${senderColor(chat, msg.senderId)}">${esc(sender?.name || 'Member')}</div>`;
  }
  if (msg.deleted) {
    html += `<span class="msg-text">🚫 This message was deleted</span>`;
  } else {
    const p = msg._p || S.payloadCache.get(msg.id);
    if (p && p.reply) html += `<div class="quote"><b>${esc(p.reply.name)}</b><span>${esc(p.reply.snippet)}</span></div>`;
    if (p === '__err__' || !p) {
      html += `<span class="msg-text">🔒 <i>Encrypted message — can't decrypt on this device</i></span>`;
    } else if (p.t === 'image') {
      html += `<img class="msg-img" src="${p.data}" alt="Photo">`;
      if (p.text) html += `<div class="caption msg-text">${fmtText(p.text)}</div>`;
    } else if (p.t === 'audio') {
      html += `<audio controls preload="metadata" src="${p.data}"></audio>`;
    } else {
      html += `<span class="msg-text">${fmtText(p.text || '')}</span>`;
    }
  }
  html += `<span class="msg-meta">${fmtTime(msg.ts)} ${mine ? ticksHtml(chat, msg) : ''}</span>`;
  // reactions
  const rEntries = Object.entries(msg.reactions || {});
  if (rEntries.length && !msg.deleted) {
    const counts = {};
    for (const [, e] of rEntries) counts[e] = (counts[e] || 0) + 1;
    html += `<div class="reactions">` + Object.entries(counts).map(([e, n]) => `<span>${e}${n > 1 ? ' ' + n : ''}</span>`).join('') + `</div>`;
  }
  return html;
}

function buildMessageRow(chat, msg, lastDayRef) {
  const frag = document.createDocumentFragment();
  const day = dayLabel(msg.ts);
  if (day !== lastDayRef.day) {
    lastDayRef.day = day;
    const sep = document.createElement('div'); sep.className = 'date-sep'; sep.textContent = day;
    frag.appendChild(sep);
  }
  if (msg.kind === 'system') {
    const s = document.createElement('div'); s.className = 'system-msg'; s.textContent = msg.text || '';
    frag.appendChild(s);
    return frag;
  }
  const mine = msg.senderId === S.me.id;
  const row = document.createElement('div');
  const hasR = Object.keys(msg.reactions || {}).length > 0 && !msg.deleted;
  row.className = `msg-row ${mine ? 'out' : 'in'}${hasR ? ' has-reactions' : ''}`;
  row.dataset.mid = msg.id;
  const b = document.createElement('div');
  b.className = 'bubble' + (msg.deleted ? ' deleted' : '') + (msg._pending ? ' pending' : '');
  b.innerHTML = bubbleInnerHtml(chat, msg);
  attachBubbleHandlers(b, chat, msg);
  row.appendChild(b);
  frag.appendChild(row);
  return frag;
}

function renderMessages(scrollBottom) {
  const chat = S.chats.get(S.activeChatId);
  const box = $('#messages');
  if (!chat) { box.innerHTML = ''; return; }
  const arr = S.messages.get(chat.id) || [];
  const wasNearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 160;
  box.innerHTML = '';
  const ref = { day: '' };
  for (const msg of arr) box.appendChild(buildMessageRow(chat, msg, ref));
  box.dataset.lastDay = ref.day;
  syncTypingBubble();
  if (scrollBottom || wasNearBottom) box.scrollTop = box.scrollHeight;
  $('#scroll-down').classList.toggle('hidden', wasNearBottom || scrollBottom);
}

function appendMessageRow(chat, msg) {
  const box = $('#messages');
  const wasNearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 220;
  const tb = $('#typing-row');
  const ref = { day: box.dataset.lastDay || '' };
  const frag = buildMessageRow(chat, msg, ref);
  if (tb) box.insertBefore(frag, tb); else box.appendChild(frag);
  box.dataset.lastDay = ref.day;
  if (wasNearBottom || msg.senderId === S.me.id) box.scrollTop = box.scrollHeight;
  else $('#scroll-down').classList.remove('hidden');
}

function refreshBubble(msg) {
  if (msg.chatId !== S.activeChatId) return;
  const chat = S.chats.get(msg.chatId);
  const row = $(`#messages .msg-row[data-mid="${msg.id}"]`);
  if (!row || !chat) return;
  const b = row.querySelector('.bubble');
  b.className = 'bubble' + (msg.deleted ? ' deleted' : '');
  b.innerHTML = bubbleInnerHtml(chat, msg);
  attachBubbleHandlers(b, chat, msg);
  row.classList.toggle('has-reactions', Object.keys(msg.reactions || {}).length > 0 && !msg.deleted);
}

function syncTypingBubble() {
  const chat = S.chats.get(S.activeChatId);
  const box = $('#messages');
  let tb = $('#typing-row');
  const typing = chat ? isTyping(chat) : [];
  if (typing.length && chat) {
    if (!tb) {
      tb = document.createElement('div');
      tb.id = 'typing-row'; tb.className = 'msg-row in';
      tb.innerHTML = '<div class="typing-bubble"><i></i><i></i><i></i></div>';
      box.appendChild(tb);
    }
    if (box.scrollHeight - box.scrollTop - box.clientHeight < 260) box.scrollTop = box.scrollHeight;
  } else if (tb) tb.remove();
}

function attachBubbleHandlers(b, chat, msg) {
  b.onclick = (e) => {
    const img = e.target.closest('img.msg-img');
    if (img) { openLightbox(img.src, (msg._p || S.payloadCache.get(msg.id))?.text || ''); return; }
    if (e.target.closest('audio') || e.target.closest('a')) return;
    openMsgMenu(e.clientX, e.clientY, chat, msg);
  };
  b.oncontextmenu = (e) => { e.preventDefault(); openMsgMenu(e.clientX, e.clientY, chat, msg); };
}

/* ---------------- sending ---------------- */
async function sendPayload(chat, payload) {
  if (S.replyTo) {
    payload.reply = { id: S.replyTo.id, name: S.replyTo.name, snippet: S.replyTo.snippet };
  }
  const replyToId = S.replyTo?.id || null;
  clearReply();
  const cid = OZCrypto.randomId('tmp_');
  const optimistic = {
    id: cid, _cid: cid, chatId: chat.id, senderId: S.me.id, kind: 'user',
    iv: null, ct: null, replyToId, ts: Date.now(),
    deliveredTo: [S.me.id], readBy: [S.me.id], reactions: {}, deleted: false,
    _p: payload, _pending: true,
  };
  const arr = S.messages.get(chat.id) || [];
  arr.push(optimistic); S.messages.set(chat.id, arr);
  chat.lastMessage = optimistic; chat._preview = payloadPreviewText(optimistic, payload);
  if (S.activeChatId === chat.id) appendMessageRow(chat, optimistic);
  renderChatList();
  try {
    const { iv, ct } = await encryptForChat(chat, payload);
    sendWs({ type: 'send_message', chatId: chat.id, iv, ct, replyToId, clientId: cid });
    sndSend();
    sendTyping(false);
  } catch (e) {
    toast('🔒 Encryption failed: ' + e.message, true);
  }
}

function sendCurrentText() {
  const chat = S.chats.get(S.activeChatId);
  const ta = $('#msg-input');
  const text = ta.value.trim();
  if (!chat || !text) return;
  ta.value = ''; autoGrow(ta); syncComposerButtons();
  sendPayload(chat, { t: 'text', text });
}

function autoGrow(ta) {
  ta.style.height = 'auto';
  ta.style.height = Math.min(120, ta.scrollHeight) + 'px';
}
function syncComposerButtons() {
  const has = $('#msg-input').value.trim().length > 0;
  $('#btn-send').classList.toggle('hidden', !has);
  $('#btn-mic').classList.toggle('hidden', has);
}

function sendTyping(on) {
  const chat = S.chats.get(S.activeChatId);
  if (!chat) return;
  if (on) {
    const now = Date.now();
    if (now - S.typingSentAt > 1800) { S.typingSentAt = now; sendWs({ type: 'typing', chatId: chat.id, isTyping: true }); }
    clearTimeout(S.typingStopTimer);
    S.typingStopTimer = setTimeout(() => sendTyping(false), 2400);
  } else {
    S.typingSentAt = 0;
    sendWs({ type: 'typing', chatId: chat.id, isTyping: false });
  }
}

/* reply */
function setReply(chat, msg) {
  const p = msg._p || S.payloadCache.get(msg.id);
  const sender = msg.senderId === S.me.id ? 'You' : (S.users.get(msg.senderId)?.name || 'Member');
  S.replyTo = { id: msg.id, name: sender, snippet: payloadPreviewText(msg, p).slice(0, 90) };
  $('#reply-to-name').textContent = '↩️ ' + sender;
  $('#reply-to-snippet').textContent = S.replyTo.snippet;
  $('#reply-bar').classList.remove('hidden');
  $('#msg-input').focus();
}
function clearReply() {
  S.replyTo = null;
  $('#reply-bar').classList.add('hidden');
}

/* images */
function fileToCompressedDataUrl(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const MAX = 1280;
      let { width: w, height: h } = img;
      const scale = Math.min(1, MAX / Math.max(w, h));
      w = Math.round(w * scale); h = Math.round(h * scale);
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      resolve(c.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = reject;
    img.src = url;
  });
}
async function sendImageFile(file) {
  const chat = S.chats.get(S.activeChatId);
  if (!chat || !file) return;
  if (!file.type.startsWith('image/')) { toast('📷 Image එකක්ම තෝරන්න', true); return; }
  try {
    toast('📷 Photo එක ready කරනවා…');
    const dataUrl = await fileToCompressedDataUrl(file);
    if (dataUrl.length > 3_800_000) { toast('⚠️ Photo එක ලොකු වැඩියි', true); return; }
    const caption = $('#msg-input').value.trim();
    $('#msg-input').value = ''; autoGrow($('#msg-input')); syncComposerButtons();
    sendPayload(chat, { t: 'image', data: dataUrl, text: caption || undefined });
  } catch { toast('⚠️ Photo එක යවන්න බැරි උනා', true); }
}

/* voice recording */
let recorder = null, recChunks = [], recStream = null, recStartedAt = 0, recTimer = null, recBlob = null;
async function toggleRecording() {
  if (recorder && recorder.state === 'recording') { stopRecording(true); return; }
  const chat = S.chats.get(S.activeChatId);
  if (!chat) return;
  try {
    recStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch { toast('🎤 Microphone permission දෙන්න ඕනේ', true); return; }
  recChunks = []; recBlob = null;
  recorder = new MediaRecorder(recStream);
  recorder.ondataavailable = (e) => { if (e.data.size) recChunks.push(e.data); };
  recorder.onstop = () => { recStream?.getTracks().forEach((t) => t.stop()); };
  recorder.start();
  recStartedAt = Date.now();
  $('#composer').classList.add('hidden');
  $('#rec-bar').classList.remove('hidden');
  $('#btn-mic').classList.add('recording');
  recTimer = setInterval(() => {
    const s = Math.floor((Date.now() - recStartedAt) / 1000);
    $('#rec-time').textContent = `${Math.floor(s / 60)}:${pad(s % 60)}`;
    if (s >= 300) stopRecording(true);
  }, 250);
}
function stopRecording(showSend) {
  if (!recorder) return;
  clearInterval(recTimer);
  const wasRecording = recorder.state === 'recording';
  const dur = Math.round((Date.now() - recStartedAt) / 1000);
  recorder.onstop = () => {
    recStream?.getTracks().forEach((t) => t.stop());
    recBlob = new Blob(recChunks, { type: recorder.mimeType || 'audio/webm' });
    recBlob._dur = dur;
    if (showSend) actuallySendVoice();
  };
  if (wasRecording) recorder.stop();
  recorder = null;
  $('#composer').classList.remove('hidden');
  $('#rec-bar').classList.add('hidden');
  $('#btn-mic').classList.remove('recording');
}
function actuallySendVoice() {
  const chat = S.chats.get(S.activeChatId);
  if (!chat || !recBlob) return;
  if (recBlob.size > 2_800_000) { toast('⚠️ Voice message එක දිග වැඩියි', true); return; }
  const reader = new FileReader();
  reader.onload = () => sendPayload(chat, { t: 'audio', data: reader.result, dur: recBlob._dur || 0 });
  reader.readAsDataURL(recBlob);
  recBlob = null;
}

/* lightbox */
function openLightbox(src, caption) {
  $('#lightbox-img').src = src;
  $('#lightbox-caption').textContent = caption || '';
  $('#lightbox').classList.remove('hidden');
}

/* ---------------- message menu ---------------- */
function openMsgMenu(x, y, chat, msg) {
  if (msg.kind === 'system' || msg._pending) return;
  S.menuMsg = { chat, msg };
  const menu = $('#msg-menu');
  const rEl = $('#msg-menu-reactions');
  rEl.innerHTML = '';
  for (const e of REACTIONS) {
    const b = document.createElement('button'); b.textContent = e;
    b.onclick = () => {
      const cur = msg.reactions?.[S.me.id];
      sendWs({ type: 'reaction', messageId: msg.id, emoji: cur === e ? '' : e });
      closeMenus();
    };
    rEl.appendChild(b);
  }
  const p = msg._p || S.payloadCache.get(msg.id);
  menu.querySelector('[data-act="delete"]').classList.toggle('hidden', msg.senderId !== S.me.id || msg.deleted);
  menu.querySelector('[data-act="download"]').classList.toggle('hidden', !(p && (p.t === 'image' || p.t === 'audio')));
  menu.querySelector('[data-act="copy"]').classList.toggle('hidden', !(p && p.t === 'text'));
  menu.classList.remove('hidden');
  const mw = 215, mh = 240;
  menu.style.left = Math.min(x, innerWidth - mw - 10) + 'px';
  menu.style.top = Math.min(y, innerHeight - mh - 10) + 'px';
}
function closeMenus() {
  $('#msg-menu').classList.add('hidden');
  $('#emoji-picker').classList.add('hidden');
  $('#main-menu').classList.add('hidden');
}

/* ============================================================
   INFO PANEL
   ============================================================ */
function showInfo() {
  const chat = S.chats.get(S.activeChatId);
  if (!chat) return;
  S.infoChatId = chat.id;
  $('#info-panel').classList.remove('hidden');
  renderInfo(chat);
}
function hideInfo() { $('#info-panel').classList.add('hidden'); S.infoChatId = null; }
function renderInfoIfOpen() {
  if (!S.infoChatId) return;
  const chat = S.chats.get(S.infoChatId);
  if (chat) renderInfo(chat);
}
function renderInfo(chat) {
  const body = $('#info-body');
  if (chat.type === 'dm') {
    const p = chatPeer(chat);
    body.innerHTML = `
      ${avatarHtml({ emoji: p?.avatar?.emoji, grad: p?.avatar?.grad, size: 'xl' })}
      <h3 style="font-size:1.3rem;font-weight:800">${esc(p?.name || '')}${p?.isBot ? '<span class="bot-tag">BOT</span>' : ''}</h3>
      <div class="muted">${esc(p?.id || '')}</div>
      <div class="${p?.online ? 'conv-status online' : 'muted'}">${esc(lastSeenText(p))}</div>
      <div class="info-section"><h4>About</h4><p>${esc(p?.about || '—')}</p></div>
      <div class="info-section"><h4>🔒 Encryption</h4>
      <p class="muted" style="font-size:.88rem;line-height:1.6">Messages in this chat are end-to-end encrypted with ECDH + AES-256-GCM. Only you and ${esc(p?.name?.split(' ')[0] || 'them')} can read them.</p></div>
      <button class="btn-ghost" id="info-copy-id">📋 Copy OneZ ID</button>`;
    $('#info-copy-id').onclick = () => copyText(p.id, 'ID එක copy උනා! 📋');
  } else {
    const members = chat.members.map((id) => S.users.get(id)).filter(Boolean);
    body.innerHTML = `
      ${avatarHtml({ text: groupInitials(chat.name), grad: chat.grad, size: 'xl' })}
      <h3 style="font-size:1.3rem;font-weight:800">${esc(chat.name || 'Group')}</h3>
      <div class="muted">Group · ${chat.members.length} members · Created ${dayLabel(chat.createdAt)}</div>
      <div class="info-section"><h4>🔒 Encryption</h4>
      <p class="muted" style="font-size:.88rem;line-height:1.6">Group messages are protected with a shared AES-256 key that only members hold.</p></div>
      <div class="info-section"><h4>Members</h4><div id="info-members"></div></div>
      <button class="btn-primary" id="info-add-member" style="width:100%">➕ Add Member</button>
      <button class="btn-ghost danger" id="info-leave" style="width:100%;color:#ff6b6b">🚪 Leave Group</button>`;
    const list = $('#info-members');
    for (const u of members) {
      const row = document.createElement('div');
      row.className = 'member-row';
      row.innerHTML = `
        ${avatarHtml({ emoji: u.avatar?.emoji, grad: u.avatar?.grad, size: 'sm' })}
        <div class="member-main"><div class="member-name">${esc(u.name)}${u.id === S.me.id ? ' (You)' : ''}</div>
        <div class="member-sub">${esc(u.id)} · ${u.online ? 'online' : 'offline'}</div></div>
        ${u.id === chat.createdBy ? '<span class="admin-tag">ADMIN</span>' : ''}`;
      if (u.id !== S.me.id) row.onclick = () => sendWs({ type: 'create_dm', peerId: u.id });
      list.appendChild(row);
    }
    $('#info-add-member').onclick = () => openAddMember(chat);
    $('#info-leave').onclick = () => {
      if (confirm(`"${chat.name}" group එකෙන් අයින් වෙන්නද?`)) {
        sendWs({ type: 'leave_group', chatId: chat.id });
        hideInfo();
      }
    };
  }
}

/* ============================================================
   GROUPS — create / add member (with key wrapping)
   ============================================================ */
let grpSelected = new Set(), grpGrad = 0;
function openModal(id) {
  $('#modal-backdrop').classList.remove('hidden');
  $(id).classList.remove('hidden');
}
function closeModals() {
  $('#modal-backdrop').classList.add('hidden');
  $$('.modal').forEach((m) => m.classList.add('hidden'));
}
function peoplePicker(el, { exclude, selected, onToggle, query }) {
  el.innerHTML = '';
  const q = (query || '').toLowerCase();
  const users = [...S.users.values()]
    .filter((u) => u.id !== S.me.id && !u.isBot && !exclude.has(u.id))
    .filter((u) => !q || u.name.toLowerCase().includes(q) || u.id.toLowerCase().includes(q))
    .sort((a, b) => (b.online - a.online) || a.name.localeCompare(b.name));
  if (!users.length) { el.innerHTML = '<div class="list-empty">කවුරුත් නෑ 🥲</div>'; return; }
  for (const u of users) {
    const row = document.createElement('button');
    row.className = 'pick-row' + (selected && selected.has(u.id) ? ' sel' : '');
    row.innerHTML = `
      ${avatarHtml({ emoji: u.avatar?.emoji, grad: u.avatar?.grad, size: 'sm' })}
      <span style="text-align:left"><span class="member-name" style="display:block">${esc(u.name)}</span>
      <span class="member-sub">${esc(u.id)} ${u.online ? '· 🟢' : ''}</span></span>
      ${selected ? '<span class="check">✓</span>' : '<span class="check" style="border:none;font-size:1.1rem">➕</span>'}`;
    row.onclick = () => onToggle(u);
    el.appendChild(row);
  }
}
function openGroupModal() {
  grpSelected = new Set(); grpGrad = Math.floor(Math.random() * 10);
  $('#grp-name').value = ''; $('#grp-search').value = '';
  pickerGrid($('#grp-grads'), Array.from({ length: 10 }), () => grpGrad, (v) => (grpGrad = v), true);
  const render = () => peoplePicker($('#grp-people'), {
    exclude: new Set(), selected: grpSelected, query: $('#grp-search').value,
    onToggle: (u) => { grpSelected.has(u.id) ? grpSelected.delete(u.id) : grpSelected.add(u.id); render(); syncGrpBtn(); },
  });
  $('#grp-search').oninput = render;
  render(); syncGrpBtn();
  openModal('#modal-group');
  setTimeout(() => $('#grp-name').focus(), 60);
}
function syncGrpBtn() {
  $('#grp-create').textContent = `Create Group 🎉 (${grpSelected.size + 1})`;
}
async function createGroup() {
  const name = $('#grp-name').value.trim();
  if (!name) { toast('Group එකට නමක් දාන්න 🙏', true); $('#grp-name').focus(); return; }
  if (!grpSelected.size) { toast('අඩුම තරමේ එක්කෙනෙක්වත් තෝරන්න 🙏', true); return; }
  const btn = $('#grp-create');
  btn.disabled = true; btn.textContent = '🔐 Keys හදනවා…';
  try {
    const gk = await OZCrypto.generateGroupKey();
    const members = [S.me.id, ...grpSelected];
    const wrappedKeys = {};
    for (const uid of members) {
      const u = S.users.get(uid);
      wrappedKeys[uid] = await OZCrypto.wrapGroupKey(gk, S.privKey, u.pubKey, S.me.id);
    }
    sendWs({ type: 'create_group', name, grad: grpGrad, memberIds: [...grpSelected], wrappedKeys });
    closeModals();
    toast('🎉 Group එක හැදුවා!');
  } catch (e) { toast('⚠️ ' + e.message, true); }
  btn.disabled = false; syncGrpBtn();
}
function openAddMember(chat) {
  const render = () => peoplePicker($('#add-people'), {
    exclude: new Set(chat.members), selected: null, query: $('#add-search').value,
    onToggle: async (u) => {
      try {
        const gk = await getChatKey(chat);
        const wrappedKey = await OZCrypto.wrapGroupKey(gk, S.privKey, u.pubKey, S.me.id);
        sendWs({ type: 'add_member', chatId: chat.id, userId: u.id, wrappedKey });
        closeModals();
        toast(`➕ ${u.name} group එකට add උනා!`);
      } catch (e) { toast('⚠️ Add කරන්න බැරි උනා: ' + e.message, true); }
    },
  });
  $('#add-search').value = '';
  $('#add-search').oninput = render;
  render();
  openModal('#modal-addmember');
}

/* ============================================================
   PROFILE
   ============================================================ */
let pfEmoji = '😀', pfGrad = 0;
function openProfile() {
  pfEmoji = S.me.avatar?.emoji || '😀'; pfGrad = S.me.avatar?.grad ?? 0;
  $('#pf-name').value = S.me.name;
  $('#pf-about').value = S.me.about || '';
  $('#pf-id').textContent = S.me.id;
  const sync = () => { const a = $('#pf-avatar'); a.className = 'avatar xl grad-' + pfGrad; a.textContent = pfEmoji; };
  pickerGrid($('#pf-emojis'), AVATAR_EMOJIS, () => pfEmoji, (v) => { pfEmoji = v; sync(); }, false);
  pickerGrid($('#pf-grads'), Array.from({ length: 10 }), () => pfGrad, (v) => { pfGrad = v; sync(); }, true);
  // re-wire preview sync for profile grid (pickerGrid calls syncObPreview — harmless — then ours)
  sync();
  openModal('#modal-profile');
}

/* ============================================================
   CALLS (WebRTC 1-to-1, DTLS-SRTP encrypted by the browser)
   ============================================================ */
const Call = {
  pc: null, stream: null, peerId: null, media: 'audio', state: 'idle',
  pendingOffer: null, iceQueue: [], timer: null, startedAt: 0, ringTimer: null, noAnswerTimer: null,
};
const RTC_CFG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }] };

function callSignal(data) { sendWs({ type: 'call_signal', to: Call.peerId, data }); }

async function startCall(media) {
  const chat = S.chats.get(S.activeChatId);
  if (!chat || chat.type !== 'dm') return;
  const peer = chatPeer(chat);
  if (!peer || peer.isBot) { toast('🤖 Bot එකට call ගන්න බෑ', true); return; }
  if (Call.state !== 'idle') { toast('📞 Already in a call', true); return; }
  if (!peer.online) { toast('🔴 ' + peer.name + ' දැන් offline', true); return; }
  Call.peerId = peer.id; Call.media = media; Call.state = 'calling';
  try {
    Call.stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: media === 'video' });
  } catch { toast('🎤 Camera/Mic permission දෙන්න ඕනේ', true); Call.state = 'idle'; return; }
  setupPc();
  Call.stream.getTracks().forEach((t) => Call.pc.addTrack(t, Call.stream));
  showCallScreen(peer, media === 'video' ? '📹 Video calling…' : '📞 Calling…');
  const offer = await Call.pc.createOffer();
  await Call.pc.setLocalDescription(offer);
  callSignal({ kind: 'invite', media, sdp: offer });
  Call.noAnswerTimer = setTimeout(() => { toast('📞 No answer'); endCall(true); }, 35000);
}

function setupPc() {
  Call.pc = new RTCPeerConnection(RTC_CFG);
  Call.iceQueue = [];
  Call.pc.onicecandidate = (e) => { if (e.candidate) callSignal({ kind: 'ice', candidate: e.candidate }); };
  Call.pc.ontrack = (e) => {
    const rv = $('#remote-video');
    if (rv.srcObject !== e.streams[0]) rv.srcObject = e.streams[0];
  };
  Call.pc.onconnectionstatechange = () => {
    if (!Call.pc) return;
    if (Call.pc.connectionState === 'connected') {
      clearTimeout(Call.noAnswerTimer);
      Call.state = 'incall'; Call.startedAt = Date.now();
      Call.timer = setInterval(() => {
        const s = Math.floor((Date.now() - Call.startedAt) / 1000);
        $('#cs-status').textContent = `🟢 ${pad(Math.floor(s / 60))}:${pad(s % 60)} · 🔒 encrypted`;
      }, 500);
    } else if (['disconnected', 'failed', 'closed'].includes(Call.pc.connectionState)) {
      if (Call.state !== 'idle') { toast('📞 Call ended'); endCall(false); }
    }
  };
}

function showCallScreen(peer, status) {
  $('#incoming-call').classList.add('hidden');
  stopRing();
  const av = $('#cs-avatar');
  av.className = 'avatar xl grad-' + (peer.avatar?.grad ?? 0); av.textContent = peer.avatar?.emoji || '😀';
  $('#cs-name').textContent = peer.name;
  $('#cs-status').textContent = status;
  $('#local-video').srcObject = Call.stream;
  $('#local-video').style.display = Call.media === 'video' ? '' : 'none';
  $('#remote-video').style.display = Call.media === 'video' ? '' : 'none';
  $('#cs-cam').style.display = Call.media === 'video' ? '' : 'none';
  $('#call-screen').classList.remove('hidden');
}

function startRing() {
  stopRing();
  const ring = () => { blip(880, 0.35, 'sine', 0.05); blip(1100, 0.35, 'sine', 0.04, 0.38); };
  ring();
  Call.ringTimer = setInterval(ring, 1800);
}
function stopRing() { clearInterval(Call.ringTimer); Call.ringTimer = null; }

async function onCallSignal(d) {
  const from = S.users.get(d.from);
  const data = d.data || {};
  if (data.kind === 'invite') {
    if (Call.state !== 'idle') { sendWs({ type: 'call_signal', to: d.from, data: { kind: 'busy' } }); return; }
    Call.peerId = d.from; Call.media = data.media || 'audio';
    Call.pendingOffer = data.sdp; Call.state = 'ringing';
    const av = $('#ic-avatar');
    av.className = 'avatar xl grad-' + (from?.avatar?.grad ?? 0); av.textContent = from?.avatar?.emoji || '😀';
    $('#ic-name').textContent = from?.name || 'Someone';
    $('#ic-kind').textContent = Call.media === 'video' ? '📹 Incoming video call…' : '📞 Incoming voice call…';
    $('#incoming-call').classList.remove('hidden');
    startRing();
    Call.noAnswerTimer = setTimeout(() => { if (Call.state === 'ringing') endCall(false, true); }, 40000);
  } else if (data.kind === 'answer') {
    if (Call.pc && Call.state === 'calling') {
      clearTimeout(Call.noAnswerTimer);
      await Call.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      flushIce();
      $('#cs-status').textContent = 'Connecting…';
    }
  } else if (data.kind === 'ice') {
    if (Call.pc && Call.pc.remoteDescription) { try { await Call.pc.addIceCandidate(data.candidate); } catch {} }
    else Call.iceQueue.push(data.candidate);
  } else if (data.kind === 'hangup') {
    if (Call.state !== 'idle') { toast('📞 Call ended'); endCall(false); }
  } else if (data.kind === 'reject') {
    toast('📞 Call declined'); endCall(false);
  } else if (data.kind === 'busy') {
    toast('📞 Busy on another call'); endCall(false);
  }
}
async function flushIce() {
  for (const c of Call.iceQueue) { try { await Call.pc.addIceCandidate(c); } catch {} }
  Call.iceQueue = [];
}
async function acceptCall() {
  const peer = S.users.get(Call.peerId);
  try {
    Call.stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: Call.media === 'video' });
  } catch { toast('🎤 Camera/Mic permission දෙන්න ඕනේ', true); callSignal({ kind: 'reject' }); endCall(false); return; }
  clearTimeout(Call.noAnswerTimer);
  Call.state = 'incall';
  setupPc();
  Call.stream.getTracks().forEach((t) => Call.pc.addTrack(t, Call.stream));
  await Call.pc.setRemoteDescription(new RTCSessionDescription(Call.pendingOffer));
  flushIce();
  const answer = await Call.pc.createAnswer();
  await Call.pc.setLocalDescription(answer);
  callSignal({ kind: 'answer', sdp: answer });
  showCallScreen(peer, 'Connecting…');
}
function endCall(notify, silent) {
  if (notify && Call.peerId) callSignal({ kind: Call.state === 'ringing' ? 'reject' : 'hangup' });
  stopRing();
  clearTimeout(Call.noAnswerTimer); clearInterval(Call.timer);
  try { Call.pc?.close(); } catch {}
  Call.stream?.getTracks().forEach((t) => t.stop());
  Call.pc = null; Call.stream = null; Call.peerId = null; Call.state = 'idle'; Call.pendingOffer = null;
  $('#call-screen').classList.add('hidden');
  $('#incoming-call').classList.add('hidden');
  $('#remote-video').srcObject = null; $('#local-video').srcObject = null;
  if (silent) toast('📞 Missed call');
}

/* ============================================================
   EMOJI PICKER
   ============================================================ */
function buildEmojiPicker() {
  const el = $('#emoji-picker');
  el.innerHTML = '';
  for (const e of PICKER_EMOJIS) {
    const b = document.createElement('button'); b.textContent = e;
    b.onclick = () => {
      const ta = $('#msg-input');
      const pos = ta.selectionStart || ta.value.length;
      ta.value = ta.value.slice(0, pos) + e + ta.value.slice(ta.selectionEnd || pos);
      ta.focus(); ta.selectionStart = ta.selectionEnd = pos + e.length;
      autoGrow(ta); syncComposerButtons();
    };
    el.appendChild(b);
  }
}
function toggleEmojiPicker() {
  const el = $('#emoji-picker');
  if (!el.classList.contains('hidden')) { el.classList.add('hidden'); return; }
  const r = $('#btn-emoji').getBoundingClientRect();
  el.style.left = Math.min(r.left, innerWidth - 345) + 'px';
  el.style.bottom = (innerHeight - r.top + 10) + 'px';
  el.classList.remove('hidden');
}

/* ============================================================
   GLOBAL UI bindings
   ============================================================ */
function bindGlobalUi() {
  // tabs
  $('#tab-chats').onclick = () => setTab('chats');
  $('#tab-people').onclick = () => setTab('people');
  $('#search').addEventListener('input', (e) => { S.search = e.target.value; renderChatList(); renderPeople(); });

  // header
  $('#btn-theme').onclick = () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  $('#btn-new-group').onclick = openGroupModal;
  $('#me-avatar-btn').onclick = openProfile;
  $('#btn-menu').onclick = (e) => { e.stopPropagation(); $('#main-menu').classList.toggle('hidden'); };
  $('#main-menu').addEventListener('click', (e) => {
    const act = e.target.closest('button')?.dataset.act;
    if (!act) return;
    closeMenus();
    if (act === 'profile') openProfile();
    if (act === 'copyid') copyText(S.me.id, 'OneZ ID එක copy උනා! 📋');
    if (act === 'newgroup') openGroupModal();
    if (act === 'theme') $('#btn-theme').click();
    if (act === 'logout') {
      if (confirm('⚠️ Logout කළොත් මේ device එකේ OneZ ID එක මැකෙනවා. ආයෙත් ඒ ID එක ගන්න බෑ. Sure?')) {
        document.body.dataset.loggedOut = '1';
        localStorage.removeItem(LS_ID);
        try { S.ws?.close(); } catch {}
        location.reload();
      }
    }
  });
  $('#empty-copy-id').onclick = () => copyText(S.me.id, 'OneZ ID එක copy උනා! 📋');

  // conversation header
  $('#btn-back').onclick = closeConversation;
  $('#conv-title-btn').onclick = showInfo;
  $('#btn-info').onclick = showInfo;
  $('#info-close').onclick = hideInfo;
  $('#btn-call-audio').onclick = () => startCall('audio');
  $('#btn-call-video').onclick = () => startCall('video');

  // composer
  const ta = $('#msg-input');
  ta.addEventListener('input', () => { autoGrow(ta); syncComposerButtons(); if (ta.value.trim()) sendTyping(true); });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendCurrentText(); }
  });
  $('#btn-send').onclick = sendCurrentText;
  $('#btn-mic').onclick = toggleRecording;
  $('#rec-cancel').onclick = () => { recBlob = null; stopRecording(false); };
  $('#rec-send').onclick = () => stopRecording(true);
  $('#btn-attach').onclick = () => $('#file-input').click();
  $('#file-input').addEventListener('change', (e) => { sendImageFile(e.target.files[0]); e.target.value = ''; });
  $('#btn-emoji').onclick = (e) => { e.stopPropagation(); toggleEmojiPicker(); };
  $('#reply-cancel').onclick = clearReply;
  $('#messages').addEventListener('scroll', () => {
    const box = $('#messages');
    const near = box.scrollHeight - box.scrollTop - box.clientHeight < 160;
    $('#scroll-down').classList.toggle('hidden', near);
  });
  $('#scroll-down').onclick = () => { const b = $('#messages'); b.scrollTop = b.scrollHeight; };

  // drag & drop / paste images
  document.addEventListener('paste', (e) => {
    const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
    if (item && S.activeChatId) sendImageFile(item.getAsFile());
  });
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = e.dataTransfer?.files?.[0];
    if (f && S.activeChatId) sendImageFile(f);
  });

  // message menu actions
  $('#msg-menu').addEventListener('click', (e) => {
    const act = e.target.closest('button')?.dataset.act;
    if (!act || !S.menuMsg) return;
    const { chat, msg } = S.menuMsg;
    const p = msg._p || S.payloadCache.get(msg.id);
    if (act === 'reply') setReply(chat, msg);
    if (act === 'copy' && p?.text) copyText(p.text);
    if (act === 'download' && p?.data) {
      const a = document.createElement('a');
      a.href = p.data; a.download = 'onezchat-' + msg.id + (p.t === 'image' ? '.jpg' : '.webm'); a.click();
    }
    if (act === 'delete') {
      if (confirm('මේ message එක හැමෝටම පේන විදියට delete කරන්නද?')) sendWs({ type: 'delete_message', messageId: msg.id });
    }
    closeMenus();
  });

  // modals
  $('#modal-backdrop').onclick = closeModals;
  $$('[data-close]').forEach((b) => (b.onclick = closeModals));
  $('#grp-create').onclick = createGroup;
  $('#grp-name').addEventListener('input', syncGrpBtn);
  $('#pf-copy').onclick = () => copyText(S.me.id, 'OneZ ID එක copy උනා! 📋');
  $('#pf-save').onclick = () => {
    const name = $('#pf-name').value.trim();
    if (!name) { toast('නම හිස් තියන්න බෑ', true); return; }
    sendWs({ type: 'update_profile', name, about: $('#pf-about').value.trim(), avatar: { emoji: pfEmoji, grad: pfGrad } });
    closeModals();
    toast('✅ Profile එක update උනා!');
  };

  // lightbox
  $('#lightbox-close').onclick = () => $('#lightbox').classList.add('hidden');
  $('#lightbox').addEventListener('click', (e) => { if (e.target.id === 'lightbox') $('#lightbox').classList.add('hidden'); });

  // calls
  $('#ic-accept').onclick = acceptCall;
  $('#ic-reject').onclick = () => endCall(true);
  $('#cs-hangup').onclick = () => endCall(true);
  $('#cs-mute').onclick = (e) => {
    const t = Call.stream?.getAudioTracks()[0]; if (!t) return;
    t.enabled = !t.enabled;
    e.currentTarget.classList.toggle('off', !t.enabled);
    e.currentTarget.textContent = t.enabled ? '🎤' : '🔇';
  };
  $('#cs-cam').onclick = (e) => {
    const t = Call.stream?.getVideoTracks()[0]; if (!t) return;
    t.enabled = !t.enabled;
    e.currentTarget.classList.toggle('off', !t.enabled);
    e.currentTarget.textContent = t.enabled ? '🎥' : '🚫';
  };

  // close popovers on outside click / Esc
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#msg-menu') && !e.target.closest('.bubble')) $('#msg-menu').classList.add('hidden');
    if (!e.target.closest('#emoji-picker') && !e.target.closest('#btn-emoji')) $('#emoji-picker').classList.add('hidden');
    if (!e.target.closest('#main-menu') && !e.target.closest('#btn-menu')) $('#main-menu').classList.add('hidden');
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeMenus(); closeModals(); $('#lightbox').classList.add('hidden'); }
  });
  // when tab becomes visible again, mark active chat read
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && S.activeChatId) {
      sendWs({ type: 'read', chatId: S.activeChatId });
      const c = S.chats.get(S.activeChatId);
      if (c) { c.unread = 0; renderChatList(); }
    }
  });
}
function setTab(tab) {
  S.tab = tab;
  $('#tab-chats').classList.toggle('active', tab === 'chats');
  $('#tab-people').classList.toggle('active', tab === 'people');
  $('#chat-list').classList.toggle('hidden', tab !== 'chats');
  $('#people-list').classList.toggle('hidden', tab !== 'people');
  if (tab === 'people') renderPeople(); else renderChatList();
}

/* profile grid preview fallback (pickerGrid calls this) */
function syncObPreviewProfile() {}

document.addEventListener('DOMContentLoaded', boot);
