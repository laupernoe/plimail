import { query } from './db.js';
import { findOwnedAccount } from './ownership.js';
import { PgpFormatError, parseOwnKeyPair, parsePublicKeys } from './pgpPackets.js';
import { lookupWkd, parseWkdAddress } from './wkd.js';

// The user's own OpenPGP keys and their keyring of correspondents' public keys (migration 0094).
// Every query is scoped to the user; another user's key is simply not found.

export const KEYRING_SOURCES = new Set(['manual', 'wkd', 'autocrypt', 'attachment']);
// A key per address is plenty; this keeps one user from filling the table.
const MAX_OWN_KEYS = 50;
const MAX_KEYRING_ROWS = 5000;

export class PgpRequestError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const FINGERPRINT_RE = /^[0-9a-f]{32,64}$/;
export const isFingerprint = value => typeof value === 'string' && FINGERPRINT_RE.test(value);

const ownKeyRow = r => ({
  id: r.id,
  accountId: r.account_id,
  fingerprint: r.fingerprint,
  emails: r.emails || [],
  userIds: r.user_ids || [],
  algorithm: r.algorithm,
  keyCreatedAt: r.key_created_at,
  createdAt: r.created_at,
  armoredPublic: r.armored_public,
  armoredPrivate: r.armored_private,
});

export async function listOwnKeys(userId) {
  const { rows } = await query(
    `SELECT id, account_id, fingerprint, emails, user_ids, algorithm, armored_public, armored_private, key_created_at, created_at
     FROM pgp_keys WHERE user_id = $1 ORDER BY created_at`,
    [userId],
  );
  return rows.map(ownKeyRow);
}

// Stores a key pair the browser generated or imported. The private key is checked to be
// passphrase-protected (parseOwnKeyPair) before anything is written.
export async function addOwnKey(userId, { armoredPrivate, armoredPublic, accountId = null }) {
  if (typeof armoredPrivate !== 'string' || typeof armoredPublic !== 'string') {
    throw new PgpRequestError(400, 'armoredPrivate and armoredPublic are required');
  }
  let parsed;
  try {
    parsed = parseOwnKeyPair(armoredPrivate, armoredPublic);
  } catch (err) {
    if (err instanceof PgpFormatError) throw new PgpRequestError(400, err.message, err.code || 'invalid_key');
    throw err;
  }
  if (!parsed.emails.length) throw new PgpRequestError(400, 'The key has no email address in its user IDs', 'no_email');
  if (accountId != null) {
    if (typeof accountId !== 'string' || !(await findOwnedAccount(userId, accountId, { columns: 'id' }))) {
      throw new PgpRequestError(404, 'Account not found');
    }
  }
  const count = await query('SELECT COUNT(*)::int AS n FROM pgp_keys WHERE user_id = $1', [userId]);
  if ((count.rows[0]?.n || 0) >= MAX_OWN_KEYS) throw new PgpRequestError(400, 'Too many keys');
  const { rows } = await query(
    `INSERT INTO pgp_keys (user_id, account_id, fingerprint, emails, user_ids, algorithm, armored_public, armored_private, key_created_at)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9)
     ON CONFLICT (user_id, fingerprint) DO NOTHING
     RETURNING id, account_id, fingerprint, emails, user_ids, algorithm, armored_public, armored_private, key_created_at, created_at`,
    [userId, accountId, parsed.fingerprint, JSON.stringify(parsed.emails), JSON.stringify(parsed.userIds),
      parsed.algorithm, parsed.armoredPublic, parsed.armoredPrivate, parsed.created],
  );
  if (!rows.length) throw new PgpRequestError(409, 'This key is already in your keys', 'duplicate');
  return ownKeyRow(rows[0]);
}

export async function deleteOwnKey(userId, id) {
  const { rows } = await query('DELETE FROM pgp_keys WHERE id = $1 AND user_id = $2 RETURNING id', [id, userId]);
  return rows.length > 0;
}

const keyringRow = r => ({
  id: r.id,
  email: r.email,
  fingerprint: r.fingerprint,
  armored: r.armored,
  source: r.source,
  verified: r.verified,
  firstSeen: r.first_seen,
  lastSeen: r.last_seen,
});

export async function listKeyring(userId) {
  const { rows } = await query(
    `SELECT id, email, fingerprint, armored, source, verified, first_seen, last_seen
     FROM pgp_public_keys WHERE user_id = $1 ORDER BY email, first_seen`,
    [userId],
  );
  return rows.map(keyringRow);
}

// Adds the public keys in `armored` to the keyring, one row per address in their user IDs (or
// only `email`, which must be one of them). Autocrypt keys are collected without being asked
// for, so one never replaces or joins a key the user already has for the address, unless the
// user imported it themselves (`explicit`).
export async function addToKeyring(userId, { armored, source = 'manual', email = null, explicit = false }) {
  if (!KEYRING_SOURCES.has(source)) throw new PgpRequestError(400, 'Invalid source');
  if (typeof armored !== 'string' || !armored.trim()) throw new PgpRequestError(400, 'armored is required');
  let keys;
  try {
    keys = parsePublicKeys(armored);
  } catch (err) {
    if (err instanceof PgpFormatError) throw new PgpRequestError(400, err.message, 'invalid_key');
    throw err;
  }
  const only = email == null ? null : String(email).trim().toLowerCase();
  const rows = [];
  for (const key of keys) {
    const emails = only ? key.emails.filter(e => e === only) : key.emails;
    for (const address of emails) rows.push({ email: address, fingerprint: key.primary.fingerprint, armored: key.armored });
  }
  if (!rows.length) {
    throw new PgpRequestError(400, only ? 'The key has no user ID for this address' : 'The key has no email address in its user IDs', 'no_email');
  }
  const count = await query('SELECT COUNT(*)::int AS n FROM pgp_public_keys WHERE user_id = $1', [userId]);
  if ((count.rows[0]?.n || 0) + rows.length > MAX_KEYRING_ROWS) throw new PgpRequestError(400, 'The keyring is full');
  const added = [];
  for (const row of rows) {
    const result = source === 'autocrypt' && !explicit
      ? await query(
        `INSERT INTO pgp_public_keys (user_id, email, fingerprint, armored, source)
         SELECT $1, $2, $3, $4, 'autocrypt'
         WHERE NOT EXISTS (SELECT 1 FROM pgp_public_keys WHERE user_id = $1 AND email = $2)
         RETURNING id, email, fingerprint, armored, source, verified, first_seen, last_seen`,
        [userId, row.email, row.fingerprint, row.armored],
      )
      : await query(
        // A newer copy of a key (new subkeys, a later expiry) replaces the stored one; where it
        // came from first and whether the user verified it stay.
        `INSERT INTO pgp_public_keys (user_id, email, fingerprint, armored, source)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, email, fingerprint) DO UPDATE SET armored = EXCLUDED.armored, last_seen = NOW()
         RETURNING id, email, fingerprint, armored, source, verified, first_seen, last_seen`,
        [userId, row.email, row.fingerprint, row.armored, source],
      );
    if (result.rows[0]) added.push(keyringRow(result.rows[0]));
  }
  return added;
}

export async function setKeyringVerified(userId, fingerprint, verified) {
  const { rowCount } = await query(
    'UPDATE pgp_public_keys SET verified = $3 WHERE user_id = $1 AND fingerprint = $2',
    [userId, fingerprint, verified],
  );
  return rowCount > 0;
}

export async function deleteFromKeyring(userId, fingerprint) {
  const { rowCount } = await query('DELETE FROM pgp_public_keys WHERE user_id = $1 AND fingerprint = $2', [userId, fingerprint]);
  return rowCount > 0;
}

// The one key to encrypt to for an address, of the rows the keyring holds for it: one the user
// verified, then the most recently seen. Encrypting to every key ever stored for an address would
// let an old or planted key read the message too.
export function preferredKeyringRow(rows) {
  return [...rows].sort((a, b) => (Number(b.verified) - Number(a.verified))
    || (new Date(b.last_seen || 0) - new Date(a.last_seen || 0)))[0] || null;
}

const keyOut = (row, source) => ({ fingerprint: row.fingerprint, armored: row.armored, source, verified: row.verified });

// The key to encrypt to for each address, one per address: the user's own (writing to oneself,
// the most recent if several), then the keyring's preferred one, then, unless `local`, the
// address's Web Key Directory. A key found there is saved to the keyring, so the next message uses
// the same key and a change of key is something the user can see. `chargeWkd(n)` is called with
// the number of addresses about to be asked of a directory, before any is, and may throw to
// refuse (the route's rate limit).
// Returns { [email]: { source: 'own' | 'keyring' | 'wkd' | null, keys: [one], error? } }.
export async function lookupRecipientKeys(userId, emails, { wkd = lookupWkd, local = false, chargeWkd = async () => {} } = {}) {
  const wanted = [...new Set(emails.map(e => String(e).trim().toLowerCase()).filter(Boolean))];
  const results = {};
  if (!wanted.length) return results;
  const [own, ring] = await Promise.all([
    query('SELECT fingerprint, emails, armored_public, key_created_at FROM pgp_keys WHERE user_id = $1', [userId]),
    query(
      'SELECT email, fingerprint, armored, source, verified, last_seen FROM pgp_public_keys WHERE user_id = $1 AND email = ANY($2::text[])',
      [userId, wanted],
    ),
  ]);
  for (const email of wanted) {
    const mine = own.rows.filter(r => (r.emails || []).includes(email))
      .sort((a, b) => new Date(b.key_created_at || 0) - new Date(a.key_created_at || 0));
    if (mine.length) {
      results[email] = { source: 'own', keys: [{ fingerprint: mine[0].fingerprint, armored: mine[0].armored_public, source: 'own', verified: true }] };
      continue;
    }
    const best = preferredKeyringRow(ring.rows.filter(r => r.email === email));
    if (best) results[email] = { source: 'keyring', keys: [keyOut(best, best.source)] };
  }
  const unknown = wanted.filter(e => !results[e]);
  const askable = local ? [] : unknown.filter(e => parseWkdAddress(e));
  for (const email of unknown) if (!askable.includes(email)) results[email] = { source: null, keys: [] };
  if (!askable.length) return results;
  await chargeWkd(askable.length);
  await Promise.all(askable.map(async (email) => {
    let found;
    try {
      found = await wkd(email);
    } catch (err) {
      console.warn(`[pgp] WKD lookup failed: ${err?.code || err?.message || err}`);
      results[email] = { source: null, keys: [], error: true };
      return;
    }
    if (!found.keys.length) {
      results[email] = { source: null, keys: [], ...(found.error ? { error: true } : {}) };
      return;
    }
    const saved = [];
    for (const key of found.keys) {
      const { rows } = await query(
        `INSERT INTO pgp_public_keys (user_id, email, fingerprint, armored, source)
         VALUES ($1, $2, $3, $4, 'wkd')
         ON CONFLICT (user_id, email, fingerprint) DO UPDATE SET armored = EXCLUDED.armored, last_seen = NOW()
         RETURNING fingerprint, armored, source, verified, last_seen`,
        [userId, email, key.primary.fingerprint, key.armored],
      );
      if (rows[0]) saved.push(rows[0]);
    }
    const best = preferredKeyringRow(saved);
    results[email] = best ? { source: 'wkd', keys: [keyOut(best, 'wkd')] } : { source: null, keys: [] };
  }));
  return results;
}
