import { Router } from 'express';
import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { query } from '../services/db.js';
import { imapManager } from '../index.js';
import { requireAuth } from '../middleware/auth.js';
import { logAuthEvent } from '../services/authEvents.js';
import { authLimiterConfig } from '../services/authLimiter.js';
import { confirmReauth, userForReauth } from '../services/apiTokenReauth.js';
import { consumeLoginAttempt } from '../services/loginLimiter.js';
import {
  CHALLENGE_TTL_MS, MAX_PASSKEYS, cleanPasskeyName, passkeyView, relyingParty, rememberChallenge, takeChallenge,
  userHandle, userHandleBase64Url,
} from '../services/passkeys.js';
import { consume as rlConsume, release as rlRelease } from '../services/rateLimiter.js';
import { rateLimitAddress } from '../utils/rateLimitAddress.js';

// Passkeys: managing them in Settings → Security, and signing in with one.
//
// A passkey sign-in is complete on its own. User verification is required at every ceremony, so
// the authenticator has checked a fingerprint, a face or a PIN on top of holding the key: that is
// two factors, and the sign-in does not then ask for the password or the two-factor code, nor for
// the emailed code or an authenticator when the admin requires two-factor. It ends as a password
// sign-in does (routes/auth.js): a regenerated session in Redis, the same session fields, the
// user's mail connections started and a login_success event.
//
// Adding or removing a passkey takes the account password again (confirmPassword in
// apiTokenReauth.js, counted against the sign-in budget auth:<ip>), so a browser left signed in
// cannot quietly add a way in or take one away. Renaming does not. An account without a password
// (single sign-on only) cannot add one, and no one can sign in with one while the admin has turned
// password sign-in off: that setting sends everyone through the identity provider.
//
// None of these routes is on the API token allowlist (apiTokenAllowlist.js).

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USER_FIELDS = 'id, username, display_name, avatar, is_admin, totp_enabled';

// The per-address sign-in budget of routes/auth.js, under the same key, so password and passkey
// attempts from one address add up. An attempt that succeeds hands its own hit back.
async function authLimiter(req, res, next) {
  const key = `auth:${rateLimitAddress(req.ip)}`;
  const { limited, resetMs } = await rlConsume(key, authLimiterConfig.maxRequests, authLimiterConfig.windowMs);
  if (limited) return tooMany(res, resetMs);
  res.locals.releaseRateLimit = () => rlRelease(key);
  next();
}

function tooMany(res, resetMs) {
  res.setHeader('Retry-After', Math.max(1, Math.ceil(resetMs / 1000)));
  return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
}

// Asking for a challenge proves nothing and is made on every visit to the sign-in page, so it does
// not spend the sign-in budget; it has its own, which keeps anyone from filling Redis with sessions.
const OPTIONS_LIMIT = { max: 60, windowMs: 15 * 60 * 1000 };
async function optionsLimiter(req, res, next) {
  const { limited, resetMs } = await rlConsume(`passkey-options:${rateLimitAddress(req.ip)}`, OPTIONS_LIMIT.max, OPTIONS_LIMIT.windowMs);
  if (limited) return tooMany(res, resetMs);
  next();
}

function withRelyingParty(req, res, next) {
  const rp = relyingParty();
  if (!rp.available) {
    return res.status(409).json({ error: 'Passkeys are not available at this server address.', code: 'unavailable', reason: rp.reason });
  }
  res.locals.rp = rp;
  next();
}

async function passwordLoginDisabled() {
  const { rows } = await query("SELECT value FROM system_settings WHERE key = 'internal_auth_disabled'");
  return rows[0]?.value === 'true';
}
const PASSWORD_LOGIN_OFF = { error: 'Sign-in with a password or a passkey is disabled. Please sign in with your SSO provider.', code: 'passwordLoginOff' };

const userPayload = user => ({
  id: user.id, username: user.username, displayName: user.display_name, avatar: user.avatar,
  isAdmin: user.is_admin, totpEnabled: user.totp_enabled,
});

const asCredential = row => ({
  id: row.credential_id,
  publicKey: new Uint8Array(row.public_key),
  counter: Number(row.counter),
  transports: Array.isArray(row.transports) ? row.transports : [],
});

const challengeGone = res => res.status(400).json({ error: 'This request has expired or was already used. Try again.', code: 'challenge' });

// Whether passkeys can work here, for the sign-in page and Settings. Public: it says only what
// APP_URL says.
router.get('/status', (req, res) => {
  const rp = relyingParty();
  res.json(rp.available ? { available: true, rpId: rp.rpId } : { available: false, reason: rp.reason });
});

// ── Sign-in ──────────────────────────────────────────────────────────────────

// Options for a discoverable-credential sign-in (no username: the authenticator offers the
// passkeys it holds for this site), used by the button and by the browser's autofill
// (conditional mediation) alike.
router.post('/login/options', optionsLimiter, withRelyingParty, async (req, res) => {
  if (await passwordLoginDisabled()) return res.status(403).json(PASSWORD_LOGIN_OFF);
  const options = await generateAuthenticationOptions({
    rpID: res.locals.rp.rpId, userVerification: 'required', timeout: CHALLENGE_TTL_MS,
  });
  rememberChallenge(req.session, 'login', options.challenge);
  res.json({ options });
});

router.post('/login/verify', authLimiter, withRelyingParty, async (req, res) => {
  const response = req.body?.response;
  const challenge = await takeChallenge(req.session, 'login');
  if (await passwordLoginDisabled()) return res.status(403).json(PASSWORD_LOGIN_OFF);
  if (!response || typeof response !== 'object' || typeof response.id !== 'string' || !response.id) {
    return res.status(400).json({ error: 'Passkey response required' });
  }
  if (!challenge) return challengeGone(res);

  const failed = (fields = {}) => {
    logAuthEvent('login_fail', { ...fields, ip: req.ip, success: false });
    return res.status(401).json({ error: 'This passkey could not sign you in.' });
  };

  const { rows: [passkey] } = await query('SELECT * FROM passkeys WHERE credential_id = $1', [response.id]);
  // Deleting a user deletes their passkeys, so a passkey of a deleted account is not found here.
  if (!passkey) return failed();
  const { rows: [user] } = await query(`SELECT ${USER_FIELDS} FROM users WHERE id = $1`, [passkey.user_id]);
  if (!user) return failed();
  const who = { username: user.username, userId: user.id };

  const attempt = await consumeLoginAttempt(user.username, req.ip);
  if (attempt.limited) return tooMany(res, attempt.resetMs);

  // The account the authenticator says the passkey belongs to must be the one it was added to.
  const handle = response.response?.userHandle;
  if (handle && handle !== userHandleBase64Url(user.id)) return failed(who);

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: res.locals.rp.origins,
      expectedRPID: res.locals.rp.rpId,
      credential: asCredential(passkey),
      requireUserVerification: true,
    });
  } catch (err) {
    if (/counter/i.test(err?.message || '')) {
      console.warn(`[passkeys] refused a sign-in to ${user.username} with passkey ${passkey.id}: its signature counter did not go up (${err.message}). The passkey may have been copied.`);
    }
    return failed(who);
  }
  if (!verification.verified) return failed(who);

  // The counter moves only forward, also against another sign-in with the same passkey being
  // checked at the same moment. Authenticators that keep no counter always send 0.
  const { newCounter, credentialBackedUp } = verification.authenticationInfo;
  const moved = await query(
    `UPDATE passkeys SET counter = $2, backed_up = $3, last_used_at = NOW()
      WHERE id = $1 AND (counter < $2 OR (counter = 0 AND $2 = 0))`,
    [passkey.id, newCounter, credentialBackedUp === true]
  );
  if (!moved.rowCount) {
    console.warn(`[passkeys] refused a sign-in to ${user.username} with passkey ${passkey.id}: another sign-in already used counter ${newCounter}.`);
    return failed(who);
  }

  await attempt.succeeded();
  await res.locals.releaseRateLimit?.();
  // As routes/auth.js does at every sign-in: a new session id before any auth state is stored.
  await new Promise((resolve, reject) => req.session.regenerate(err => (err ? reject(err) : resolve())));
  req.session.userId = user.id;
  req.session.username = user.username;
  req.session.isAdmin = user.is_admin;
  imapManager.connectAllForUser(user.id);
  logAuthEvent('login_success', { ...who, ip: req.ip, success: true });
  res.json({ user: userPayload(user) });
});

// ── Managing the signed-in user's passkeys ───────────────────────────────────

router.get('/', requireAuth, async (req, res) => {
  const { rows } = await query(
    'SELECT id, name, created_at, last_used_at, backed_up FROM passkeys WHERE user_id = $1 ORDER BY created_at',
    [req.session.userId]
  );
  res.json({ passkeys: rows.map(passkeyView) });
});

// The password check before adding or removing a passkey: { user } once it was given and right,
// else the response has been sent.
async function confirmWithPassword(req, res) {
  const user = await userForReauth(req.session.userId);
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return null;
  }
  if (await passwordLoginDisabled()) {
    res.status(403).json(PASSWORD_LOGIN_OFF);
    return null;
  }
  if (!user.password_hash) {
    res.status(403).json({ error: 'Your account has no password to confirm with. Passkeys need one.', code: 'noPassword' });
    return null;
  }
  const { refusal } = await confirmReauth(req, user, 'password');
  if (refusal) {
    for (const [name, value] of Object.entries(refusal.headers || {})) res.setHeader(name, value);
    res.status(refusal.status).json(refusal.body);
    return null;
  }
  return user;
}

router.post('/registration/options', requireAuth, withRelyingParty, async (req, res) => {
  const user = await confirmWithPassword(req, res);
  if (!user) return;
  const { rows: existing } = await query('SELECT credential_id, transports FROM passkeys WHERE user_id = $1', [user.id]);
  if (existing.length >= MAX_PASSKEYS) {
    return res.status(409).json({ error: `At most ${MAX_PASSKEYS} passkeys per account.`, code: 'tooMany' });
  }
  const { rows: [profile] } = await query('SELECT display_name FROM users WHERE id = $1', [user.id]);
  const options = await generateRegistrationOptions({
    rpName: 'Plimail',
    rpID: res.locals.rp.rpId,
    userName: user.username,
    userID: userHandle(user.id),
    userDisplayName: profile?.display_name || user.username,
    timeout: CHALLENGE_TTL_MS,
    attestationType: 'none',
    excludeCredentials: existing.map(row => ({ id: row.credential_id, transports: Array.isArray(row.transports) ? row.transports : [] })),
    // Discoverable, so the sign-in page needs no username; verified, so it is two factors.
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
  });
  rememberChallenge(req.session, 'register', options.challenge, { userId: user.id });
  res.json({ options });
});

router.post('/registration/verify', requireAuth, withRelyingParty, async (req, res) => {
  const challenge = await takeChallenge(req.session, 'register');
  const response = req.body?.response;
  if (!response || typeof response !== 'object') return res.status(400).json({ error: 'Passkey response required' });
  if (!challenge) return challengeGone(res);

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: res.locals.rp.origins,
      expectedRPID: res.locals.rp.rpId,
      requireUserVerification: true,
    });
  } catch (err) {
    console.warn(`[passkeys] refused a new passkey for user ${req.session.userId}: ${err.message}`);
    return res.status(400).json({ error: 'The passkey could not be verified.', code: 'rejected' });
  }
  if (!verification.verified) return res.status(400).json({ error: 'The passkey could not be verified.', code: 'rejected' });

  const { credential, credentialDeviceType, credentialBackedUp, aaguid } = verification.registrationInfo;
  const name = cleanPasskeyName(req.body?.name) || 'Passkey';
  const { rows: [row] } = await query(
    `INSERT INTO passkeys (user_id, credential_id, public_key, counter, transports, device_type, backed_up, aaguid, name)
     SELECT $1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9
      WHERE (SELECT COUNT(*) FROM passkeys WHERE user_id = $1) < $10
     ON CONFLICT (credential_id) DO NOTHING
     RETURNING id, name, created_at, last_used_at, backed_up`,
    [
      req.session.userId, credential.id, Buffer.from(credential.publicKey), credential.counter,
      JSON.stringify(credential.transports || []), credentialDeviceType, credentialBackedUp === true, aaguid, name, MAX_PASSKEYS,
    ]
  );
  if (!row) return res.status(409).json({ error: 'This passkey is already added, or the account has as many as it can.', code: 'notAdded' });
  logAuthEvent('passkey_added', { userId: req.session.userId, username: req.session.username, ip: req.ip, success: true });
  res.status(201).json({ passkey: passkeyView(row) });
});

router.patch('/:id', requireAuth, async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Passkey not found' });
  const name = cleanPasskeyName(req.body?.name);
  if (!name) return res.status(400).json({ error: 'Name required' });
  const { rows: [row] } = await query(
    'UPDATE passkeys SET name = $3 WHERE id = $1 AND user_id = $2 RETURNING id, name, created_at, last_used_at, backed_up',
    [req.params.id, req.session.userId, name]
  );
  if (!row) return res.status(404).json({ error: 'Passkey not found' });
  res.json({ passkey: passkeyView(row) });
});

router.delete('/:id', requireAuth, async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Passkey not found' });
  const user = await confirmWithPassword(req, res);
  if (!user) return;
  const removed = await query('DELETE FROM passkeys WHERE id = $1 AND user_id = $2', [req.params.id, user.id]);
  if (!removed.rowCount) return res.status(404).json({ error: 'Passkey not found' });
  logAuthEvent('passkey_removed', { userId: user.id, username: user.username, ip: req.ip, success: true });
  res.json({ ok: true });
});

export default router;
