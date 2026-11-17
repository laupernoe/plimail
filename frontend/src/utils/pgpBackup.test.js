import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPair, loadOpenpgp, unlockPrivateKey } from './pgp.js';
import { buildKeyBackup, prepareKeysFromBackup, readPrivateKeyBlocks, storeRestoredKeys } from './pgpBackup.js';

const SECRET = 'v1.the-secret-derived-from-the-plimail-password';
const alice = await generateKeyPair({ name: 'Alice', email: 'alice@example.com', passphrase: SECRET });
const bob = await generateKeyPair({ name: 'Bob', email: 'bob@example.com', passphrase: SECRET });
const carol = await generateKeyPair({ email: 'carol@example.com', passphrase: 'carol own passphrase' });
const row = (pair, extra = {}) => ({
  id: `id-${pair.fingerprint.slice(0, 6)}`, fingerprint: pair.fingerprint, emails: [], armoredPublic: pair.armoredPublic,
  armoredPrivate: pair.armoredPrivate, protection: 'login', ...extra,
});
const rows = [row(alice), row(bob), row(carol, { protection: 'passphrase' })];
const open = k => unlockPrivateKey(k.armoredPrivate, SECRET);

test('a backup holds every key: the login ones under the chosen passphrase, the others as they are', async () => {
  const text = await buildKeyBackup(rows, { passphrase: 'backup passphrase', open });
  assert.equal(text.match(/-----BEGIN PGP PRIVATE KEY BLOCK-----/g).length, 3);
  const keys = await readPrivateKeyBlocks(text);
  assert.deepEqual(keys.map(k => k.getFingerprint()), [alice.fingerprint, bob.fingerprint, carol.fingerprint]);
  const openpgp = await loadOpenpgp();
  for (const k of keys.slice(0, 2)) {
    await openpgp.decryptKey({ privateKey: k, passphrase: 'backup passphrase' });
    await assert.rejects(openpgp.decryptKey({ privateKey: k, passphrase: SECRET }));
  }
  await openpgp.decryptKey({ privateKey: keys[2], passphrase: 'carol own passphrase' });
  // Nothing in the file is the secret the keys are stored under.
  assert.ok(!text.includes(SECRET));
  await assert.rejects(buildKeyBackup(rows, { passphrase: '', open }), { code: 'passphraseRequired' });
});

test('restoring reads every key of the file, not only the first, and protects them with the current secret', async () => {
  const text = await buildKeyBackup(rows.slice(0, 2), { passphrase: 'backup passphrase', open });
  const NEW = 'v1.the-secret-of-the-password-now';
  const { keys, unopened } = await prepareKeysFromBackup(text, { passphrase: 'backup passphrase', secret: NEW });
  assert.equal(unopened, 0);
  assert.deepEqual(keys.map(k => [k.fingerprint, k.protection, k.emails]), [
    [alice.fingerprint, 'login', ['alice@example.com']], [bob.fingerprint, 'login', ['bob@example.com']],
  ]);
  for (const k of keys) await unlockPrivateKey(k.armoredPrivate, NEW);
  await assert.rejects(prepareKeysFromBackup(text, { passphrase: 'wrong', secret: NEW }), { code: 'wrongPassphrase' });
  await assert.rejects(prepareKeysFromBackup('not a key', { passphrase: 'x', secret: NEW }), { code: 'invalidKey' });
});

test('a key with another passphrase is counted, and the ones that open still come in', async () => {
  const text = await buildKeyBackup(rows, { passphrase: 'backup passphrase', open });
  const first = await prepareKeysFromBackup(text, { passphrase: 'backup passphrase', secret: SECRET });
  assert.equal(first.keys.length, 2);
  assert.equal(first.unopened, 1);
  // Without the secret, a key keeps its own passphrase, as it was.
  const second = await prepareKeysFromBackup(text, { passphrase: 'carol own passphrase' });
  assert.deepEqual(second.keys.map(k => [k.fingerprint, k.protection]), [[carol.fingerprint, 'passphrase']]);
  await unlockPrivateKey(second.keys[0].armoredPrivate, 'carol own passphrase');
});

test('a key without any passphrase is never stored without one', async () => {
  const openpgp = await loadOpenpgp();
  const bare = (await openpgp.generateKey({ type: 'ecc', curve: 'curve25519Legacy', userIDs: [{ email: 'bare@example.com' }], format: 'object' })).privateKey.armor();
  await assert.rejects(prepareKeysFromBackup(bare, {}), { code: 'unprotectedKey' });
  const sealed = await prepareKeysFromBackup(bare, { newPassphrase: 'a new passphrase' });
  const stored = await (await loadOpenpgp()).readPrivateKey({ armoredKey: sealed.keys[0].armoredPrivate });
  assert.equal(stored.isDecrypted(), false);
  await unlockPrivateKey(sealed.keys[0].armoredPrivate, 'a new passphrase');
});

test('a key the user still has is replaced in one request; a key they do not have is added', async () => {
  const text = await buildKeyBackup(rows.slice(0, 2), { passphrase: 'backup passphrase', open });
  const { keys } = await prepareKeysFromBackup(text, { passphrase: 'backup passphrase', secret: SECRET });
  const calls = [];
  const result = await storeRestoredKeys(keys, {
    ownKeys: [{ ...rows[0], fingerprint: rows[0].fingerprint.toUpperCase(), stale: true }],
    setProtection: async updates => { calls.push(['protection', updates]); },
    addKey: async data => { calls.push(['add', data]); return { key: { id: 'new', ...data } }; },
    accountFor: emails => (emails.includes('bob@example.com') ? 'acc-bob' : null),
  });
  assert.deepEqual(result.restored, [rows[0].id]);
  assert.deepEqual(result.added.map(k => k.id), ['new']);
  assert.deepEqual(calls.map(c => c[0]), ['protection', 'add']);
  assert.deepEqual(calls[0][1].map(u => [u.id, u.protection]), [[rows[0].id, 'login']]);
  assert.equal(calls[1][1].accountId, 'acc-bob');
});

// The file must be what GnuPG imports. Run against the real one when it is installed.
const gpg = spawnSync('gpg', ['--version'], { encoding: 'utf8' });
test('GnuPG imports the backup, and its passphrase opens the keys there', { skip: gpg.status !== 0 && 'gpg is not installed' }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'plimail-gpg-'));
  const run = (args, input) => spawnSync('gpg', ['--homedir', home, '--batch', '--yes', '--pinentry-mode', 'loopback', ...args], { encoding: 'utf8', input });
  try {
    const file = join(home, 'backup.asc');
    writeFileSync(file, await buildKeyBackup(rows.slice(0, 2), { passphrase: 'backup passphrase', open }));
    const imported = run(['--import', file]);
    assert.equal(imported.status, 0, imported.stderr);
    assert.match(imported.stderr, /secret keys imported: 2/);
    const listed = run(['--with-colons', '--list-secret-keys']);
    for (const pair of [alice, bob]) assert.ok(listed.stdout.toUpperCase().includes(pair.fingerprint.toUpperCase()));
    // Signing needs the secret key opened, with the backup's passphrase and with nothing else.
    const signed = run(['--passphrase', 'backup passphrase', '-u', alice.fingerprint, '--clearsign'], 'hello\n');
    assert.equal(signed.status, 0, signed.stderr);
    // The agent would otherwise answer from the passphrase it just cached.
    spawnSync('gpgconf', ['--homedir', home, '--kill', 'gpg-agent']);
    const refused = run(['--passphrase', 'not it', '-u', bob.fingerprint, '--clearsign'], 'hello\n');
    assert.notEqual(refused.status, 0);
  } finally {
    spawnSync('gpgconf', ['--homedir', home, '--kill', 'gpg-agent']);
    rmSync(home, { recursive: true, force: true });
  }
});
