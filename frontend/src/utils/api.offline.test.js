// Offline reading (utils/offlineCache.js) through the API client: what is kept, when it is served,
// what a write does without a server, and when the kept mail is dropped.

import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { api } from './api.js';
import { clearOffline, isOffline, setOfflineStorageForTest, subscribeOffline } from './offlineCache.js';

// Cache Storage as browsers have it: one named cache, entries in the order they were last written.
function fakeCaches() {
  const stores = new Map();
  const open = async (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const entries = stores.get(name);
    return {
      match: async key => entries.get(key)?.clone(),
      put: async (key, response) => { entries.delete(key); entries.set(key, response); },
      keys: async () => [...entries.keys()],
      delete: async key => entries.delete(key),
    };
  };
  return { stores, open, delete: async name => stores.delete(name) };
}

const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;
let caches;
let server;   // path -> [status, body], or a function; null: the network is down

function reply(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

// Lets the writes saveOffline makes in the background land.
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const kept = () => [...(caches.stores.get('plimail-offline-v1')?.keys() ?? [])];

beforeEach(() => {
  caches = fakeCaches();
  setOfflineStorageForTest(() => caches);
  globalThis.window = { dispatchEvent() {} };
  server = {};
  globalThis.fetch = async (url) => {
    if (server === null) throw new TypeError('Failed to fetch');
    const path = url.slice('/api'.length);
    const answer = server[path];
    if (typeof answer === 'function') return answer();
    return answer ? reply(...answer) : reply(404, { error: 'Not found' });
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.window = originalWindow;
});

test('a message read online can be read again while the server is out of reach', async () => {
  server['/mail/messages/m1'] = [200, { id: 'm1', subject: 'Hello' }];
  server['/mail/messages/m1/body'] = [200, { html: '<p>Hi</p>' }];
  server['/mail/messages?limit=50&offset=0&folder=INBOX'] = [200, { messages: [{ id: 'm1' }], total: 1 }];
  await api.getMessage('m1');
  await api.getMessageBody('m1');
  await api.getMessages({ limit: 50, offset: 0, folder: 'INBOX' });
  await settle();

  server = null;
  assert.deepEqual(await api.getMessage('m1'), { id: 'm1', subject: 'Hello' });
  assert.deepEqual(await api.getMessageBody('m1'), { html: '<p>Hi</p>' });
  assert.deepEqual(await api.getMessages({ limit: 50, offset: 0, folder: 'INBOX' }), { messages: [{ id: 'm1' }], total: 1 });
  assert.equal(isOffline(), true);
});

test('online, the server answers, not the cache', async () => {
  server['/mail/messages/m1'] = [200, { id: 'm1', subject: 'Old' }];
  await api.getMessage('m1');
  await settle();
  server['/mail/messages/m1'] = [200, { id: 'm1', subject: 'New' }];
  assert.equal((await api.getMessage('m1')).subject, 'New');
  await settle();
  server = null;
  assert.equal((await api.getMessage('m1')).subject, 'New', 'the newest answer is the one kept');
});

test('the banner state follows whether the server answered', async () => {
  const seen = [];
  const stop = subscribeOffline(() => seen.push(isOffline()));
  server = null;
  await assert.rejects(api.getAccounts());
  server = { '/accounts': [200, []] };
  await api.getAccounts();
  stop();
  assert.deepEqual(seen, [true, false]);
});

test('a write without the server fails with an error that says so, and nothing is queued', async () => {
  server = null;
  const calls = [];
  const down = globalThis.fetch;
  globalThis.fetch = async (url, opts) => { calls.push([url, opts.method]); return down(url, opts); };
  await assert.rejects(api.post('/mail/send', { to: ['a@example.com'] }), (err) => {
    assert.equal(err.code, 'offline');
    assert.ok(!(err instanceof TypeError));
    assert.ok(err.cause instanceof TypeError);
    return true;
  });
  await assert.rejects(api.bulkRead(['m1'], true), { code: 'offline' });
  assert.equal(calls.length, 2, 'each was tried once, nothing retried later behind the user\'s back');
  assert.deepEqual(kept(), []);
});

test('something never read online is not there offline', async () => {
  server = null;
  await assert.rejects(api.getMessage('never-opened'), { code: 'offline' });
});

test('only the requests that show mail are kept', async () => {
  server['/auth/preferences'] = [200, { signature: 'x' }];
  server['/pgp/keys'] = [200, [{ armored: 'PRIVATE' }]];
  server['/mail/messages/m1'] = [200, { id: 'm1' }];
  await api.getPreferences();
  await api.get('/pgp/keys');
  await api.getMessage('m1');
  await settle();
  assert.deepEqual(kept(), ['/api/mail/messages/m1']);
});

test('a session the server reports locked is not kept for an offline start', async () => {
  server['/auth/me'] = [200, { user: { id: 'u1', locked: true } }];
  await api.me();
  await settle();
  assert.deepEqual(kept(), []);
  server['/auth/me'] = [200, { user: { id: 'u1', locked: false } }];
  await api.me();
  await settle();
  assert.deepEqual(kept(), ['/api/auth/me']);
});

for (const status of [401, 423]) {
  test(`a ${status} drops everything kept`, async () => {
    server['/mail/messages/m1'] = [200, { id: 'm1' }];
    await api.getMessage('m1');
    await settle();
    assert.equal(kept().length, 1);
    server['/accounts'] = [status, { error: 'no' }];
    await assert.rejects(api.getAccounts());
    await settle();
    server = null;
    await assert.rejects(api.getMessage('m1'), { code: 'offline' });
  });
}

test('an answer that arrives after the cache was dropped is not written back', async () => {
  let answer;
  server['/mail/messages/m1'] = () => new Promise(resolve => { answer = resolve; });
  const pending = api.getMessage('m1');
  await settle();
  await clearOffline();   // signed out, locked or expired while it was under way
  answer(reply(200, { id: 'm1', subject: 'Private' }));
  await pending;
  await settle();
  assert.deepEqual(kept(), []);
});

test('a cancelled request is passed on as a cancellation, not as offline', async () => {
  globalThis.fetch = async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); };
  await assert.rejects(api.getMessage('m1'), { name: 'AbortError' });
  assert.equal(isOffline(), false);
});

test('the oldest entries go once there are too many', async () => {
  for (let i = 0; i < 501; i++) server[`/mail/messages/m${i}`] = [200, { id: `m${i}` }];
  for (let i = 0; i < 501; i++) { await api.getMessage(`m${i}`); await settle(); }
  const keys = kept();
  assert.equal(keys.length, 500);
  assert.equal(keys.includes('/api/mail/messages/m0'), false);
  assert.equal(keys.includes('/api/mail/messages/m500'), true);
});
