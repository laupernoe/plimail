// Asking for the Plimail password when a key protected by it is needed and this tab has no secret
// for it (utils/pgpSecret.js): a new tab, a sign-in through SSO, after the screen lock. One request
// at a time, shown by PgpUnlockPrompt.jsx; every caller waiting meanwhile gets the same answer.

import { PgpError } from './pgp.js';
import { isLoginKey, openOwnKey } from './pgpKeys.js';
import { keySecretEntry, waitForKeySecret } from './pgpSecret.js';

let open = null; // { id, options, promise, resolve, reject }
let seq = 0;
const listeners = new Set();
const notify = () => { for (const fn of [...listeners]) fn(); };

export function subscribeUnlock(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export const currentUnlockRequest = () => open;

// Resolves once the prompt has a secret in place (pgpSecret.js), rejects with
// PgpError('unlockCancelled') when the user closes it. `options.stale`: the secret this tab has
// is the current password's, but the keys were protected under an earlier one, so the prompt asks
// for that one and encrypts the keys again for the current.
export function requestKeyUnlock(options = {}) {
  if (open) {
    if (options.stale && !open.options.stale) { open = { ...open, options: { ...open.options, stale: true } }; notify(); }
    return open.promise;
  }
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  open = { id: ++seq, options, promise, resolve, reject };
  notify();
  return promise;
}

export function finishUnlock() {
  const done = open;
  open = null;
  notify();
  done?.resolve();
}

export function cancelUnlock() {
  const done = open;
  open = null;
  notify();
  done?.reject(new PgpError('unlockCancelled'));
}

// The secret entry for a key needed now: the one kept, the one sign-in is still deriving, or the
// one the user gives in the prompt.
export async function ensureKeySecret(userId, options = {}) {
  if (await waitForKeySecret(userId)) return keySecretEntry(userId);
  await requestKeyUnlock(options);
  return keySecretEntry(userId);
}

// The user's key `row` opened for use, asking what has to be asked: the Plimail password for a
// key protected by it (once per tab), or, with `passphrase`, a key's own passphrase. A key made
// under an earlier password brings the prompt's "previous password" step, once.
export async function unlockOwnKey(row, userId, { passphrase = '', remember = true } = {}) {
  if (!isLoginKey(row)) return openOwnKey(row, { passphrase, remember });
  let entry = await ensureKeySecret(userId);
  try {
    return await openOwnKey(row, { secret: entry?.secret, verified: entry?.verified !== false, remember });
  } catch (err) {
    if (err?.code !== 'staleSecret' && err?.code !== 'needsSecret') throw err;
    await requestKeyUnlock({ stale: err.code === 'staleSecret' });
    entry = keySecretEntry(userId);
    return openOwnKey(row, { secret: entry?.secret, verified: false, remember });
  }
}
