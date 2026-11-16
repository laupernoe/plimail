import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { query, withTransaction } from './db.js';

// Password-protected messages (migration 0093). The browser encrypts; this module only ever
// handles ciphertext, and a hash of the recipient's authentication key. See
// frontend/src/utils/secureMessageCrypto.js for how both are derived from the password.

export const EXPIRY_DAYS = [1, 7, 30];
export const DEFAULT_EXPIRY_DAYS = 7;
// What the composer allows for attachments (25 MB), plus room for the text and the framing.
export const MAX_CIPHERTEXT_BYTES = 26 * 1024 * 1024;
export const MAX_REPLY_BYTES = 2 * 1024 * 1024;
export const MAX_REPLIES = 20;
// Wrong passwords in all, not in a row: a correct one does not give the guesses back.
export const MAX_FAILED_ATTEMPTS = 10;
export const MAX_RECIPIENTS = 100;
const MIN_ITERATIONS = 100_000;
const MAX_ITERATIONS = 10_000_000;
const GCM_TAG_BYTES = 16;
const DAY_MS = 24 * 60 * 60 * 1000;

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// No groups: a backtracking pattern overflows the stack on a 35 MB string.
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const HEX32_RE = /^[0-9a-f]{64}$/i;

export class SecureMessageError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const isToken = value => typeof value === 'string' && TOKEN_RE.test(value);
export const isId = value => typeof value === 'string' && UUID_RE.test(value);
export const newToken = () => randomBytes(32).toString('base64url');

// How many bytes a base64 string decodes to, from its length alone.
const base64Bytes = value => Math.floor(value.length * 3 / 4) - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0);

// Strict base64 into bytes, or null. Buffer.from alone skips what is not base64 without a word.
export function decodeBase64(value, { exactBytes, maxBytes } = {}) {
  if (typeof value !== 'string' || !value || value.length % 4 !== 0 || !BASE64_RE.test(value)) return null;
  if (maxBytes != null && base64Bytes(value) > maxBytes) return null;
  const bytes = Buffer.from(value, 'base64');
  if (exactBytes != null && bytes.length !== exactBytes) return null;
  if (maxBytes != null && bytes.length > maxBytes) return null;
  return bytes;
}

// The recipient's authentication key, as hex, checked against the stored SHA-256 of it.
export function authKeyMatches(authKeyHex, verifierHex) {
  if (typeof authKeyHex !== 'string' || !HEX32_RE.test(authKeyHex)) return false;
  if (typeof verifierHex !== 'string' || !HEX32_RE.test(verifierHex)) return false;
  const actual = createHash('sha256').update(Buffer.from(authKeyHex, 'hex')).digest();
  return timingSafeEqual(actual, Buffer.from(verifierHex, 'hex'));
}

function bad(message) {
  return new SecureMessageError(400, message, 'invalid');
}

// The create request, checked field by field. Throws a SecureMessageError.
export function parseCreateRequest(body) {
  const b = body && typeof body === 'object' ? body : {};
  if (!isId(b.accountId)) throw bad('Choose the account to send from');
  if (b.aliasId != null && !isId(b.aliasId)) throw bad('Unknown sender');
  if (!Array.isArray(b.recipients) || !b.recipients.length || b.recipients.length > MAX_RECIPIENTS
    || !b.recipients.every(r => typeof r === 'string' && r.trim() && r.length <= 320)) {
    throw bad('Recipients are missing or invalid');
  }
  if (typeof b.ciphertext === 'string' && base64Bytes(b.ciphertext) > MAX_CIPHERTEXT_BYTES) {
    throw new SecureMessageError(413, 'The message and its attachments may be at most 25 MB', 'too_large');
  }
  const ciphertext = decodeBase64(b.ciphertext, { maxBytes: MAX_CIPHERTEXT_BYTES });
  if (!ciphertext || ciphertext.length <= GCM_TAG_BYTES) throw bad('The encrypted message is missing or invalid');
  if (!decodeBase64(b.iv, { exactBytes: 12 })) throw bad('Invalid IV');
  const salt = decodeBase64(b.salt, { maxBytes: 64 });
  if (!salt || salt.length < 16) throw bad('Invalid salt');
  if (!Number.isInteger(b.iterations) || b.iterations < MIN_ITERATIONS || b.iterations > MAX_ITERATIONS) {
    throw bad('Invalid key derivation cost');
  }
  if (typeof b.authVerifier !== 'string' || !HEX32_RE.test(b.authVerifier)) throw bad('Invalid verifier');
  const days = b.expiresInDays == null ? DEFAULT_EXPIRY_DAYS : b.expiresInDays;
  if (!EXPIRY_DAYS.includes(days)) throw bad('The link can last 1, 7 or 30 days');
  return {
    accountId: b.accountId,
    aliasId: b.aliasId || null,
    recipients: b.recipients.map(r => r.trim()),
    ciphertext,
    iv: b.iv,
    salt: b.salt,
    iterations: b.iterations,
    authVerifier: b.authVerifier.toLowerCase(),
    expiresInDays: days,
  };
}

// Who the recipient is told the message is from: the account, or the alias it goes out as.
// Null when the account (or alias) is not the user's.
export async function resolveSender(userId, accountId, aliasId) {
  if (aliasId) {
    const { rows } = await query(
      `SELECT al.name, al.email FROM account_aliases al JOIN email_accounts e ON al.account_id = e.id
       WHERE al.id = $1 AND e.id = $2 AND e.user_id = $3`,
      [aliasId, accountId, userId],
    );
    return rows[0] ? { name: rows[0].name, email: rows[0].email } : null;
  }
  const { rows } = await query(
    'SELECT name, sender_name, email_address FROM email_accounts WHERE id = $1 AND user_id = $2',
    [accountId, userId],
  );
  return rows[0] ? { name: rows[0].sender_name || rows[0].name, email: rows[0].email_address } : null;
}

export async function createSecureMessage(userId, req, sender, now = Date.now()) {
  const token = newToken();
  const expiresAt = new Date(now + req.expiresInDays * DAY_MS);
  const { rows } = await query(
    `INSERT INTO secure_messages
       (token, user_id, account_id, sender_name, sender_email, recipients, ciphertext, iv, salt,
        iterations, auth_verifier, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING id, expires_at`,
    [token, userId, req.accountId, sender.name || null, sender.email, JSON.stringify(req.recipients),
      req.ciphertext, req.iv, req.salt, req.iterations, req.authVerifier, expiresAt],
  );
  return { id: rows[0].id, token, expiresAt: new Date(rows[0].expires_at).toISOString() };
}

function statusOf(row, now = Date.now()) {
  if (row.revoked_at) return 'revoked';
  if (row.locked_at) return 'locked';
  if (new Date(row.expires_at).getTime() <= now) return 'expired';
  return 'active';
}

const iso = value => (value ? new Date(value).toISOString() : null);

// What the owner sees of one message. Never the ciphertext, nor the verifier.
function summary(row) {
  return {
    id: row.id,
    status: statusOf(row),
    recipients: Array.isArray(row.recipients) ? row.recipients : [],
    senderName: row.sender_name,
    senderEmail: row.sender_email,
    createdAt: iso(row.created_at),
    expiresAt: iso(row.expires_at),
    revokedAt: iso(row.revoked_at),
    lockedAt: iso(row.locked_at),
    firstOpenedAt: iso(row.first_opened_at),
    lastOpenedAt: iso(row.last_opened_at),
    openCount: row.open_count,
    failedAttempts: row.failed_attempts,
    replyCount: Number(row.reply_count) || 0,
    unreadReplyCount: Number(row.unread_reply_count) || 0,
  };
}

const SUMMARY_COLUMNS = `m.id, m.recipients, m.sender_name, m.sender_email, m.created_at, m.expires_at,
  m.revoked_at, m.locked_at, m.first_opened_at, m.last_opened_at, m.open_count, m.failed_attempts,
  (SELECT COUNT(*) FROM secure_message_replies r WHERE r.secure_message_id = m.id) AS reply_count,
  (SELECT COUNT(*) FROM secure_message_replies r WHERE r.secure_message_id = m.id AND r.read_at IS NULL) AS unread_reply_count`;

export async function listSecureMessages(userId) {
  const { rows } = await query(
    `SELECT ${SUMMARY_COLUMNS} FROM secure_messages m WHERE m.user_id = $1 ORDER BY m.created_at DESC LIMIT 500`,
    [userId],
  );
  return rows.map(summary);
}

// One message for its owner, with its replies' ciphertext and what it takes to derive the key
// from the password again, in the owner's browser.
export async function getSecureMessage(userId, id) {
  if (!isId(id)) return null;
  const { rows } = await query(
    `SELECT ${SUMMARY_COLUMNS}, m.salt, m.iterations FROM secure_messages m WHERE m.id = $1 AND m.user_id = $2`,
    [id, userId],
  );
  if (!rows[0]) return null;
  const replies = await query(
    `SELECT id, ciphertext, iv, created_at, read_at FROM secure_message_replies
     WHERE secure_message_id = $1 ORDER BY created_at`,
    [id],
  );
  return {
    ...summary(rows[0]),
    salt: rows[0].salt,
    iterations: rows[0].iterations,
    replies: replies.rows.map(r => ({
      id: r.id,
      ciphertext: Buffer.from(r.ciphertext).toString('base64'),
      iv: r.iv,
      createdAt: iso(r.created_at),
      readAt: iso(r.read_at),
    })),
  };
}

export async function markRepliesRead(userId, id) {
  if (!isId(id)) return false;
  const { rows } = await query(
    `WITH m AS (SELECT id FROM secure_messages WHERE id = $1 AND user_id = $2),
          u AS (UPDATE secure_message_replies SET read_at = NOW()
                WHERE secure_message_id IN (SELECT id FROM m) AND read_at IS NULL)
     SELECT id FROM m`,
    [id, userId],
  );
  return rows.length > 0;
}

export async function revokeSecureMessage(userId, id) {
  if (!isId(id)) return false;
  const { rows } = await query(
    'UPDATE secure_messages SET revoked_at = COALESCE(revoked_at, NOW()) WHERE id = $1 AND user_id = $2 RETURNING id',
    [id, userId],
  );
  return rows.length > 0;
}

export async function deleteSecureMessage(userId, id) {
  if (!isId(id)) return false;
  const { rows } = await query('DELETE FROM secure_messages WHERE id = $1 AND user_id = $2 RETURNING id', [id, userId]);
  return rows.length > 0;
}

// ── For the recipient, by token ──────────────────────────────────────────────────────────────

const OPENABLE = 'revoked_at IS NULL AND locked_at IS NULL AND expires_at > NOW()';

// A message that can still be opened, with its verifier for the comparison. Unknown, expired,
// revoked and locked all come back as null, so a caller cannot tell them apart.
export async function findOpenable(token) {
  if (!isToken(token)) return null;
  const { rows } = await query(
    `SELECT id, user_id, sender_name, sender_email, salt, iterations, expires_at, failed_attempts, auth_verifier
     FROM secure_messages WHERE token = $1 AND ${OPENABLE}`,
    [token],
  );
  return rows[0] || null;
}

export function publicMeta(row) {
  return {
    senderName: row.sender_name,
    senderEmail: row.sender_email,
    salt: row.salt,
    iterations: row.iterations,
    expiresAt: iso(row.expires_at),
    remainingAttempts: Math.max(0, MAX_FAILED_ATTEMPTS - row.failed_attempts),
  };
}

// A try at the password is counted before the key is compared, in one statement, so tries sent
// at once cannot all be compared while the count still shows room: each takes one of the
// MAX_FAILED_ATTEMPTS slots first, and once they are all taken no other try gets as far as the
// comparison. The row comes back with its verifier for that comparison; null when the message is
// not openable or every slot is taken (attemptsExhausted tells those apart). A right key hands
// its slot back (attemptSucceeded), so opening the message again and again never locks it; a
// wrong one keeps it, and locks the message once the count has reached the limit (attemptFailed).
export async function reserveAttempt(token) {
  if (!isToken(token)) return null;
  const { rows } = await query(
    `UPDATE secure_messages SET failed_attempts = failed_attempts + 1
     WHERE token = $1 AND ${OPENABLE} AND failed_attempts < $2
     RETURNING id, user_id, failed_attempts, auth_verifier`,
    [token, MAX_FAILED_ATTEMPTS],
  );
  return rows[0] || null;
}

// The message is still openable but its slots are all held by tries not yet answered.
export async function attemptsExhausted(token) {
  return Boolean(await findOpenable(token));
}

export async function attemptSucceeded(id) {
  await query(
    'UPDATE secure_messages SET failed_attempts = GREATEST(failed_attempts - 1, 0) WHERE id = $1',
    [id],
  );
}

// Returns what is left, or locked.
export async function attemptFailed(id) {
  const { rows } = await query(
    `UPDATE secure_messages
     SET locked_at = CASE WHEN failed_attempts >= $2 THEN COALESCE(locked_at, NOW()) ELSE locked_at END
     WHERE id = $1
     RETURNING failed_attempts, locked_at`,
    [id, MAX_FAILED_ATTEMPTS],
  );
  const row = rows[0];
  if (!row || row.locked_at) return { locked: true, remainingAttempts: 0 };
  return { locked: false, remainingAttempts: Math.max(0, MAX_FAILED_ATTEMPTS - row.failed_attempts) };
}

// The ciphertext, once the key has been checked, counted as an open. Null if the message stopped
// being openable in between.
export async function openMessage(id) {
  const { rows } = await query(
    `UPDATE secure_messages
     SET open_count = open_count + 1, first_opened_at = COALESCE(first_opened_at, NOW()), last_opened_at = NOW()
     WHERE id = $1 AND ${OPENABLE}
     RETURNING ciphertext, iv`,
    [id],
  );
  if (!rows[0]) return null;
  return { ciphertext: Buffer.from(rows[0].ciphertext).toString('base64'), iv: rows[0].iv };
}

// Stores a reply while the message is still openable and has room for one. Null otherwise. The
// message row is locked first, so replies sent at once are counted one after the other: in one
// statement, each would count the replies as they were when it began and all could pass the cap.
export async function addReply(id, ciphertext, iv) {
  const row = await withTransaction(async (client) => {
    const { rows: [message] } = await client.query(
      `SELECT id FROM secure_messages WHERE id = $1 AND ${OPENABLE} FOR UPDATE`,
      [id],
    );
    if (!message) return null;
    const { rows } = await client.query(
      `INSERT INTO secure_message_replies (secure_message_id, ciphertext, iv)
       SELECT $1, $2, $3
       WHERE (SELECT COUNT(*) FROM secure_message_replies WHERE secure_message_id = $1) < $4
       RETURNING id, created_at`,
      [id, ciphertext, iv, MAX_REPLIES],
    );
    return rows[0] || null;
  });
  return row ? { id: row.id, createdAt: iso(row.created_at) } : null;
}

export async function countReplies(id) {
  const { rows } = await query('SELECT COUNT(*)::int AS n FROM secure_message_replies WHERE secure_message_id = $1', [id]);
  return rows[0]?.n ?? 0;
}

// ── Expiry ───────────────────────────────────────────────────────────────────────────────────

// Expired messages go, ciphertext, replies (ON DELETE CASCADE) and all.
export async function deleteExpiredSecureMessages() {
  const { rowCount } = await query('DELETE FROM secure_messages WHERE expires_at <= NOW()');
  return rowCount || 0;
}

const CLEANUP_MS = 60 * 60 * 1000;
let cleanupTimer = null;

function cleanUp() {
  deleteExpiredSecureMessages()
    .then((n) => { if (n) console.log(`Secure messages: deleted ${n} expired message(s)`); })
    .catch(err => console.warn('Secure messages: cleanup failed:', err.message));
}

export function startSecureMessageCleanup() {
  if (cleanupTimer) return;
  cleanUp();
  cleanupTimer = setInterval(cleanUp, CLEANUP_MS);
  cleanupTimer.unref?.();
}
