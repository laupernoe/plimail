import { isIP } from 'net';
import { redisClient } from './redis.js';

// Passkeys (WebAuthn), routes/passkeys.js. What decides where they can work, and the one-time
// challenges the ceremonies sign.
//
// The relying party is the installation's own address, APP_URL: its hostname is the RP ID every
// passkey is bound to, and a browser only uses a passkey on that host (or a subdomain of it). An
// address that is an IP cannot be an RP ID at all, which is the case of a LAN or staging install
// opened at https://192.168.x.y with a self-signed certificate, so passkeys are reported as
// unavailable there rather than failing in the browser. Plain HTTP works on localhost only, as
// browsers allow WebAuthn nowhere else without TLS.

export const CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const MAX_PASSKEYS = 20;
export const NAME_MAX = 64;

const isLocalhost = host => host === 'localhost' || host.endsWith('.localhost');

// { available: true, rpId, origins } or { available: false, reason }, reason one of 'noAppUrl',
// 'ip', 'insecure'. `origins`: APP_URL's, and FRONTEND_URL's when it is the same host on another
// port (the Vite dev server).
export function relyingParty(env = process.env) {
  let url;
  try { url = new URL(env.APP_URL); } catch { return { available: false, reason: 'noAppUrl' }; }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host) return { available: false, reason: 'noAppUrl' };
  if (isIP(host)) return { available: false, reason: 'ip' };
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocalhost(host))) {
    return { available: false, reason: 'insecure' };
  }
  const origins = [url.origin];
  try {
    const frontend = new URL(env.FRONTEND_URL);
    if (frontend.hostname === url.hostname && !origins.includes(frontend.origin)) origins.push(frontend.origin);
  } catch { /* unset or unparseable: APP_URL alone */ }
  return { available: true, rpId: host, origins };
}

// The WebAuthn user handle for a user: their id's 16 bytes, which says nothing about them.
export const userHandle = userId => new Uint8Array(Buffer.from(String(userId).replace(/-/g, ''), 'hex'));
export const userHandleBase64Url = userId => Buffer.from(userHandle(userId)).toString('base64url');

// A name the user gave a passkey: one line, at most NAME_MAX characters; '' when nothing is left.
export function cleanPasskeyName(name) {
  if (typeof name !== 'string') return '';
  // eslint-disable-next-line no-control-regex -- control characters are what is being removed
  return name.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX).trim();
}

// The challenge of a ceremony in progress, in the session (Redis-backed), for one purpose:
// 'login', or 'register' for the signed-in user it was made for.
export function rememberChallenge(session, purpose, challenge, { userId = null, now = Date.now() } = {}) {
  session.passkeyChallenge = { purpose, challenge, userId, until: now + CHALLENGE_TTL_MS };
}

// The challenge to verify a response against, or null. It leaves the session here whatever
// happens next, so a response can be checked against it once. Two requests sent together each
// load their own copy of the session before either is saved, so the challenge is also claimed in
// Redis, with SET NX as the sign-in's two-factor codes are (routes/auth.js): only one of them gets
// it.
export async function takeChallenge(session, purpose, { now = Date.now() } = {}) {
  const pending = session?.passkeyChallenge;
  if (session) delete session.passkeyChallenge;
  if (!pending || pending.purpose !== purpose || typeof pending.challenge !== 'string' || !(pending.until > now)) return null;
  if (purpose === 'register' && pending.userId !== session.userId) return null;
  const first = await redisClient.set(`passkey_challenge_used:${pending.challenge}`, '1', { NX: true, PX: CHALLENGE_TTL_MS });
  return first ? pending.challenge : null;
}

// What the settings list shows of a passkey row.
export const passkeyView = row => ({
  id: row.id,
  name: row.name,
  createdAt: row.created_at,
  lastUsedAt: row.last_used_at || null,
  backedUp: row.backed_up === true,
});
