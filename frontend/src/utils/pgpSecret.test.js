import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// A sessionStorage for the tab, as the browser keeps one per tab across reloads.
const store = new Map();
globalThis.sessionStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k),
};

const secretModule = () => import(`./pgpSecret.js?${Math.random()}`);
const {
  KDF_ITERATIONS, STORAGE_KEY, deriveKeySecret, establishKeySecret, forgetKeySecret, keepKeySecretOnlyFor,
  keySecret, keySecretEntry, setKeySecret, waitForKeySecret,
} = await import('./pgpSecret.js');

const SALT = btoa(String.fromCharCode(...new Uint8Array(16).fill(7)));
const OTHER_SALT = btoa(String.fromCharCode(...new Uint8Array(16).fill(8)));
const fast = { iterations: 1000 };

beforeEach(() => {
  forgetKeySecret();
  store.clear();
});

test('derives the same passphrase from the same password and salt, and another from anything else', async () => {
  const a = await deriveKeySecret('correct horse', SALT, fast);
  assert.match(a, /^v1\.[A-Za-z0-9_-]{43}$/);
  assert.equal(await deriveKeySecret('correct horse', SALT, fast), a);
  assert.notEqual(await deriveKeySecret('correct horse!', SALT, fast), a);
  assert.notEqual(await deriveKeySecret('correct horse', OTHER_SALT, fast), a);
  assert.notEqual(await deriveKeySecret('correct horse', SALT, { iterations: 1001 }), a);
  // Not the password, nor anything a plain hash of it would give.
  assert.ok(!a.includes('correct'));
});

test('uses a work factor fit for a password, and refuses what cannot be a salt', async () => {
  assert.ok(KDF_ITERATIONS >= 600_000);
  const started = Date.now();
  const slow = await deriveKeySecret('pw', SALT);
  assert.notEqual(slow, await deriveKeySecret('pw', SALT, fast));
  assert.ok(Date.now() - started > 20, 'the real derivation takes real time');
  await assert.rejects(deriveKeySecret('pw', btoa('short'), fast), TypeError);
  await assert.rejects(deriveKeySecret('', SALT, fast), TypeError);
});

test('keeps the secret for the tab: a reload of the same tab finds it, for the same user only', async () => {
  setKeySecret('u1', 'v1.abc');
  assert.equal(keySecret('u1'), 'v1.abc');
  assert.equal(keySecret('u2'), null);
  // A reload: the module starts empty and reads the tab's storage.
  const reloaded = await secretModule();
  assert.equal(reloaded.keySecret('u1'), 'v1.abc');
  assert.equal(reloaded.keySecret('u2'), null);
  assert.equal(reloaded.keySecretEntry('u1').verified, true);
});

test('sign-out and the screen lock forget it; signing in as someone else does too', async () => {
  setKeySecret('u1', 'v1.abc');
  keepKeySecretOnlyFor('u1');
  assert.equal(keySecret('u1'), 'v1.abc', 'a reload by the same user keeps it');
  keepKeySecretOnlyFor('u2');
  assert.equal(keySecret('u1'), null);
  assert.equal(store.get(STORAGE_KEY), undefined);
  setKeySecret('u1', 'v1.abc');
  forgetKeySecret();
  assert.equal(keySecret('u1'), null);
  assert.equal((await secretModule()).keySecret('u1'), null);
});

test('derives at sign-in in the background, and whatever needs a key meanwhile waits for it', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const salts = [];
  const derived = establishKeySecret('u1', 'my password', {
    fetchSalt: async () => { salts.push(1); await gate; return { salt: SALT }; },
    derive: (pw, salt) => deriveKeySecret(pw, salt, fast),
  });
  assert.equal(keySecret('u1'), null);
  const waiting = waitForKeySecret('u1');
  release();
  const expected = await deriveKeySecret('my password', SALT, fast);
  assert.equal(await waiting, expected);
  assert.equal(await derived, expected);
  assert.equal(keySecretEntry('u1').verified, true);
  assert.equal(salts.length, 1);
  // The password itself is kept nowhere.
  assert.ok(![...store.values()].some(v => v.includes('my password')));
});

test('a sign-out while it derives leaves nothing behind', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const derived = establishKeySecret('u1', 'pw', { fetchSalt: async () => { await gate; return { salt: SALT }; }, derive: (pw, s) => deriveKeySecret(pw, s, fast) });
  forgetKeySecret();
  release();
  await derived;
  assert.equal(keySecret('u1'), null);
});

test('a password changed in another tab makes this one forget the old secret', async () => {
  const thisTab = await secretModule();
  const otherTab = await secretModule();
  thisTab.setKeySecret('u1', 'v1.old-password');
  assert.equal(thisTab.keySecret('u1'), 'v1.old-password');
  otherTab.announcePasswordChanged('u1');
  for (let i = 0; i < 50 && thisTab.keySecret('u1'); i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(thisTab.keySecret('u1'), null);
});
