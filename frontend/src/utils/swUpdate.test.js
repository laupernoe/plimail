import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startServiceWorker, isUpdateReady, applyUpdate, subscribeUpdateReady, resetSwUpdateForTest } from './swUpdate.js';

function emitter() {
  const listeners = {};
  return {
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    emit: (type) => { for (const fn of listeners[type] || []) fn(); },
  };
}

function fakeWorker(state = 'installing') {
  const w = { ...emitter(), state, messages: [], postMessage(m) { w.messages.push(m); } };
  return w;
}

function fakeContainer({ controller = null, waiting = null, fail = null } = {}) {
  const reg = { ...emitter(), waiting, installing: null, updates: 0, update: async () => { reg.updates++; } };
  const container = {
    ...emitter(),
    controller,
    registered: [],
    register: async (url, options) => {
      if (fail) throw fail;
      container.registered.push({ url, options });
      return reg;
    },
  };
  return { container, reg };
}

const silent = { warn() {} };

beforeEach(() => resetSwUpdateForTest());

test('registers /sw.js without the HTTP cache in the way', async () => {
  const { container } = fakeContainer();
  await startServiceWorker({ container, setIntervalFn: () => {}, logger: silent });
  assert.deepEqual(container.registered, [{ url: '/sw.js', options: { updateViaCache: 'none' } }]);
});

test('a failed registration (untrusted certificate, private window) is not an error for the app', async () => {
  const { container } = fakeContainer({ fail: new Error('SecurityError: SSL certificate error') });
  const warned = [];
  const reg = await startServiceWorker({ container, setIntervalFn: () => {}, logger: { warn: (...a) => warned.push(a) } });
  assert.equal(reg, null);
  assert.equal(warned.length, 1);
  assert.equal(isUpdateReady(), false);
  applyUpdate(); // nothing registered: does nothing, does not throw
  assert.equal(await startServiceWorker({ container: undefined }), null);
});

test('the first install is not an update', async () => {
  const { container, reg } = fakeContainer({ controller: null });
  await startServiceWorker({ container, setIntervalFn: () => {}, logger: silent });
  const w = fakeWorker();
  reg.installing = w;
  reg.emit('updatefound');
  w.state = 'installed';
  w.emit('statechange');
  assert.equal(isUpdateReady(), false);
});

test('a new release that installs under the current one shows the banner; the button switches and reloads', async () => {
  const { container, reg } = fakeContainer({ controller: {} });
  let reloads = 0;
  let notified = 0;
  subscribeUpdateReady(() => { notified++; });
  await startServiceWorker({ container, reload: () => { reloads++; }, setIntervalFn: () => {}, logger: silent });
  const w = fakeWorker();
  reg.installing = w;
  reg.emit('updatefound');
  w.state = 'installed';
  reg.waiting = w;
  w.emit('statechange');
  assert.equal(isUpdateReady(), true);
  assert.equal(notified, 1);

  applyUpdate();
  assert.deepEqual(w.messages, [{ type: 'SKIP_WAITING' }]);
  assert.equal(reloads, 0, 'waits for the new worker to take over');
  container.emit('controllerchange');
  assert.equal(reloads, 1);
});

test('a release already waiting at startup shows the banner at once', async () => {
  const { container } = fakeContainer({ controller: {}, waiting: fakeWorker('installed') });
  await startServiceWorker({ container, setIntervalFn: () => {}, logger: silent });
  assert.equal(isUpdateReady(), true);
});

test('another tab switching to the new release shows the banner here, whose button just reloads', async () => {
  const { container } = fakeContainer({ controller: {} });
  let reloads = 0;
  await startServiceWorker({ container, reload: () => { reloads++; }, setIntervalFn: () => {}, logger: silent });
  container.emit('controllerchange');
  assert.equal(isUpdateReady(), true);
  assert.equal(reloads, 0);
  applyUpdate();
  assert.equal(reloads, 1);
});

test('a long-open window still asks for a new sw.js now and then', async () => {
  const { container, reg } = fakeContainer({ controller: {} });
  let tick;
  let every;
  await startServiceWorker({ container, setIntervalFn: (fn, ms) => { tick = fn; every = ms; }, logger: silent });
  assert.ok(every <= 60 * 60 * 1000);
  tick();
  assert.equal(reg.updates, 1);
});
