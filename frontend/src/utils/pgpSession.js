// Private keys unlocked with their passphrase, held in this tab's memory and nowhere else: not in
// localStorage, sessionStorage or IndexedDB, and never sent anywhere. A reload, a sign-out or
// closing the tab forgets them. A key is kept only when the user asked to remember it for the
// session; otherwise the caller uses it once and lets it go.

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

export function forgetAllUnlockedKeys() {
  unlocked.clear();
}

export function unlockedCount() {
  return unlocked.size;
}
