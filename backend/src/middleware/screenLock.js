// Screen-lock enforcement (#235). A locked session may only reach the endpoints
// needed to render the lock screen, unlock, or sign out; everything else returns
// 423 Locked until the PIN is verified (routes/auth.js sets req.session.locked).
// Matches the full path (minus query) so it can't fail open on mount-relative paths.
//
// The lock belongs to a browser session. An API token request has no `locked` flag, so it is
// never held here; its own allowlist (services/apiTokenAllowlist.js) decides what it reaches.
const LOCK_ALLOWED = new Set(['/api/auth/unlock', '/api/auth/logout', '/api/auth/me', '/api/health', '/api/version']);

// The recipient's side of a password-protected message (routes/secureMessagesPublic.js) acts for
// someone with no account here and never reads the session, so whoever is signed in on the same
// browser, locked or not, has nothing to do with it.
const SESSIONLESS = /^\/api\/s\/[^/?]+\/(?:meta|open|reply)(?:\?|$)/;

export function screenLockGate(req, res, next) {
  if (req.session?.locked && !LOCK_ALLOWED.has(req.originalUrl.split('?')[0]) && !SESSIONLESS.test(req.originalUrl)) {
    return res.status(423).json({ error: 'Locked', locked: true });
  }
  next();
}
