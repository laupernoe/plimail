import { api } from './api.js';

// The user's own keys (GET /api/pgp/keys), asked for once per page and again after a change:
// Settings, the unlock prompt and the automatic keys say so with ownKeysChanged(), and whatever
// shows the keys listens for OWN_KEYS_CHANGED.
export const OWN_KEYS_CHANGED = 'plimail:pgp-keys-changed';

let ownKeysPromise = null;
export function loadOwnKeys({ fresh = false } = {}) {
  if (fresh || !ownKeysPromise) {
    ownKeysPromise = api.pgp.keys().then(r => r.keys || []).catch((err) => { ownKeysPromise = null; throw err; });
  }
  return ownKeysPromise;
}

export function ownKeysChanged() {
  ownKeysPromise = null;
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(OWN_KEYS_CHANGED));
}

// Forgets the cached keys: they are the leaving user's.
export function forgetOwnKeys() {
  ownKeysPromise = null;
}
