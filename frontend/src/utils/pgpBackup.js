// A backup of the user's private keys, and bringing one back (Settings → Encryption).
//
// The backup is armored private key blocks, one per key, one after the other in a .asc file:
// what `gpg --import` reads (pgpBackup.test.js imports one into a real GnuPG when it is
// installed). A key that unlocks with the Plimail password is encrypted for the file with a
// passphrase the user chooses, since the secret derived from the password is nothing anyone could
// type; a key with its own passphrase goes as it is, still locked with that one.
//
// Restoring reads every block of such a file (OpenPGP.js reads only the first of several), opens
// each key with the passphrase given and protects it as the user asks: with the secret of the
// current Plimail password, or with a passphrase of its own. A key the user still has (the same
// fingerprint) has its stored private half replaced, which is how a key left under a forgotten
// password comes back; any other key is added.

import { PgpError, keyInfo, loadOpenpgp } from './pgp.js';
import { isLoginKey, lockKey } from './pgpKeys.js';

// The armored backup of `keys` (rows of GET /api/pgp/keys). `open(row)` gives a 'login' key
// unlocked (pgpUnlock.js unlockOwnKey, which asks for what it has to).
export async function buildKeyBackup(keys, { passphrase, open, lock = lockKey }) {
  const blocks = [];
  for (const k of keys || []) {
    if (!isLoginKey(k)) { blocks.push(k.armoredPrivate.trim()); continue; }
    if (!passphrase) throw new PgpError('passphraseRequired');
    blocks.push((await lock(await open(k), passphrase)).trim());
  }
  if (!blocks.length) throw new PgpError('noKeys');
  return `${blocks.join('\n\n')}\n`;
}

const BLOCK = /-----BEGIN PGP PRIVATE KEY BLOCK-----[\s\S]*?-----END PGP PRIVATE KEY BLOCK-----/g;

// Every private key in `text`, each once, however many armored blocks it is in.
export async function readPrivateKeyBlocks(text) {
  const openpgp = await loadOpenpgp();
  const blocks = String(text || '').match(BLOCK) || [];
  if (!blocks.length) throw new PgpError('invalidKey');
  const seen = new Set();
  const keys = [];
  for (const armoredKeys of blocks) {
    let read;
    try {
      read = await openpgp.readPrivateKeys({ armoredKeys });
    } catch {
      throw new PgpError('invalidKey');
    }
    for (const key of read) {
      const fp = key.getFingerprint();
      if (!seen.has(fp)) { seen.add(fp); keys.push(key); }
    }
  }
  return keys;
}

// The keys of a backup (or any private key file), ready to store: { keys, unopened }.
//   `secret`         protect each with the Plimail password's secret ('login'), or else
//   `newPassphrase`  for a key that has no passphrase at all: none is stored unprotected
// A key `passphrase` does not open is counted in `unopened` (a backup can hold keys with their own
// passphrases: they come in with another try); none opening at all is PgpError('wrongPassphrase').
export async function prepareKeysFromBackup(text, { passphrase = '', secret = null, newPassphrase = '' } = {}) {
  const openpgp = await loadOpenpgp();
  const out = [];
  let unopened = 0;
  for (const key of await readPrivateKeyBlocks(text)) {
    let open;
    if (key.isDecrypted()) {
      if (!secret && !newPassphrase) throw new PgpError('unprotectedKey');
      open = key;
    } else {
      try {
        open = await openpgp.decryptKey({ privateKey: key, passphrase });
      } catch {
        unopened += 1;
        continue;
      }
    }
    let armoredPrivate;
    if (secret) armoredPrivate = await lockKey(open, secret);
    else if (key.isDecrypted()) armoredPrivate = await lockKey(open, newPassphrase);
    else armoredPrivate = key.armor();
    out.push({
      fingerprint: key.getFingerprint(),
      emails: (await keyInfo(key)).emails,
      armoredPrivate,
      armoredPublic: key.toPublic().armor(),
      protection: secret ? 'login' : 'passphrase',
    });
  }
  if (!out.length) throw new PgpError('wrongPassphrase');
  return { keys: out, unopened };
}

// Stores what prepareKeysFromBackup gave: a key the user has already (`ownKeys`) has its private
// half replaced, all of them in one request (PUT /api/pgp/keys/protection, which also clears a
// stale mark); the others are added. `accountFor(emails)` gives the account a new key belongs to.
// Resolves to { added, restored }: the new rows, and the ids of the replaced ones.
export async function storeRestoredKeys(prepared, { ownKeys, addKey, setProtection, accountFor = () => null }) {
  const byFingerprint = new Map((ownKeys || []).map(k => [String(k.fingerprint).toLowerCase(), k]));
  const updates = [];
  const fresh = [];
  for (const p of prepared) {
    const have = byFingerprint.get(p.fingerprint.toLowerCase());
    if (have) updates.push({ id: have.id, armoredPrivate: p.armoredPrivate, protection: p.protection });
    else fresh.push(p);
  }
  if (updates.length) await setProtection(updates);
  const added = [];
  for (const p of fresh) {
    const { key } = await addKey({ armoredPrivate: p.armoredPrivate, armoredPublic: p.armoredPublic, accountId: accountFor(p.emails), protection: p.protection });
    added.push(key);
  }
  return { added, restored: updates.map(u => u.id) };
}
