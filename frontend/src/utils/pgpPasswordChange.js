// A Plimail password change, as it concerns the user's OpenPGP keys: the keys protected by the old
// password's secret (utils/pgpSecret.js) are encrypted again, here, for the new one, and sent with
// the new password so the server stores both in one transaction (routes/admin.js). Until that
// commits, the stored keys stay as they were, under the old password: a change that fails, or a
// key that does not open, loses nothing.
//
// Only the user's own browser can do this, with the old secret in hand; the one place Plimail lets
// a signed-in user set their own password is an admin's user editor. A password set for someone
// else, or reset through a link, leaves the keys under the old password: the user gives it once,
// and the unlock prompt moves them (PgpUnlockPrompt.jsx 'previous').

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
