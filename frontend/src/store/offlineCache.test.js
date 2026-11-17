// The mail kept for offline reading (utils/offlineCache.js) goes when the user locks the screen,
// signs out or is replaced by another, and stays for a cold start that may be reading it offline.

import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
registerHooks({ load(url, context, nextLoad) {
  return url.endsWith('.json') ? { format: 'module', source: `export default ${readFileSync(new URL(url), 'utf8')}`, shortCircuit: true } : nextLoad(url, context);
} });
const values = new Map();
globalThis.localStorage = {
  getItem: k => (values.has(k) ? values.get(k) : null),
  setItem: (k, v) => values.set(k, String(v)),
  removeItem: k => values.delete(k),
};
const { useStore } = await import('./index.js');
globalThis.window = new EventTarget();
const { setOfflineStorageForTest } = await import('../utils/offlineCache.js');

let deleted;
beforeEach(() => {
  useStore.setState({ user: null, isLocked: false });
  deleted = [];
  setOfflineStorageForTest(() => ({ delete: async (name) => { deleted.push(name); return true; } }));
});

test('a cold start keeps what was saved: it may be all there is to read', () => {
  useStore.getState().setUser({ id: 'u1' });
  assert.deepEqual(deleted, []);
});

test('locking the screen drops it', () => {
  useStore.getState().setUser({ id: 'u1' });
  useStore.getState().setLocked(true);
  assert.deepEqual(deleted, ['plimail-offline-v1']);
});

test('the user leaving or another signing in drops it', () => {
  useStore.getState().setUser({ id: 'u1' });
  useStore.getState().setUser(null);
  assert.deepEqual(deleted, ['plimail-offline-v1']);
  useStore.getState().setUser({ id: 'u1' });
  useStore.getState().setUser({ id: 'u2' });
  assert.equal(deleted.length, 2);
});
