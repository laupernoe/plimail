// A Plimail password change, as it concerns the user's OpenPGP keys: the keys protected by the old
// password's secret (utils/pgpSecret.js) are encrypted again, here, for the new one, and sent with
// the new password so the server stores both in one transaction (routes/admin.js). Until that
// commits, the stored keys stay as they were, under the old password: a change that fails, or a
// key that does not open, loses nothing.
//
// Only the user's own browser can do this, with the old secret in hand: Settings → Security
// (PasswordChangeSection.jsx, POST /api/auth/password) and an admin's own entry in the user editor.
// A password set for someone else, or reset through a link, leaves the keys under the old
// password: the user gives it once, and the unlock prompt moves them (PgpUnlockPrompt.jsx
// 'previous').
//
// The salt (users.pgp_kdf_salt) is the same before and after: it is there so two users with the
// same password do not get the same secret, which a new password does not change. Keeping it is
// what lets a key left under an earlier password still be opened with that password later.

import { PgpError } from './pgp.js';
import { isLoginKey, rewrapLoginKeys } from './pgpKeys.js';
import { deriveKeySecret } from './pgpSecret.js';

// { pgpKeys, secret }: the keys to send with the new password (undefined when there are none) and
// the new secret, to keep once the change is stored. `currentSecret()` gives the old password's
// secret, asking for it if the tab has none, and may throw PgpError('unlockCancelled').
// A stale key (already under an even older password) is left as it is: the old secret does not
// open it either, and it must not stop the change. The keys are read again once re-encrypted; a
// key another tab made meanwhile (or one changed there) means doing it over, so none is left out.
const fingerprintOf = keys => keys.map(k => `${k.id}:${k.armoredPrivate}`).sort().join('\n');
export async function keysForNewPassword({ newPassword, loadKeys, fetchSalt, currentSecret, derive = deriveKeySecret, rewrap = rewrapLoginKeys, attempts = 3 }) {
  const { salt } = await fetchSalt();
  const secret = await derive(newPassword, salt);
  let from = null;
  for (let i = 0; i < attempts; i++) {
    const keys = (await loadKeys()).filter(k => isLoginKey(k) && !k.stale);
    if (!keys.length) return { pgpKeys: undefined, secret };
    if (!from) from = await currentSecret();
    if (!from) throw new PgpError('unlockCancelled');
    const updates = await rewrap(keys, { from, to: secret });
    const again = (await loadKeys()).filter(k => isLoginKey(k) && !k.stale);
    if (fingerprintOf(again) === fingerprintOf(keys)) return { pgpKeys: updates.length ? updates : undefined, secret };
  }
  throw new PgpError('keysChanging');
}

// Settings → Security: the user typed the current password, which the server has just confirmed,
// so the old secret is derived from it rather than taken from the tab (another tab may hold one
// that is older still). Resolves to { pgpKeys, secret, unopened }: the keys to send with the new
// password, the new secret, and the 'login' keys the current password does not open (stale ones
// included, unless their flag was out of date and they open after all). Those are not sent: they
// stay as they are, under an earlier password, which the caller tells the user before going on.
export async function planOwnPasswordChange({ currentPassword, newPassword, loadKeys, fetchSalt, derive = deriveKeySecret, rewrap = rewrapLoginKeys, attempts = 3 }) {
  const { salt } = await fetchSalt();
  const [from, secret] = await Promise.all([derive(currentPassword, salt), derive(newPassword, salt)]);
  for (let i = 0; i < attempts; i++) {
    const keys = (await loadKeys()).filter(isLoginKey);
    if (!keys.length) return { pgpKeys: undefined, secret, unopened: [] };
    const unopened = [];
    const updates = await rewrap(keys, { from, to: secret, onUnopened: row => unopened.push(row) });
    const again = (await loadKeys()).filter(isLoginKey);
    if (fingerprintOf(again) === fingerprintOf(keys)) return { pgpKeys: updates.length ? updates : undefined, secret, unopened };
  }
  throw new PgpError('keysChanging');
}
