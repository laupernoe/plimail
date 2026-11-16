// The secret that unlocks the user's OpenPGP keys without them typing anything: a passphrase
// derived in this browser from the Plimail password, which every key Plimail makes for them is
// encrypted with (pgp_keys.protection 'login', utils/pgpKeys.js).
//
// PBKDF2-SHA-256 over the password, with a salt the server keeps per user (GET /api/pgp/kdf) and
// a label that keeps this derivation apart from any other use of the password. The server stores
// a bcrypt hash of the password and never receives what is derived here, so what it holds does
// not unlock the keys. It does see the password itself at every sign-in, as any password login
// does: a server that was made to record passwords could derive the secret too. That is the
// trade-off of keys that unlock at sign-in without a second password.
//
// The derived secret is kept in this tab's memory and in sessionStorage, so a reload of the same
// tab does not ask again. sessionStorage belongs to the tab (a new tab or window starts without it,
// though a duplicated tab copies it) and lasts until the tab closes, or until sign-out or the
// screen lock clear it here. Script running in the page could read it there, as it could read an
// unlocked key in memory; nothing else can.

export const KDF_ITERATIONS = 600_000;
const LABEL = 'plimail/pgp-key-passphrase/v1:';
export const STORAGE_KEY = 'plimail_pgp_secret';

const utf8 = s => new TextEncoder().encode(s);
const fromBase64 = b64 => Uint8Array.from(atob(String(b64 || '')), c => c.charCodeAt(0));
const toBase64Url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// The key passphrase for `password` and the user's salt (base64): 'v1.' and 32 bytes, base64url.
export async function deriveKeySecret(password, saltBase64, { iterations = KDF_ITERATIONS, subtle = globalThis.crypto?.subtle } = {}) {
  if (!subtle) throw Object.assign(new Error('secure_context_required'), { code: 'insecure' });
  if (typeof password !== 'string' || !password) throw new TypeError('password is required');
  const saltBytes = fromBase64(saltBase64);
  if (saltBytes.length < 16) throw new TypeError('salt must be at least 16 bytes');
  const label = utf8(LABEL);
  const salt = new Uint8Array(label.length + saltBytes.length);
  salt.set(label);
  salt.set(saltBytes, label.length);
  const base = await subtle.importKey('raw', utf8(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, 256);
  return `v1.${toBase64Url(new Uint8Array(bits))}`;
}

// { userId, secret, verified }: `verified` when it came from the Plimail password as the server
// knows it now (signing in, or a password it confirmed), so a key it does not open was made under
// an earlier password. A secret an SSO user chose has nothing to be checked against.
let current = null;
let pending = null; // { userId, promise }
// Who is signed in, for code that has no store to ask (the reader): set on every sign-in and out.
let owner = null;
export const keySecretOwner = () => owner;
export function setKeySecretOwner(userId) {
  owner = userId || null;
}
const listeners = new Set();

function sessionStore() {
  try { return globalThis.sessionStorage || null; } catch { return null; }
}

function changed() {
  for (const fn of [...listeners]) {
    try { fn(); } catch { /* a listener's failure is its own */ }
  }
}

export function subscribeKeySecret(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function setKeySecret(userId, secret, { verified = true } = {}) {
  if (!userId || !secret) return;
  current = { userId, secret, verified };
  try { sessionStore()?.setItem(STORAGE_KEY, JSON.stringify(current)); } catch { /* memory only, then */ }
  changed();
}

// The secret for `userId`, from memory or, after a reload, this tab's sessionStorage; null when
// there is none (a new tab, an SSO sign-in, after the screen lock).
export function keySecretEntry(userId) {
  if (!userId) return null;
  if (current?.userId === userId) return current;
  try {
    const raw = sessionStore()?.getItem(STORAGE_KEY);
    const saved = raw ? JSON.parse(raw) : null;
    if (saved?.userId === userId && typeof saved.secret === 'string' && saved.secret) {
      current = { userId, secret: saved.secret, verified: saved.verified !== false };
      return current;
    }
  } catch { /* unreadable: as if there were none */ }
  return null;
}

export const keySecret = userId => keySecretEntry(userId)?.secret || null;

export function forgetKeySecret() {
  const had = current != null || pending != null;
  current = null;
  pending = null;
  try { sessionStore()?.removeItem(STORAGE_KEY); } catch { /* nothing kept to remove */ }
  if (had) changed();
}

// On sign-in as `userId`: a secret kept for anyone else goes.
export function keepKeySecretOnlyFor(userId) {
  const saved = keySecretEntry(userId);
  if (saved) {
    if (pending && pending.userId !== userId) pending = null;
    return;
  }
  forgetKeySecret();
}

// Derives the secret from the password the user just signed in with, in the background: the
// sign-in does not wait for it. Whatever needs a key meanwhile waits on waitForKeySecret.
export function establishKeySecret(userId, password, { fetchSalt, derive = deriveKeySecret } = {}) {
  if (!userId || !password || typeof fetchSalt !== 'function') return Promise.resolve(null);
  const promise = (async () => {
    const { salt } = await fetchSalt();
    const secret = await derive(password, salt);
    if (pending?.promise === promise) {
      pending = null;
      setKeySecret(userId, secret, { verified: true });
    }
    return secret;
  })().catch((err) => {
    if (pending?.promise === promise) pending = null;
    console.warn(`[pgp] could not prepare the key passphrase: ${err?.message || err}`);
    return null;
  });
  pending = { userId, promise };
  return promise;
}

// The secret, once a derivation still running has finished; null if there is none.
export async function waitForKeySecret(userId) {
  const now = keySecret(userId);
  if (now) return now;
  if (pending?.userId === userId) await pending.promise;
  return keySecret(userId);
}
