import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { consume } from '../services/rateLimiter.js';
import {
  SecureMessageError, createSecureMessage, deleteSecureMessage, getSecureMessage, listSecureMessages,
  markRepliesRead, parseCreateRequest, resolveSender, revokeSecureMessage,
} from '../services/secureMessages.js';

// The owner's side of password-protected messages. Not on the API token allowlist: creating one
// is sending mail, and its replies are the user's correspondence. The large body parser for
// POST / is mounted in bodyParsers.js, for signed-in requests only.
const router = Router();
router.use(requireAuth);

const NOT_FOUND = { error: 'Not found' };

// Where the recipient opens it. APP_URL is required in production; in development the request's
// own origin stands in for it.
function linkFor(req, token) {
  const base = (process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
  return `${base}/s/${token}`;
}

router.post('/', async (req, res) => {
  const userId = req.session.userId;
  const limit = await consume(`secure-message-create:${userId}`, 60, 60 * 60 * 1000);
  if (limit.limited) {
    res.set('Retry-After', String(Math.max(1, Math.ceil(limit.resetMs / 1000))));
    return res.status(429).json({ error: 'Too many protected messages. Try again later.' });
  }
  let parsed;
  try {
    parsed = parseCreateRequest(req.body);
  } catch (err) {
    if (err instanceof SecureMessageError) return res.status(err.status).json({ error: err.message, code: err.code });
    throw err;
  }
  const sender = await resolveSender(userId, parsed.accountId, parsed.aliasId);
  if (!sender) return res.status(404).json({ error: 'Account not found' });
  const created = await createSecureMessage(userId, parsed, sender);
  // The sender as the recipient will see it, for the notice email the composer sends.
  res.status(201).json({ ...created, url: linkFor(req, created.token), senderName: sender.name || null, senderEmail: sender.email });
});

router.get('/', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ messages: await listSecureMessages(req.session.userId) });
});

router.get('/:id', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const message = await getSecureMessage(req.session.userId, req.params.id);
  if (!message) return res.status(404).json(NOT_FOUND);
  res.json(message);
});

router.post('/:id/read', async (req, res) => {
  if (!(await markRepliesRead(req.session.userId, req.params.id))) return res.status(404).json(NOT_FOUND);
  res.json({ ok: true });
});

router.post('/:id/revoke', async (req, res) => {
  if (!(await revokeSecureMessage(req.session.userId, req.params.id))) return res.status(404).json(NOT_FOUND);
  res.json({ ok: true });
});

router.delete('/:id', async (req, res) => {
  if (!(await deleteSecureMessage(req.session.userId, req.params.id))) return res.status(404).json(NOT_FOUND);
  res.json({ ok: true });
});

export default router;
