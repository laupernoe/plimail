// The user's own OpenPGP keys without the user handling them: made by Plimail for each address
// the first time one is wanted, protected by the secret derived from the Plimail password
// (utils/pgpSecret.js), unlocked with it silently, and encrypted again when that password
// changes. Keys that keep a passphrase of their own (imported, or made in Settings → Advanced)
// work as before: the user gives the passphrase when one is needed.

import { PgpError, generateKeyPair, loadOpenpgp, unlockPrivateKey } from './pgp.js';
import { rememberUnlockedKey, unlockedKey } from './pgpSession.js';

export const isLoginKey = row => row?.protection === 'login';

// The private key `row` opened, from this tab's unlocked keys or with what opens it: `secret` for
// a 'login' key, `passphrase` for one with its own. Throws PgpError:
//   'needsSecret'      a login key and no secret yet (ask for the Plimail password)
//   'staleSecret'      the secret does not open it: the key was protected under an earlier
//                      password (only said for a `verified` secret, utils/pgpSecret.js)
//   'needsPassphrase'  a key with its own passphrase and none given
//   'wrongPassphrase'  the passphrase, or an unverified secret, does not open it
// A key opened here stays unlocked for the tab (pgpSession.js) unless `remember` is false.
export async function openOwnKey(row, { secret = null, verified = true, passphrase = '', remember = true, unlock = unlockPrivateKey } = {}) {
  const cached = unlockedKey(row.fingerprint);
  if (cached) return cached;
  let key;
  if (isLoginKey(row)) {
    if (!secret) throw new PgpError('needsSecret');
    try {
      key = await unlock(row.armoredPrivate, secret);
    } catch (err) {
      if (err?.code === 'wrongPassphrase') throw new PgpError(verified ? 'staleSecret' : 'wrongPassphrase');
      throw err;
    }
  } else {
    if (!passphrase) throw new PgpError('needsPassphrase');
    key = await unlock(row.armoredPrivate, passphrase);
  }
  if (remember) rememberUnlockedKey(row.fingerprint, key);
  return key;
}

// An unlocked private key encrypted with `passphrase`, armored, as the server stores keys.
export async function lockKey(privateKey, passphrase) {
  if (!passphrase) throw new PgpError('passphraseRequired');
  const openpgp = await loadOpenpgp();
  const locked = await openpgp.encryptKey({ privateKey, passphrase });
  return locked.armor();
}

// The user's 'login' keys encrypted for the secret `to` instead of `from`, for PUT
// /api/pgp/keys/protection, the Plimail password having changed. A key `to` already opens is left
// as it is (a re-encryption that was interrupted, then run again). Nothing is returned unless
// every other key opened with `from`: a key that does not throws PgpError('wrongPassphrase') and
// the server is not asked to change anything, so no key is ever left behind under a password the
// user no longer has while the others move.
// `onOpened(row, key)` gets each key opened on the way, for the caller to keep unlocked (the
// caller's copy of a row still holds the old encryption until the keys are read again).
// `onUnopened(row)`: the caller has asked the user and lets a key `from` does not open stay as it
// is; it is reported there and left out instead of stopping the others.
export async function rewrapLoginKeys(rows, { from, to, unlock = unlockPrivateKey, lock = lockKey, onOpened = null, onUnopened = null }) {
  if (!from || !to) throw new PgpError('passphraseRequired');
  const updates = [];
  for (const row of (rows || []).filter(isLoginKey)) {
    try {
      await unlock(row.armoredPrivate, to);
      continue;
    } catch (err) {
      if (err?.code !== 'wrongPassphrase') throw err;
    }
    let key;
    try {
      key = await unlock(row.armoredPrivate, from);
    } catch (err) {
      if (err?.code !== 'wrongPassphrase' || !onUnopened) throw err;
      onUnopened(row);
      continue;
    }
    onOpened?.(row, key);
    const armoredPrivate = await lock(key, to);
    // Opened again with the new secret before anything is sent: what is stored must open.
    await unlock(armoredPrivate, to);
    updates.push({ id: row.id, armoredPrivate, protection: 'login' });
  }
  return updates;
}

// After sign-in, with the current password's secret (`entry.verified`): which 'login' keys it no
// longer opens (the password was reset, and the old one has not been given), and which it opens
// again. Each change is reported with markStale(id, stale) (PATCH /api/pgp/keys/:id), so the
// server stops advertising a dead key and the user is told. Resolves to whether anything changed.
// An unverified secret (one an SSO user chose) proves nothing either way.
export async function checkLoginKeys({ keys, entry, markStale, open = openOwnKey }) {
  if (!entry?.secret || !entry.verified) return false;
  let changed = false;
  for (const k of (keys || []).filter(isLoginKey)) {
    let stale = false;
    try {
      await open(k, { secret: entry.secret, verified: true });
    } catch (err) {
      if (err?.code !== 'staleSecret') continue;
      stale = true;
    }
    if (stale !== Boolean(k.stale)) {
      await markStale(k.id, stale);
      changed = true;
    }
  }
  return changed;
}

// The addresses the user sends from: accounts and their aliases, each once.
export function senderAddresses(accounts) {
  const out = [];
  for (const a of accounts || []) {
    if (a.email_address) out.push({ email: a.email_address.toLowerCase(), name: a.sender_name || a.name || '', accountId: a.id });
    for (const al of a.aliases || []) if (al.email) out.push({ email: al.email.toLowerCase(), name: al.name || '', accountId: a.id });
  }
  const seen = new Set();
  return out.filter(x => !seen.has(x.email) && seen.add(x.email));
}

// Automatic keys, made at most once per user and address in this tab: a second call while one
// runs (two renders, two components) gets the same promise, and an address done is not tried again
// until the page reloads. The server makes the same promise across tabs (409 'exists').
const inflight = new Map();
const settled = new Set();

export function forgetAutoKeyState() {
  inflight.clear();
  settled.clear();
}

// Makes a key for each of `addresses` ({ email, name, accountId }) that has none among `ownKeys`,
// protected by `secret`. Resolves to { created, changed }: the keys stored here, and whether the
// user's keys may differ from `ownKeys` (another tab stored one first, 409). One address failing
// (offline) leaves it to the next call; the others go on.
// `force`: the user asked for this one (a new key for an address whose key is stale): an address
// done earlier in this tab is made again.
export async function ensureAutoKeys({ userId, addresses, ownKeys, secret, addKey, generate = generateKeyPair, force = false }) {
  if (!userId || !secret) return { created: [], changed: false };
  const have = new Set((ownKeys || []).flatMap(k => k.emails || []));
  const jobs = [];
  for (const address of addresses || []) {
    const email = String(address.email || '').toLowerCase();
    const id = `${userId}\n${email}`;
    if (!email || have.has(email) || (!force && settled.has(id))) continue;
    if (!inflight.has(id)) {
      const job = (async () => {
        const pair = await generate({ name: address.name || '', email, passphrase: secret });
        try {
          const { key } = await addKey({
            armoredPrivate: pair.armoredPrivate, armoredPublic: pair.armoredPublic,
            accountId: address.accountId || null, protection: 'login', auto: true,
          });
          return { key };
        } catch (err) {
          if (err?.status === 409) return { key: null, elsewhere: true };
          throw err;
        }
      })().then(
        (key) => { settled.add(id); return key; },
        (err) => { console.warn(`[pgp] no key made for an address yet: ${err?.message || err}`); return null; },
      ).finally(() => inflight.delete(id));
      inflight.set(id, job);
    }
    jobs.push(inflight.get(id));
  }
  const results = (await Promise.all(jobs)).filter(Boolean);
  const created = results.map(r => r.key).filter(Boolean);
  return { created, changed: created.length > 0 || results.some(r => r.elsewhere) };
}
