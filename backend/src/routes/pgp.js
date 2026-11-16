import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { consume } from '../services/rateLimiter.js';
import { UUID_RE } from '../utils/uuid.js';
import {
  PgpRequestError, addOwnKey, addToKeyring, deleteFromKeyring, deleteOwnKey, isFingerprint, listKeyring,
  listOwnKeys, lookupRecipientKeys, setKeyringVerified,
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
  const { armoredPrivate, armoredPublic, accountId } = req.body || {};
  try {
    res.status(201).json({ key: await addOwnKey(req.session.userId, { armoredPrivate, armoredPublic, accountId: accountId ?? null }) });
  } catch (err) {
    answerError(res, err);
  }
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
  const { armored, source = 'manual', email = null } = req.body || {};
  // The directory adds its own finds (lookup below); nobody posts a key as found there.
  if (source === 'wkd') return res.status(400).json({ error: 'Invalid source' });
  try {
    res.status(201).json({ added: await addToKeyring(req.session.userId, { armored, source, email }) });
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
router.post('/lookup', async (req, res) => {
  const emails = req.body?.emails;
  if (!Array.isArray(emails) || emails.length > MAX_LOOKUP_EMAILS || emails.some(e => typeof e !== 'string' || e.length > 320)) {
    return res.status(400).json({ error: `emails must be an array of at most ${MAX_LOOKUP_EMAILS} addresses` });
  }
  // Each lookup may reach out to other servers (WKD), so it is bounded per user.
  const limit = await consume(`pgp-lookup:${req.session.userId}`, 120, 10 * 60 * 1000);
  if (limit.limited) {
    res.set('Retry-After', String(Math.max(1, Math.ceil(limit.resetMs / 1000))));
    return res.status(429).json({ error: 'Too many key lookups. Try again later.', code: 'rate_limited' });
  }
  res.set('Cache-Control', 'no-store');
  res.json({ results: await lookupRecipientKeys(req.session.userId, emails) });
});

export default router;
