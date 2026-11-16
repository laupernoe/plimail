import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { decryptArmored, encryptMime, generateKeyPair, unlockPrivateKey } from './pgp.js';
import { deriveKeySecret } from './pgpSecret.js';
import { ensureAutoKeys, forgetAutoKeyState, isLoginKey, lockKey, openOwnKey, rewrapLoginKeys } from './pgpKeys.js';
import { forgetAllUnlockedKeys, isUnlocked } from './pgpSession.js';

const SALT = btoa(String.fromCharCode(...new Uint8Array(16).fill(3)));
const fast = { iterations: 1000 };
const OLD = await deriveKeySecret('old Plimail password', SALT, fast);
const NEW = await deriveKeySecret('new Plimail password', SALT, fast);

const made = await generateKeyPair({ email: 'me@example.com', passphrase: OLD });
const row = (pair, extra = {}) => ({
  id: extra.id || 'k1', fingerprint: pair.fingerprint, emails: ['me@example.com'],
  armoredPublic: pair.armoredPublic, armoredPrivate: pair.armoredPrivate, protection: 'login', ...extra,
});

beforeEach(() => {
  forgetAllUnlockedKeys();
  forgetAutoKeyState();
});

async function readable(pair, key) {
  const message = await encryptMime(new TextEncoder().encode('hello'), { recipientArmored: [pair.armoredPublic] });
  const { data } = await decryptArmored(message, { decryptionKey: key });
  return new TextDecoder().decode(data);
}

test('a key wrapped with the derived passphrase unwraps with it, and with nothing else', async () => {
  assert.ok(made.armoredPrivate.includes('PRIVATE KEY'));
  const key = await openOwnKey(row(made), { secret: OLD });
  assert.equal(await readable(made, key), 'hello');
  assert.ok(isUnlocked(made.fingerprint), 'kept for the tab');
  forgetAllUnlockedKeys();
  await assert.rejects(openOwnKey(row(made), { secret: NEW }), { code: 'staleSecret' });
  await assert.rejects(openOwnKey(row(made), { secret: NEW, verified: false }), { code: 'wrongPassphrase' });
  await assert.rejects(openOwnKey(row(made), {}), { code: 'needsSecret' });
  // Wrapping again with another passphrase gives a key that only that one opens.
  const relocked = await lockKey(key, NEW);
  await unlockPrivateKey(relocked, NEW);
  await assert.rejects(unlockPrivateKey(relocked, OLD), { code: 'wrongPassphrase' });
});

test('a key with its own passphrase still asks for it', async () => {
  const own = await generateKeyPair({ email: 'own@example.com', passphrase: 'my own passphrase' });
  const r = row(own, { protection: 'passphrase' });
  assert.equal(isLoginKey(r), false);
  await assert.rejects(openOwnKey(r, { secret: OLD }), { code: 'needsPassphrase' });
  assert.ok(await openOwnKey(r, { passphrase: 'my own passphrase' }));
});

test('a password change wraps every login key for the new password, and they still read their mail', async () => {
  const second = await generateKeyPair({ email: 'alias@example.com', passphrase: OLD });
  const own = await generateKeyPair({ email: 'own@example.com', passphrase: 'kept' });
  const rows = [row(made), row(second, { id: 'k2' }), row(own, { id: 'k3', protection: 'passphrase' })];
  const updates = await rewrapLoginKeys(rows, { from: OLD, to: NEW });
  assert.deepEqual(updates.map(u => [u.id, u.protection]), [['k1', 'login'], ['k2', 'login']], 'its own passphrase\'s key is left alone');
  const reopened = await unlockPrivateKey(updates[0].armoredPrivate, NEW);
  assert.equal(await readable(made, reopened), 'hello');
  await assert.rejects(unlockPrivateKey(updates[0].armoredPrivate, OLD), { code: 'wrongPassphrase' });
  // Run again over keys already moved: nothing more to change.
  assert.deepEqual(await rewrapLoginKeys([{ ...rows[0], armoredPrivate: updates[0].armoredPrivate }], { from: OLD, to: NEW }), []);
});

test('a re-wrap that cannot open every key changes none, so no key is lost', async () => {
  const strange = await generateKeyPair({ email: 'x@example.com', passphrase: 'another password entirely' });
  const rows = [row(made), row(strange, { id: 'k2' })];
  const sent = [];
  const save = async (updates) => { sent.push(updates); };
  await assert.rejects(async () => save(await rewrapLoginKeys(rows, { from: OLD, to: NEW })), { code: 'wrongPassphrase' });
  assert.equal(sent.length, 0, 'the server was asked to change nothing');
  // The first key, stored as before, still opens with the old password.
  assert.ok(await unlockPrivateKey(rows[0].armoredPrivate, OLD));
  await assert.rejects(rewrapLoginKeys(rows, { from: OLD, to: null }), { code: 'passphraseRequired' });
});

test('makes one key per address, however many times it runs at once', async () => {
  let generated = 0;
  const stored = [];
  const generate = async ({ email, passphrase }) => {
    generated += 1;
    await new Promise(r => setTimeout(r, 10));
    return { armoredPrivate: `priv:${email}:${passphrase}`, armoredPublic: `pub:${email}`, fingerprint: email };
  };
  const addKey = async (body) => { stored.push(body); return { key: { id: String(stored.length), emails: [body.armoredPublic.slice(4)] } }; };
  const addresses = [{ email: 'Me@Example.com', name: 'Me', accountId: 'a1' }, { email: 'alias@example.com', accountId: 'a1' }];
  const args = { userId: 'u1', addresses, ownKeys: [], secret: NEW, addKey, generate };
  // Two renders, two components: all at once.
  const results = await Promise.all([ensureAutoKeys(args), ensureAutoKeys(args), ensureAutoKeys(args)]);
  assert.equal(generated, 2);
  assert.equal(stored.length, 2);
  assert.deepEqual(stored.map(s => [s.protection, s.auto, s.accountId]), [['login', true, 'a1'], ['login', true, 'a1']]);
  assert.ok(stored.every(s => s.armoredPrivate.endsWith(NEW)), 'protected by the derived secret');
  assert.ok(results.every(r => r.changed));
  // Later calls in this tab make nothing more.
  assert.deepEqual(await ensureAutoKeys(args), { created: [], changed: false });
  assert.equal(generated, 2);
});

test('makes none for an address that has a key, nor without the secret, and counts another tab\'s as done', async () => {
  let generated = 0;
  const generate = async ({ email }) => { generated += 1; return { armoredPrivate: 'p', armoredPublic: 'q', fingerprint: email }; };
  const addresses = [{ email: 'me@example.com' }, { email: 'taken@example.com' }];
  assert.deepEqual(await ensureAutoKeys({ userId: 'u1', addresses, ownKeys: [], secret: null, addKey: async () => ({}), generate }), { created: [], changed: false });
  const refused = Object.assign(new Error('exists'), { status: 409 });
  const result = await ensureAutoKeys({
    userId: 'u1', addresses, ownKeys: [{ emails: ['me@example.com'] }], secret: NEW, generate,
    addKey: async () => { throw refused; },
  });
  assert.equal(generated, 1, 'only the address without a key');
  assert.deepEqual(result, { created: [], changed: true });
});

test('an address that failed (offline) is tried again next time', async () => {
  let attempts = 0;
  const args = {
    userId: 'u1', addresses: [{ email: 'me@example.com' }], ownKeys: [], secret: NEW,
    generate: async () => ({ armoredPrivate: 'p', armoredPublic: 'q', fingerprint: 'f' }),
    addKey: async () => { attempts += 1; if (attempts === 1) throw new Error('offline'); return { key: { id: 'k' } }; },
  };
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.deepEqual(await ensureAutoKeys(args), { created: [], changed: false });
    assert.deepEqual(await ensureAutoKeys(args), { created: [{ id: 'k' }], changed: true });
  } finally { console.warn = warn; }
});
