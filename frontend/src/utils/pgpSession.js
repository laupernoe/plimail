import { forgetKeySecret, keepKeySecretOnlyFor } from './pgpSecret.js';

// Private keys unlocked with their passphrase, held in this tab's memory and nowhere else: not in
// localStorage, sessionStorage or IndexedDB, and never sent anywhere. A reload, a sign-out or
// closing the tab forgets them. A key is kept only when the user asked to remember it for the
// session; otherwise the caller uses it once and lets it go. The secret that unlocks the keys
// protected by the Plimail password (utils/pgpSecret.js) goes with them.

const unlocked = new Map(); // fingerprint -> decrypted OpenPGP.js PrivateKey

export function rememberUnlockedKey(fingerprint, key) {
  if (fingerprint && key) unlocked.set(String(fingerprint).toLowerCase(), key);
}

export function unlockedKey(fingerprint) {
  return unlocked.get(String(fingerprint || '').toLowerCase()) || null;
}

export function isUnlocked(fingerprint) {
  return unlocked.has(String(fingerprint || '').toLowerCase());
}

export function forgetUnlockedKey(fingerprint) {
  unlocked.delete(String(fingerprint || '').toLowerCase());
}

// Locking the screen, signing out, "Lock keys": every key and the secret go. `keepSecretFor`: a
// sign-in, after which a secret kept in this tab for that same user stays (a reload).
export function forgetAllUnlockedKeys({ keepSecretFor = null } = {}) {
  unlocked.clear();
  if (keepSecretFor) keepKeySecretOnlyFor(keepSecretFor);
  else forgetKeySecret();
}

export function unlockedCount() {
  return unlocked.size;
}
