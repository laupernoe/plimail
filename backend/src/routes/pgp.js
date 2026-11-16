import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { requireAuth } from '../middleware/auth.js';
import { query } from '../services/db.js';
import { consumeLoginAttempt } from '../services/loginLimiter.js';
import { consume } from '../services/rateLimiter.js';
import { UUID_RE } from '../utils/uuid.js';
import {
  PgpRequestError, addOwnKey, addToKeyring, deleteFromKeyring, deleteOwnKey, isFingerprint, kdfSalt, listKeyring,
  listOwnKeys, lookupRecipientKeys, setKeyStale, setKeyringVerified, setKeysProtection,
} from '../services/pgpKeyring.js';

// OpenPGP keys (services/pgpKeyring.js). The user's own keys, whose private half is stored only
// passphrase-protected, and their keyring of correspondents' public keys. Not on the API token
// allowlist: these are the keys to the user's encrypted mail.
const router = Router();
router.use(requireAuth);

const NOT_FOUND = { error: 'Not found' };
// Recipients of one message; the composer asks for all of them at once.
const MAX_LOOKUP_EMAILS = 50;

function answerError(res, err) {
  if (err instanceof PgpRequestError) {
    return res.status(err.status).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
  }
  throw err;
}

router.get('/keys', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ keys: await listOwnKeys(req.session.userId) });
});

router.post('/keys', async (req, res) => {
  const { armoredPrivate, armoredPublic, accountId, protection = 'passphrase', auto = false } = req.body || {};
  try {
    res.status(201).json({ key: await addOwnKey(req.session.userId, { armoredPrivate, armoredPublic, accountId: accountId ?? null, protection, auto }) });
  } catch (err) {
    answerError(res, err);
  }
});

// The same keys, encrypted another way, all or none: { keys: [{ id, armoredPrivate, protection }] }.
router.put('/keys/protection', async (req, res) => {
  try {
    res.json({ updated: await setKeysProtection(req.session.userId, req.body?.keys) });
  } catch (err) {
    answerError(res, err);
  }
});

// The salt for deriving the passphrase of the keys that unlock with the Plimail password. The
// derivation, and everything it unlocks, stays in the browser.
router.get('/kdf', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    res.json({ salt: await kdfSalt(req.session.userId) });
  } catch (err) {
    answerError(res, err);
  }
});

// Whether `password` is the user's Plimail password, so the browser knows that a key it does not
// open was protected by an earlier one (the password was reset or changed), rather than that the
// password was mistyped. The password is what signing in sends anyway; what the browser derives
// from it never leaves the browser. { ok, hasPassword }; an SSO-only user has none to check.
// A wrong password counts as a failed sign-in at the account (services/loginLimiter.js: the
// username's own budget, shared with the login form), so a stolen session cannot guess the
// password here faster than at the login page; a right one is handed back as a sign-in's is.
router.post('/verify-password', async (req, res) => {
  const password = req.body?.password;
  if (typeof password !== 'string' || !password || password.length > 1024) return res.status(400).json({ error: 'password is required' });
  const { rows } = await query('SELECT username, password_hash FROM users WHERE id = $1', [req.session.userId]);
  const user = rows[0];
  if (!user?.password_hash) return res.json({ ok: false, hasPassword: false });
  const attempt = await consumeLoginAttempt(String(user.username).toLowerCase().trim(), req.ip);
  if (attempt.limited) {
    res.set('Retry-After', String(Math.max(1, Math.ceil((attempt.resetMs || 1000) / 1000))));
    return res.status(429).json({ error: 'Too many attempts. Try again later.', code: 'rate_limited' });
  }
  const ok = await bcrypt.compare(password, user.password_hash);
  if (ok) await attempt.succeeded();
  res.json({ ok, hasPassword: true });
});

// { stale: boolean }: the browser found the current password does not open this key, or does.
router.patch('/keys/:id', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(404).json(NOT_FOUND);
  if (typeof req.body?.stale !== 'boolean') return res.status(400).json({ error: 'stale must be a boolean' });
  if (!(await setKeyStale(req.session.userId, req.params.id, req.body.stale))) return res.status(404).json(NOT_FOUND);
  res.json({ ok: true });
});

router.delete('/keys/:id', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(404).json(NOT_FOUND);
  if (!(await deleteOwnKey(req.session.userId, req.params.id))) return res.status(404).json(NOT_FOUND);
  res.json({ ok: true });
});

router.get('/keyring', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ keys: await listKeyring(req.session.userId) });
});

router.post('/keyring', async (req, res) => {
  const { armored, source = 'manual', email = null, explicit = false } = req.body || {};
  // The directory adds its own finds (lookup below); nobody posts a key as found there.
  if (source === 'wkd') return res.status(400).json({ error: 'Invalid source' });
  try {
    res.status(201).json({ added: await addToKeyring(req.session.userId, { armored, source, email, explicit: explicit === true }) });
  } catch (err) {
    answerError(res, err);
  }
});

router.patch('/keyring/:fingerprint', async (req, res) => {
  const fingerprint = String(req.params.fingerprint).toLowerCase();
  if (!isFingerprint(fingerprint)) return res.status(404).json(NOT_FOUND);
  if (typeof req.body?.verified !== 'boolean') return res.status(400).json({ error: 'verified must be a boolean' });
  if (!(await setKeyringVerified(req.session.userId, fingerprint, req.body.verified))) return res.status(404).json(NOT_FOUND);
  res.json({ ok: true });
});

router.delete('/keyring/:fingerprint', async (req, res) => {
  const fingerprint = String(req.params.fingerprint).toLowerCase();
  if (!isFingerprint(fingerprint)) return res.status(404).json(NOT_FOUND);
  if (!(await deleteFromKeyring(req.session.userId, fingerprint))) return res.status(404).json(NOT_FOUND);
  res.json({ ok: true });
});

// The keys for a message's recipients: { results: { [email]: { source, keys, error? } } }.
// `local: true` (the reader) never asks a directory. Each address that has to be asked of one
// counts against the user's limit; one answered from their own keys or keyring does not.
const WKD_ADDRESSES_PER_WINDOW = 120;
const WKD_WINDOW_MS = 10 * 60 * 1000;

router.post('/lookup', async (req, res) => {
  const emails = req.body?.emails;
  if (!Array.isArray(emails) || emails.length > MAX_LOOKUP_EMAILS || emails.some(e => typeof e !== 'string' || e.length > 320)) {
    return res.status(400).json({ error: `emails must be an array of at most ${MAX_LOOKUP_EMAILS} addresses` });
  }
  const userId = req.session.userId;
  const chargeWkd = async (n) => {
    let limit;
    for (let i = 0; i < n; i++) {
      limit = await consume(`pgp-wkd:${userId}`, WKD_ADDRESSES_PER_WINDOW, WKD_WINDOW_MS);
      if (limit.limited) throw Object.assign(new PgpRequestError(429, 'Too many key lookups. Try again later.', 'rate_limited'), { resetMs: limit.resetMs });
    }
  };
  res.set('Cache-Control', 'no-store');
  try {
    res.json({ results: await lookupRecipientKeys(userId, emails, { local: req.body?.local === true, chargeWkd }) });
  } catch (err) {
    if (err?.status === 429) res.set('Retry-After', String(Math.max(1, Math.ceil((err.resetMs || 1000) / 1000))));
    answerError(res, err);
  }
});

export default router;
