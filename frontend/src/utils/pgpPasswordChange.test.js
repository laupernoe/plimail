import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, unlockPrivateKey } from './pgp.js';
import { deriveKeySecret } from './pgpSecret.js';
import { keysForNewPassword } from './pgpPasswordChange.js';

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
