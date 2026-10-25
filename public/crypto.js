/* ============================================================
   OneZchat Crypto — End-to-End Encryption (browser WebCrypto)
   - Identity: ECDH P-256 key pair generated ON THIS DEVICE.
     The private key NEVER leaves the device.
   - 1-to-1 chats: ECDH shared secret -> AES-256-GCM key
   - Groups: random AES-256 key, wrapped per-member with ECDH
   - The server only ever sees ciphertext (iv + ct).
   ============================================================ */
'use strict';

const OZCrypto = (() => {
  const subtle = window.crypto && window.crypto.subtle;
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  const supported = !!subtle;

  /* ---------- base64 helpers ---------- */
  function bufToB64(buf) {
    const bytes = new Uint8Array(buf);
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  }
  function b64ToBuf(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  /* ---------- identity ---------- */
  async function generateIdentity() {
    const kp = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']);
    const pubJwk = await subtle.exportKey('jwk', kp.publicKey);
    const privJwk = await subtle.exportKey('jwk', kp.privateKey);
    return {
      privateKey: kp.privateKey,
      pubJwk: { kty: pubJwk.kty, crv: pubJwk.crv, x: pubJwk.x, y: pubJwk.y },
      privJwk,
    };
  }
  async function importPrivate(jwk) {
    return subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']);
  }
  async function importPublic(jwk) {
    return subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  }

  /* ---------- shared (1-to-1 / wrapping) keys ---------- */
  async function deriveShared(myPrivateKey, peerPubJwk) {
    const peerPub = await importPublic(peerPubJwk);
    return subtle.deriveKey(
      { name: 'ECDH', public: peerPub }, myPrivateKey,
      { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
    );
  }

  /* ---------- AES-GCM encrypt / decrypt ---------- */
  async function encryptBytes(key, bytes) {
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes);
    return { iv: bufToB64(iv), ct: bufToB64(ct) };
  }
  async function decryptBytes(key, ivB64, ctB64) {
    const pt = await subtle.decrypt(
      { name: 'AES-GCM', iv: b64ToBuf(ivB64) }, key, b64ToBuf(ctB64)
    );
    return new Uint8Array(pt);
  }
  async function encryptJSON(key, obj) {
    return encryptBytes(key, enc.encode(JSON.stringify(obj)));
  }
  async function decryptJSON(key, ivB64, ctB64) {
    const bytes = await decryptBytes(key, ivB64, ctB64);
    return JSON.parse(dec.decode(bytes));
  }

  /* ---------- group keys ---------- */
  async function generateGroupKey() {
    return subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  }
  async function exportRaw(key) {
    return new Uint8Array(await subtle.exportKey('raw', key));
  }
  async function importRaw(bytes) {
    return subtle.importKey('raw', bytes, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  }
  /** Wrap a group key for one member using my ECDH shared key with them. */
  async function wrapGroupKey(groupKey, myPrivateKey, memberPubJwk, myId) {
    const shared = await deriveShared(myPrivateKey, memberPubJwk);
    const raw = await exportRaw(groupKey);
    const { iv, ct } = await encryptBytes(shared, raw);
    return { iv, ct, by: myId };
  }
  /** Unwrap my copy of a group key (wrapped by `wrapped.by`). */
  async function unwrapGroupKey(wrapped, myPrivateKey, wrapperPubJwk) {
    const shared = await deriveShared(myPrivateKey, wrapperPubJwk);
    const raw = await decryptBytes(shared, wrapped.iv, wrapped.ct);
    return importRaw(raw);
  }

  function randomId(prefix) {
    const b = window.crypto.getRandomValues(new Uint8Array(8));
    return prefix + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  }

  return {
    supported, bufToB64, b64ToBuf,
    generateIdentity, importPrivate, importPublic, deriveShared,
    encryptJSON, decryptJSON, encryptBytes, decryptBytes,
    generateGroupKey, exportRaw, importRaw, wrapGroupKey, unwrapGroupKey,
    randomId,
  };
})();
