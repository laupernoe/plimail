// public/sw.js caches the app's static files, and nothing else: never the API, the WebSocket or
// the page of a password-protected message. And a new release waits for the page's word.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const RAW = readFileSync(new URL('../../public/sw.js', import.meta.url), 'utf8');
const ORIGIN = 'https://mail.example';

const keyOf = req => (typeof req === 'string' ? new URL(req, ORIGIN).href : req.url);

function fakeCaches(initial = {}) {
  const stores = new Map(Object.entries(initial).map(([name, entries]) => [name, new Map(entries)]));
  const open = async (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const store = stores.get(name);
    return {
      match: async req => store.get(keyOf(req)),
      put: async (req, res) => { store.set(keyOf(req), res); },
    };
  };
  return {
    stores,
    open,
    keys: async () => [...stores.keys()],
    delete: async (name) => stores.delete(name),
  };
}

function response(body, { status = 200, type = 'basic' } = {}) {
  return { body, status, ok: status >= 200 && status < 300, type, clone() { return response(body, { status, type }); } };
}

function loadWorker({ buildId = 'abc123', precache = [], caches = fakeCaches(), respond = () => response('net') } = {}) {
  const source = buildId
    ? RAW.replace("'__PLIMAIL_BUILD_ID__'", JSON.stringify(buildId))
      .replace('/* __PLIMAIL_PRECACHE__ */', precache.map(p => JSON.stringify(p)).join(', '))
    : RAW;
  const listeners = {};
  const fetches = [];
  let skipped = 0;
  let claimed = 0;
  const self = {
    addEventListener: (type, fn) => { listeners[type] = fn; },
    registration: { showNotification: async () => {} },
    clients: { matchAll: async () => [], openWindow: async () => {}, claim: async () => { claimed++; } },
    location: { origin: ORIGIN },
    caches,
    skipWaiting: () => { skipped++; },
  };
  const fetch = async (req) => {
    const url = keyOf(req);
    fetches.push(url);
    return respond({ url, mode: req.mode });
  };
  vm.runInNewContext(source, { self, fetch, URL, JSON, Promise, Array, encodeURIComponent });

  // Resolves to the response the worker answered with, or undefined when it let the request
  // through to the network on its own.
  const request = async (path, { method = 'GET', mode = 'cors' } = {}) => {
    let answered;
    listeners.fetch({ request: { url: path.startsWith('https:') ? path : ORIGIN + path, method, mode }, respondWith: p => { answered = p; } });
    return answered ? await answered : undefined;
  };
  const lifecycle = async (type, event = {}) => {
    let done = Promise.resolve();
    listeners[type]({ ...event, waitUntil: p => { done = p; } });
    await done;
  };
  return { request, lifecycle, fetches, caches, get skipped() { return skipped; }, get claimed() { return claimed; } };
}

test('the fingerprinted bundle, pdf.js runtime files and fonts are cached and served from the cache', async () => {
  const sw = loadWorker();
  for (const path of ['/assets/index-DdCx12.js', '/pdfjs/6.3.289/cmaps/Adobe-GB1-UCS2.bcmap', '/fonts/inter.woff2']) {
    assert.equal((await sw.request(path)).body, 'net');
    assert.equal((await sw.request(path)).body, 'net');
  }
  assert.equal(sw.fetches.length, 3, 'the second request of each came from the cache');
  assert.deepEqual([...sw.caches.stores.get('plimail-static-abc123').keys()].length, 3);
});

test('never touches the API, the WebSocket, sign-in or a protected message page', async () => {
  const sw = loadWorker();
  const paths = [
    '/api/mail/messages', '/api/auth/me', '/ws', '/s/AbC_123', '/s/AbC_123/', '/oauth/callback',
    '/auth/oidc/callback', '/carddav/', '/.well-known/carddav',
    // A path under a cached prefix's name is still not cached when it is one of these.
    '/api/assets/x.js',
  ];
  for (const path of paths) assert.equal(await sw.request(path), undefined, path);
  assert.equal(sw.caches.stores.size, 0);
});

test('writes, query strings and other origins go to the network untouched', async () => {
  const sw = loadWorker();
  assert.equal(await sw.request('/index.html'), undefined);
  assert.equal(await sw.request('/sw.js'), undefined);
  assert.equal(await sw.request('/manifest.json'), undefined);
  assert.equal(await sw.request('/assets/x.js', { method: 'POST' }), undefined);
  assert.equal(await sw.request('/assets/x.js?token=1'), undefined);
  assert.equal(await sw.request('https://cdn.example/assets/x.js'), undefined);
  assert.equal(sw.caches.stores.size, 0);
});

test('a 404 or an opaque answer is passed on but not kept', async () => {
  const sw = loadWorker({ respond: () => response('missing', { status: 404 }) });
  assert.equal((await sw.request('/assets/old-123.js')).status, 404);
  await sw.request('/assets/old-123.js');
  assert.equal(sw.fetches.length, 2);
  assert.equal(sw.caches.stores.get('plimail-static-abc123').size, 0);
});

test('under the Vite dev server (no build id) nothing is cached', async () => {
  const sw = loadWorker({ buildId: null });
  assert.equal(await sw.request('/assets/index.js'), undefined);
});

test('a new release waits for the page, then drops the previous release\'s cache', async () => {
  const caches = fakeCaches({ 'plimail-static-old': [['x', 1]], 'plimail-static-abc123': [], 'someone-else': [] });
  const sw = loadWorker({ caches });
  await sw.lifecycle('install');
  assert.equal(sw.skipped, 0, 'no skipWaiting on install');
  await sw.lifecycle('message', { data: { type: 'SKIP_WAITING' } });
  assert.equal(sw.skipped, 1);
  await sw.lifecycle('activate');
  assert.deepEqual([...caches.stores.keys()].sort(), ['plimail-static-abc123', 'someone-else']);
  assert.equal(sw.claimed, 1);
});

test('installing fetches this release\'s page, bundle and fonts, skipping what fails', async () => {
  const sw = loadWorker({
    precache: ['/assets/index-A1.js', '/assets/gone-B2.js', '/fonts/inter/inter.woff2'],
    respond: ({ url }) => (url.endsWith('gone-B2.js') ? response('missing', { status: 404 }) : response('net:' + url)),
  });
  await sw.lifecycle('install');
  assert.deepEqual([...sw.caches.stores.get('plimail-static-abc123').keys()].sort(), [
    `${ORIGIN}/`, `${ORIGIN}/assets/index-A1.js`, `${ORIGIN}/fonts/inter/inter.woff2`,
  ]);
  assert.equal(sw.skipped, 0);
});

test('a page comes from the server whenever it answers, and the installed one only offline', async () => {
  let online = true;
  const sw = loadWorker({
    respond: ({ url }) => {
      if (!online) throw new TypeError('Failed to fetch');
      return response(url.endsWith('/') ? 'index of this release' : 'page from the server');
    },
  });
  await sw.lifecycle('install');
  assert.equal((await sw.request('/inbox', { mode: 'navigate' })).body, 'page from the server');
  online = false;
  assert.equal((await sw.request('/inbox', { mode: 'navigate' })).body, 'index of this release');
  assert.equal((await sw.request('/', { mode: 'navigate' })).body, 'index of this release');
  // Never in place of a protected message, sign-in or the API, even offline.
  for (const path of ['/s/AbC_123', '/oauth/callback', '/auth/oidc/callback', '/api/auth/me']) {
    assert.equal(await sw.request(path, { mode: 'navigate' }), undefined, path);
  }
});

test('offline with nothing installed, a page fails as it would without the worker', async () => {
  const sw = loadWorker({ respond: () => { throw new TypeError('Failed to fetch'); } });
  await assert.rejects(sw.request('/', { mode: 'navigate' }), TypeError);
});

test('under the Vite dev server pages are not touched either', async () => {
  const sw = loadWorker({ buildId: null });
  assert.equal(await sw.request('/', { mode: 'navigate' }), undefined);
});
