// Offline reading: the last answers to the requests that show mail (accounts, folders, message
// lists, messages, bodies, threads) are kept in the browser's Cache Storage, and served from it
// only when the server cannot be reached. Online, every request goes to the server as before.
//
// What is kept is the server's JSON as it was sent, so a PGP message stays the ciphertext the
// server holds: what the browser decrypts is never written here. Nothing else under /api is kept,
// and the cache is dropped whenever the mail stops being this user's to read: sign-out, a session
// that expired (401), the screen lock (locally, or the server's 423), or another user signing in.
// A request that was under way when the cache was dropped does not write its answer back.
//
// No imports: the backend's tests load modules that load api.js, without frontend/node_modules.

const CACHE_NAME = 'plimail-offline-v1';
// Each entry is one answer; the oldest written go first. Cache Storage moves an entry to the end
// when it is written again, so what was read recently stays.
const MAX_ENTRIES = 500;

const KEPT = [
  /^\/auth\/me$/,
  /^\/accounts$/,
  /^\/accounts\/[\w-]+\/folders$/,
  /^\/mail\/unread-counts$/,
  /^\/mail\/messages\?[^/]*$/,
  /^\/mail\/messages\/[\w-]+$/,
  /^\/mail\/messages\/[\w-]+\/body(?:\?[\w=&]*)?$/,
  /^\/mail\/thread\?[^/]*$/,
];

let storage = () => (typeof caches !== 'undefined' ? caches : null);
let generation = 0;

export function keptOffline(method, path) {
  return method === 'GET' && KEPT.some(re => re.test(path));
}

// Taken before a request goes out, and handed back with its answer.
export function offlineGeneration() {
  return generation;
}

export async function saveOffline(path, data, gen) {
  const store = storage();
  if (!store || gen !== generation) return;
  // A session the server reports locked is not one to open without the PIN.
  if (path === '/auth/me' && (!data?.user || data.user.locked)) return;
  const cache = await store.open(CACHE_NAME);
  // Checked again: the cache may have been dropped while it opened.
  if (gen !== generation) return;
  await cache.put('/api' + path, new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json' },
  }));
  if (gen !== generation) { await store.delete(CACHE_NAME); return; }
  const keys = await cache.keys();
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) await cache.delete(key);
}

// The saved answer, or undefined.
export async function readOffline(path) {
  const store = storage();
  if (!store) return undefined;
  try {
    const cache = await store.open(CACHE_NAME);
    const hit = await cache.match('/api' + path);
    return hit ? await hit.json() : undefined;
  } catch {
    return undefined;
  }
}

export async function clearOffline() {
  generation += 1;
  const store = storage();
  if (!store) return;
  try { await store.delete(CACHE_NAME); } catch { /* nothing kept to remove */ }
}

// Whether the server could be reached the last time anything asked, for the offline banner.
let offline = typeof navigator !== 'undefined' && navigator.onLine === false;
const listeners = new Set();

export function isOffline() { return offline; }

export function subscribeOffline(fn) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function setOffline(value) {
  if (offline === Boolean(value)) return;
  offline = Boolean(value);
  for (const fn of listeners) fn();
}

// The browser knows first when the network goes; whether the server answers again is up to
// the next request.
export function watchConnection(win) {
  win.addEventListener('offline', () => setOffline(true));
  win.addEventListener('online', () => setOffline(false));
}

// What a request that could not reach the server throws: a message the user can read in a toast
// or the composer, and code 'offline' for a caller that wants to tell. main.jsx hands in the
// translation.
let unreachableText = () => "Plimail can't reach the server. Check your connection and try again.";
export function setUnreachableText(fn) { unreachableText = fn; }

export function offlineError(cause) {
  return Object.assign(new Error(unreachableText()), { code: 'offline', cause });
}

// For tests.
export function setOfflineStorageForTest(fn) {
  storage = fn;
  generation = 0;
  offline = false;
  listeners.clear();
}
