import express, { Router } from 'express';
import { discardBodyUpTo } from '../middleware/bodyParsers.js';
import { consume } from '../services/rateLimiter.js';
import { sendPushToUser } from '../services/pushNotifications.js';
import {
  MAX_REPLY_BYTES, addReply, authKeyMatches, decodeBase64, findOpenable, isToken, openMessage,
  publicMeta, recordFailedAttempt,
} from '../services/secureMessages.js';

// The recipient's side of a password-protected message, at /api/s/<token>/…, for someone with
// no account here. Nothing in it reads the session. What the token alone gets is the sender, the
// key derivation's salt and cost, and the expiry; the ciphertext needs the authentication key
// derived from the password, so the link by itself allows no guessing offline, and guesses online
// are counted against the message (it locks after MAX_FAILED_ATTEMPTS) and rate limited.
//
// The page sends X-Requested-With like the app does, so the CSRF check holds here too
// (csrfGuard.js); the screen lock lets these paths through (screenLock.js), as they act for the
// recipient, never for whoever is signed in on the same browser.
const router = Router();

const MINUTE = 60 * 1000;
const META_PER_IP = { max: 120, windowMs: 5 * MINUTE };
// Every try at the password (open or reply) costs both, right or wrong.
const ATTEMPTS_PER_IP = { max: 30, windowMs: 15 * MINUTE };
const ATTEMPTS_PER_TOKEN = { max: 20, windowMs: 15 * MINUTE };

// One answer for unknown, expired, revoked and locked, so a token cannot be probed for its state.
const UNAVAILABLE = { error: 'This message has expired or was removed', code: 'unavailable' };

router.use((req, res, next) => {
  res.set({
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex, nofollow',
  });
  next();
});

const ipOf = req => req.ip || 'unknown';

// Answers 429 and returns true if any of the limits is spent. `answer` sends the response, so
// the reply route can read off the body it is refusing first.
async function limited(res, checks, answer = send => send()) {
  for (const [key, { max, windowMs }] of checks) {
    const r = await consume(key, max, windowMs);
    if (r.limited) {
      answer(() => {
        res.set('Retry-After', String(Math.max(1, Math.ceil(r.resetMs / 1000))));
        res.status(429).json({ error: 'Too many attempts. Try again later.', code: 'rate_limited' });
      });
      return true;
    }
  }
  return false;
}

const attemptLimits = req => [
  [`secure-attempt-ip:${ipOf(req)}`, ATTEMPTS_PER_IP],
  [`secure-attempt-token:${req.params.token}`, ATTEMPTS_PER_TOKEN],
];

// The message, if the key is right. Otherwise answers for it: unavailable, wrong (with the tries
// left) or, at the last wrong one, locked. Returns null once it has answered.
async function authorize(req, res, authKey) {
  const row = await findOpenable(req.params.token);
  if (!row) {
    res.status(404).json(UNAVAILABLE);
    return null;
  }
  if (!authKeyMatches(authKey, row.auth_verifier)) {
    const { locked, remainingAttempts } = await recordFailedAttempt(row.id);
    if (locked) res.status(403).json({ error: 'Too many wrong passwords. This message is locked.', code: 'locked' });
    else res.status(401).json({ error: 'Wrong password', code: 'wrong_password', remainingAttempts });
    return null;
  }
  return row;
}

router.get('/:token/meta', async (req, res) => {
  if (await limited(res, [[`secure-meta-ip:${ipOf(req)}`, META_PER_IP]])) return;
  const row = isToken(req.params.token) ? await findOpenable(req.params.token) : null;
  if (!row) return res.status(404).json(UNAVAILABLE);
  res.json(publicMeta(row));
});

router.post('/:token/open', async (req, res) => {
  if (!isToken(req.params.token)) return res.status(404).json(UNAVAILABLE);
  if (await limited(res, attemptLimits(req))) return;
  const row = await authorize(req, res, req.body?.authKey);
  if (!row) return;
  const opened = await openMessage(row.id);
  if (!opened) return res.status(404).json(UNAVAILABLE);
  res.json(opened);
});

// The reply is the ciphertext itself, as application/octet-stream, so the global JSON parser
// leaves it alone and only this route reads it, up to MAX_REPLY_BYTES, once the limits allow it.
// The key and IV come in headers.
const rawReply = express.raw({ type: 'application/octet-stream', limit: MAX_REPLY_BYTES });

router.post('/:token/reply', async (req, res, next) => {
  // A refusal before the body is read reads it off first, up to the cap (bodyParsers.js says why).
  const beforeBody = send => discardBodyUpTo(req, res, MAX_REPLY_BYTES, send);
  if (!isToken(req.params.token)) return beforeBody(() => res.status(404).json(UNAVAILABLE));
  if (await limited(res, attemptLimits(req), beforeBody)) return;
  rawReply(req, res, (err) => {
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'The reply is too large', code: 'too_large' });
    if (err) return next(err);
    storeReply(req, res).catch(next);
  });
});

async function storeReply(req, res) {
  const ciphertext = Buffer.isBuffer(req.body) ? req.body : null;
  const iv = req.get('X-Secure-IV');
  if (!ciphertext || ciphertext.length <= 16 || !decodeBase64(iv, { exactBytes: 12 })) {
    return res.status(400).json({ error: 'The encrypted reply is missing or invalid', code: 'invalid' });
  }
  const row = await authorize(req, res, req.get('X-Secure-Auth'));
  if (!row) return;
  const reply = await addReply(row.id, ciphertext, iv);
  if (!reply) return res.status(409).json({ error: 'No more replies can be sent to this message', code: 'reply_limit' });
  // The owner hears of it in the app, and on their devices, without a word of what it says: the
  // server cannot read it.
  req.app.get('imapManager')?.broadcast?.({ type: 'secure_message_reply', id: row.id }, row.user_id);
  sendPushToUser(row.user_id, { title: 'Plimail', body: 'New reply to a password-protected message', url: '/' })
    .catch(err => console.warn('Push notification error:', err.message));
  res.status(201).json({ ok: true, createdAt: reply.createdAt });
}

export default router;
