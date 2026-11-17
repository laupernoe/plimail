import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, unlockPrivateKey } from './pgp.js';
import { deriveKeySecret } from './pgpSecret.js';
import { keysForNewPassword, planOwnPasswordChange } from './pgpPasswordChange.js';

const SALT = btoa(String.fromCharCode(...new Uint8Array(16).fill(5)));
const derive = (pw, salt) => deriveKeySecret(pw, salt, { iterations: 1000 });
const OLD = await derive('old password', SALT);
const pair = await generateKeyPair({ email: 'admin@example.com', passphrase: OLD });
const key = { id: 'k1', fingerprint: pair.fingerprint, emails: ['admin@example.com'], armoredPublic: pair.armoredPublic, armoredPrivate: pair.armoredPrivate, protection: 'login' };
const fetchSalt = async () => ({ salt: SALT });

test('a password change re-encrypts the keys for the new password, to send with it', async () => {
  const { pgpKeys, secret } = await keysForNewPassword({
    newPassword: 'new password', loadKeys: async () => [key], fetchSalt, currentSecret: async () => OLD, derive,
  });
  assert.equal(secret, await derive('new password', SALT));
  assert.deepEqual(pgpKeys.map(k => [k.id, k.protection]), [['k1', 'login']]);
  // The new secret opens the key; the old one no longer does.
  await unlockPrivateKey(pgpKeys[0].armoredPrivate, secret);
  await assert.rejects(unlockPrivateKey(pgpKeys[0].armoredPrivate, OLD), { code: 'wrongPassphrase' });
  // Nothing in what goes to the server is the password or a secret.
  const sent = JSON.stringify(pgpKeys);
  assert.ok(!sent.includes('new password') && !sent.includes(secret) && !sent.includes(OLD));
});

test('a key the old secret does not open stops the change, before anything is sent', async () => {
  const other = await generateKeyPair({ email: 'x@example.com', passphrase: 'unrelated' });
  await assert.rejects(keysForNewPassword({
    newPassword: 'new password', fetchSalt, derive, currentSecret: async () => OLD,
    loadKeys: async () => [key, { ...key, id: 'k2', armoredPrivate: other.armoredPrivate }],
  }), { code: 'wrongPassphrase' });
  // Cancelling the unlock prompt stops it too.
  await assert.rejects(keysForNewPassword({ newPassword: 'n', loadKeys: async () => [key], fetchSalt, derive, currentSecret: async () => null }), { code: 'unlockCancelled' });
});

test('without keys protected by the password, nothing is sent and nothing is asked', async () => {
  let asked = false;
  const own = { ...key, protection: 'passphrase' };
  const result = await keysForNewPassword({
    newPassword: 'n', loadKeys: async () => [own], fetchSalt, derive, currentSecret: async () => { asked = true; return OLD; },
  });
  assert.equal(result.pgpKeys, undefined);
  assert.equal(asked, false);
});

test('a key another tab made while re-encrypting is not left behind: it starts over with it', async () => {
  const newer = await generateKeyPair({ email: 'alias@example.com', passphrase: OLD });
  const second = { ...key, id: 'k2', fingerprint: newer.fingerprint, armoredPublic: newer.armoredPublic, armoredPrivate: newer.armoredPrivate };
  let reads = 0;
  // First read: one key; from the second on, the other tab's key is there too.
  const loadKeys = async () => { reads += 1; return reads === 1 ? [key] : [key, second]; };
  const { pgpKeys } = await keysForNewPassword({ newPassword: 'new password', loadKeys, fetchSalt, derive, currentSecret: async () => OLD });
  assert.deepEqual(pgpKeys.map(k => k.id), ['k1', 'k2']);
  // A stale key (an even older password's) neither blocks the change nor is sent.
  const stale = { ...second, stale: true, armoredPrivate: (await generateKeyPair({ email: 'z@example.com', passphrase: 'older' })).armoredPrivate };
  const result = await keysForNewPassword({ newPassword: 'n', loadKeys: async () => [key, stale], fetchSalt, derive, currentSecret: async () => OLD });
  assert.deepEqual(result.pgpKeys.map(k => k.id), ['k1']);
});

test('changing one\'s own password derives the old secret from the current password and moves every key it opens', async () => {
  const NEW = await derive('new password', SALT);
  const moved = { ...key, id: 'k3', armoredPrivate: (await generateKeyPair({ email: 'moved@example.com', passphrase: NEW })).armoredPrivate };
  const { pgpKeys, secret, unopened } = await planOwnPasswordChange({
    currentPassword: 'old password', newPassword: 'new password', loadKeys: async () => [key, moved], fetchSalt, derive,
  });
  assert.equal(secret, NEW);
  // An interrupted change run again: the key already under the new password is not sent again.
  assert.deepEqual(pgpKeys.map(k => k.id), ['k1']);
  assert.deepEqual(unopened, []);
  await unlockPrivateKey(pgpKeys[0].armoredPrivate, NEW);
});

test('a key the current password does not open is reported and left out, and the others still move', async () => {
  const older = await generateKeyPair({ email: 'old@example.com', passphrase: await derive('an earlier password', SALT) });
  const left = { ...key, id: 'k2', fingerprint: older.fingerprint, armoredPrivate: older.armoredPrivate, stale: true };
  const own = { ...key, id: 'k4', protection: 'passphrase' };
  const { pgpKeys, unopened } = await planOwnPasswordChange({
    currentPassword: 'old password', newPassword: 'new password', loadKeys: async () => [key, left, own], fetchSalt, derive,
  });
  assert.deepEqual(pgpKeys.map(k => k.id), ['k1']);
  assert.deepEqual(unopened.map(k => k.id), ['k2']);
  // With no key that opens, nothing is sent at all.
  const none = await planOwnPasswordChange({ currentPassword: 'old password', newPassword: 'n', loadKeys: async () => [left], fetchSalt, derive });
  assert.equal(none.pgpKeys, undefined);
  assert.deepEqual(none.unopened.map(k => k.id), ['k2']);
});

test('a key made by another tab during one\'s own change is not left behind', async () => {
  const newer = await generateKeyPair({ email: 'alias@example.com', passphrase: OLD });
  const second = { ...key, id: 'k2', fingerprint: newer.fingerprint, armoredPrivate: newer.armoredPrivate };
  let reads = 0;
  const loadKeys = async () => { reads += 1; return reads === 1 ? [key] : [key, second]; };
  const { pgpKeys } = await planOwnPasswordChange({ currentPassword: 'old password', newPassword: 'new password', loadKeys, fetchSalt, derive });
  assert.deepEqual(pgpKeys.map(k => k.id), ['k1', 'k2']);
});
