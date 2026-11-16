import { randomBytes } from 'node:crypto';
import { query, withTransaction } from './db.js';
import { findOwnedAccount } from './ownership.js';
import { UUID_RE } from '../utils/uuid.js';
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
  protection: r.protection || 'passphrase',
  auto: r.auto_email != null,
  stale: r.stale_at != null,
});

export const KEY_PROTECTIONS = new Set(['passphrase', 'login']);
const OWN_COLUMNS = 'id, account_id, fingerprint, emails, user_ids, algorithm, armored_public, armored_private, key_created_at, created_at, protection, auto_email, stale_at';

export async function listOwnKeys(userId) {
  const { rows } = await query(`SELECT ${OWN_COLUMNS} FROM pgp_keys WHERE user_id = $1 ORDER BY created_at`, [userId]);
  return rows.map(ownKeyRow);
}

// The salt the browser derives the passphrase of 'login' keys with from the Plimail password
// (frontend utils/pgpSecret.js), made on first use. Not a secret: the password is.
export async function kdfSalt(userId) {
  const fresh = randomBytes(16).toString('base64');
  const { rows } = await query(
    'UPDATE users SET pgp_kdf_salt = COALESCE(pgp_kdf_salt, $2) WHERE id = $1 RETURNING pgp_kdf_salt',
    [userId, fresh],
  );
  if (!rows[0]?.pgp_kdf_salt) throw new PgpRequestError(404, 'User not found');
  return rows[0].pgp_kdf_salt;
}

// Stores a key pair the browser generated or imported. The private key is checked to be
// passphrase-protected (parseOwnKeyPair) before anything is written. `protection` says with what
// (KEY_PROTECTIONS); the server cannot tell and does not need to. `auto`: a key Plimail made by
// itself for the one address it is for. One is stored per address and user, and none for an
// address that already has a usable key: another tab that made one at the same time gets 409
// 'exists'. A stale key (setKeyStale) gives up the address's slot, so a new key can replace it as
// the one in use while the old one stays for reading old mail.
export async function addOwnKey(userId, { armoredPrivate, armoredPublic, accountId = null, protection = 'passphrase', auto = false }) {
  if (typeof armoredPrivate !== 'string' || typeof armoredPublic !== 'string') {
    throw new PgpRequestError(400, 'armoredPrivate and armoredPublic are required');
  }
  if (!KEY_PROTECTIONS.has(protection)) throw new PgpRequestError(400, 'Invalid protection');
  if (typeof auto !== 'boolean') throw new PgpRequestError(400, 'auto must be a boolean');
  let parsed;
  try {
    parsed = parseOwnKeyPair(armoredPrivate, armoredPublic);
  } catch (err) {
    if (err instanceof PgpFormatError) throw new PgpRequestError(400, err.message, err.code || 'invalid_key');
    throw err;
  }
  if (!parsed.emails.length) throw new PgpRequestError(400, 'The key has no email address in its user IDs', 'no_email');
  if (auto && (parsed.emails.length !== 1 || protection !== 'login')) {
    throw new PgpRequestError(400, 'An automatic key is for one address and unlocks with the Plimail password');
  }
  if (accountId != null) {
    if (typeof accountId !== 'string' || !(await findOwnedAccount(userId, accountId, { columns: 'id' }))) {
      throw new PgpRequestError(404, 'Account not found');
    }
  }
  const count = await query('SELECT COUNT(*)::int AS n FROM pgp_keys WHERE user_id = $1', [userId]);
  if ((count.rows[0]?.n || 0) >= MAX_OWN_KEYS) throw new PgpRequestError(400, 'Too many keys');
  const values = [userId, accountId, parsed.fingerprint, JSON.stringify(parsed.emails), JSON.stringify(parsed.userIds),
    parsed.algorithm, parsed.armoredPublic, parsed.armoredPrivate, parsed.created, protection];
  if (auto) {
    const email = parsed.emails[0];
    // No key over a usable one the address already has; the unique index on auto_email settles
    // two at once.
    const rows = await withTransaction(async (db) => {
      await db.query(
        'UPDATE pgp_keys SET auto_email = NULL WHERE user_id = $1 AND auto_email = $2 AND stale_at IS NOT NULL',
        [userId, email],
      );
      return (await db.query(
        `INSERT INTO pgp_keys (user_id, account_id, fingerprint, emails, user_ids, algorithm, armored_public, armored_private, key_created_at, protection, auto_email)
         SELECT $1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9, $10, $11
         WHERE NOT EXISTS (SELECT 1 FROM pgp_keys WHERE user_id = $1 AND emails ? $11 AND stale_at IS NULL)
         ON CONFLICT DO NOTHING
         RETURNING ${OWN_COLUMNS}`,
        [...values, email],
      )).rows;
    });
    if (!rows.length) throw new PgpRequestError(409, 'This address already has a key', 'exists');
    return ownKeyRow(rows[0]);
  }
  const { rows } = await query(
    `INSERT INTO pgp_keys (user_id, account_id, fingerprint, emails, user_ids, algorithm, armored_public, armored_private, key_created_at, protection)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9, $10)
     ON CONFLICT (user_id, fingerprint) DO NOTHING
     RETURNING ${OWN_COLUMNS}`,
    values,
  );
  if (!rows.length) throw new PgpRequestError(409, 'This key is already in your keys', 'duplicate');
  return ownKeyRow(rows[0]);
}

// Replaces the private half of some of the user's keys with the same keys encrypted another way:
// all of `updates` ([{ id, armoredPrivate, protection }]) or none, in one transaction. The browser
// re-encrypts every 'login' key when the Plimail password changes, and a key the user protects
// with the password instead of its own passphrase. Each must be the same key, still protected.
// `client` runs it inside a caller's transaction (an admin setting their own password).
export async function setKeysProtection(userId, updates, { client = null } = {}) {
  if (!Array.isArray(updates) || !updates.length || updates.length > MAX_OWN_KEYS) {
    throw new PgpRequestError(400, `keys must be an array of 1 to ${MAX_OWN_KEYS} keys`);
  }
  const checked = updates.map((u) => {
    if (!u || typeof u.id !== 'string' || !UUID_RE.test(u.id) || typeof u.armoredPrivate !== 'string' || !KEY_PROTECTIONS.has(u.protection)) {
      throw new PgpRequestError(400, 'Each key needs an id, armoredPrivate and protection');
    }
    return u;
  });
  if (new Set(checked.map(u => u.id)).size !== checked.length) throw new PgpRequestError(400, 'A key is listed twice');
  const run = async (db) => {
    const { rows } = await db.query(
      'SELECT id, fingerprint, armored_public FROM pgp_keys WHERE user_id = $1 AND id = ANY($2::uuid[]) FOR UPDATE',
      [userId, checked.map(u => u.id)],
    );
    const byId = new Map(rows.map(r => [r.id, r]));
    const parsed = checked.map((u) => {
      const row = byId.get(u.id);
      if (!row) throw new PgpRequestError(404, 'Key not found');
      let pair;
      try {
        // Against the stored public key: a private key that is not this key's is refused here.
        pair = parseOwnKeyPair(u.armoredPrivate, row.armored_public);
      } catch (err) {
        if (err instanceof PgpFormatError) throw new PgpRequestError(400, err.message, err.code || 'invalid_key');
        throw err;
      }
      return { id: u.id, armoredPrivate: pair.armoredPrivate, protection: u.protection };
    });
    for (const p of parsed) {
      await db.query(
        // Encrypted again for the password the user has now: usable again.
        'UPDATE pgp_keys SET armored_private = $3, protection = $4, stale_at = NULL WHERE id = $1 AND user_id = $2',
        [p.id, userId, p.armoredPrivate, p.protection],
      );
    }
    return parsed.length;
  };
  return client ? run(client) : withTransaction(run);
}

// What the owner's browser found: the current Plimail password does not open this 'login' key
// (stale), or does again. The server cannot check it, and need not: a key marked stale is only
// left out of what goes to others (Autocrypt) and out of the browser's choice of key to use.
export async function setKeyStale(userId, id, stale) {
  const { rowCount } = await query(
    `UPDATE pgp_keys SET stale_at = CASE WHEN $3 THEN COALESCE(stale_at, NOW()) ELSE NULL END
     WHERE id = $1 AND user_id = $2 AND protection = 'login'`,
    [id, userId, stale === true],
  );
  return rowCount > 0;
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
  auto: r.auto_collected === true,
});

export async function listKeyring(userId) {
  const { rows } = await query(
    `SELECT id, email, fingerprint, armored, source, verified, first_seen, last_seen, auto_collected
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
         RETURNING id, email, fingerprint, armored, source, verified, first_seen, last_seen, auto_collected`,
        [userId, row.email, row.fingerprint, row.armored],
      )
      : await query(
        // A newer copy of a key (new subkeys, a later expiry) replaces the stored one; where it
        // came from first and whether the user verified it stay. Asked for by the user, the key
        // stops being one an Autocrypt header may replace.
        `INSERT INTO pgp_public_keys (user_id, email, fingerprint, armored, source)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, email, fingerprint) DO UPDATE SET armored = EXCLUDED.armored, last_seen = NOW(), auto_collected = FALSE
         RETURNING id, email, fingerprint, armored, source, verified, first_seen, last_seen, auto_collected`,
        [userId, row.email, row.fingerprint, row.armored, source],
      );
    if (result.rows[0]) added.push(keyringRow(result.rows[0]));
  }
  return added;
}

// What to do with the key an Autocrypt header offers for an address, given the rows the keyring
// holds for it ([{ fingerprint, source, verified, auto_collected, last_seen }]):
//   'insert'  nothing is stored for the address;
//   'refresh' the same key again, in a newer message: its copy and last_seen move up;
//   'replace' a different key in a newer message: it takes the place of the automatic one;
//   'skip'    anything else, with the `reason`.
// Only a row this function stored (source 'autocrypt', auto_collected, not verified) is ever
// replaced. A key the user imported or verified, or one from a Web Key Directory, stays, and so
// does an address's key when the message failed DKIM or DMARC (a forged sender must not get a
// key in, let alone swap one). The Date header is compared with the row's last_seen, which for these
// rows is the date of the newest message that carried the key, so an older message, read late,
// never puts an older key back.
export function decideAutocryptStore(rows, { fingerprint, timestamp, authFailed }) {
  if (authFailed) return { action: 'skip', reason: 'auth' };
  if (!rows.length) return { action: 'insert' };
  const replaceable = r => r.source === 'autocrypt' && r.auto_collected === true && r.verified !== true;
  if (!rows.every(replaceable)) return { action: 'skip', reason: 'protected' };
  if (!timestamp) return { action: 'skip', reason: 'noDate' };
  const newest = Math.max(...rows.map(r => new Date(r.last_seen || 0).getTime()));
  if (timestamp.getTime() <= newest) return { action: 'skip', reason: 'older' };
  return { action: rows.some(r => r.fingerprint === fingerprint) ? 'refresh' : 'replace' };
}

// Keeps the key of a received Autocrypt header (autocryptReceive.js readAutocryptHeader) in the
// keyring unless decideAutocryptStore says no. Returns what it did: 'insert', 'refresh',
// 'replace' or 'skip'. One address is handled at a time (an advisory lock), so two messages read
// at once cannot both decide on the same rows.
export async function storeAutocryptKey(userId, { addr, armored, fingerprint, timestamp = null, authFailed = false }, { transaction = withTransaction } = {}) {
  return transaction(async (db) => {
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`autocrypt:${userId}:${addr}`]);
    const { rows } = await db.query(
      'SELECT fingerprint, source, verified, auto_collected, last_seen FROM pgp_public_keys WHERE user_id = $1 AND email = $2 FOR UPDATE',
      [userId, addr],
    );
    const decision = decideAutocryptStore(rows, { fingerprint, timestamp, authFailed });
    if (decision.action === 'skip') return decision;
    if (decision.action === 'refresh') {
      await db.query(
        'UPDATE pgp_public_keys SET armored = $4, last_seen = $5 WHERE user_id = $1 AND email = $2 AND fingerprint = $3',
        [userId, addr, fingerprint, armored, timestamp],
      );
      return decision;
    }
    if (decision.action === 'insert') {
      const count = await db.query('SELECT COUNT(*)::int AS n FROM pgp_public_keys WHERE user_id = $1', [userId]);
      if ((count.rows[0]?.n || 0) >= MAX_KEYRING_ROWS) return { action: 'skip', reason: 'full' };
    } else {
      await db.query(
        "DELETE FROM pgp_public_keys WHERE user_id = $1 AND email = $2 AND source = 'autocrypt' AND auto_collected AND NOT verified",
        [userId, addr],
      );
    }
    await db.query(
      `INSERT INTO pgp_public_keys (user_id, email, fingerprint, armored, source, last_seen, auto_collected)
       VALUES ($1, $2, $3, $4, 'autocrypt', COALESCE($5::timestamptz, NOW()), TRUE)
       ON CONFLICT (user_id, email, fingerprint) DO NOTHING`,
      [userId, addr, fingerprint, armored, timestamp],
    );
    return decision;
  });
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
         ON CONFLICT (user_id, email, fingerprint) DO UPDATE SET armored = EXCLUDED.armored, last_seen = NOW(), auto_collected = FALSE
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
