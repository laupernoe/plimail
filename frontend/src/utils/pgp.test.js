import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as openpgp from 'openpgp';
import {
  PgpError, decryptArmored, encryptMime, encryptionKeyIds, generateKeyPair, keyInfo, keyMatches, preparePrivateKeyImport,
  readArmoredKeys, unlockPrivateKey, verifyCleartext, verifyDetached,
} from './pgp.js';
import { buildMimeEntity, entityBytes } from './mimeBuild.js';
import { canonicalEntityBytes, extractContent, parseMime } from './mimeParse.js';

const alice = await generateKeyPair({ name: 'Alice', email: 'alice@example.org', passphrase: 'alice pass' });
const bob = await generateKeyPair({ email: 'bob@example.net', passphrase: 'bob pass' });
const eve = await generateKeyPair({ email: 'eve@example.com', passphrase: 'eve pass' });

test('generates a passphrase-protected curve25519 key for the address', async () => {
  const key = await openpgp.readPrivateKey({ armoredKey: alice.armoredPrivate });
  assert.equal(key.isDecrypted(), false);
  const info = await keyInfo(key);
  assert.deepEqual(info.emails, ['alice@example.org']);
  assert.equal(info.canEncrypt, true);
  assert.equal(key.getAlgorithmInfo().algorithm, 'eddsaLegacy');
  await assert.rejects(generateKeyPair({ email: 'x@example.org', passphrase: '' }), e => e.code === 'passphraseRequired');
});

test('unlocks only with the right passphrase', async () => {
  await assert.rejects(unlockPrivateKey(alice.armoredPrivate, 'wrong'), e => e instanceof PgpError && e.code === 'wrongPassphrase');
  const key = await unlockPrivateKey(alice.armoredPrivate, 'alice pass');
  assert.equal(key.isDecrypted(), true);
});

test('imports a protected key after checking its passphrase, and protects an unprotected one', async () => {
  await assert.rejects(preparePrivateKeyImport(bob.armoredPrivate, 'nope'), e => e.code === 'wrongPassphrase');
  const ok = await preparePrivateKeyImport(bob.armoredPrivate, 'bob pass');
  assert.equal(ok.fingerprint, bob.fingerprint);

  const { privateKey: bare } = await openpgp.generateKey({ type: 'curve25519', userIDs: [{ email: 'c@example.org' }], format: 'armored' });
  await assert.rejects(preparePrivateKeyImport(bare, ''), e => e.code === 'unprotectedKey');
  const sealed = await preparePrivateKeyImport(bare, '', 'new pass');
  const stored = await openpgp.readPrivateKey({ armoredKey: sealed.armoredPrivate });
  // What goes to the server is encrypted, whatever came in.
  assert.equal(stored.isDecrypted(), false);
  await unlockPrivateKey(sealed.armoredPrivate, 'new pass');
  await assert.rejects(preparePrivateKeyImport('not a key', 'x'), e => e.code === 'invalidKey');
});

test('encrypts a MIME entity to the recipients and the sender, signed, and reads it back', async () => {
  const signingKey = await unlockPrivateKey(alice.armoredPrivate, 'alice pass');
  const entity = buildMimeEntity({
    html: '<p>Rendez-vous à 10 h</p>', text: 'Rendez-vous à 10 h',
    attachments: [{ filename: 'plan.txt', mimeType: 'text/plain', data: new TextEncoder().encode('étage 3') }],
    headers: { from: { email: 'alice@example.org' }, to: [{ email: 'bob@example.net' }], subject: 'Secret' },
  });
  const armored = await encryptMime(entityBytes(entity), { recipientArmored: [bob.armoredPublic, alice.armoredPublic], signingKey });
  assert.match(armored, /^-----BEGIN PGP MESSAGE-----/);

  const ids = await encryptionKeyIds(armored);
  const [bobKey] = await readArmoredKeys(bob.armoredPublic);
  const [eveKey] = await readArmoredKeys(eve.armoredPublic);
  assert.equal(keyMatches(bobKey, ids), true);
  assert.equal(keyMatches(eveKey, ids), false);

  // Bob reads it, and Alice's Sent copy too.
  for (const [armoredPrivate, pass] of [[bob.armoredPrivate, 'bob pass'], [alice.armoredPrivate, 'alice pass']]) {
    const decryptionKey = await unlockPrivateKey(armoredPrivate, pass);
    const { data, signature } = await decryptArmored(armored, { decryptionKey, verificationArmored: [alice.armoredPublic] });
    assert.equal(signature.state, 'good');
    assert.equal(signature.fingerprint, alice.fingerprint);
    const content = extractContent(parseMime(data));
    assert.equal(content.subject, 'Secret');
    assert.equal(content.html, '<p>Rendez-vous à 10 h</p>');
    assert.equal(new TextDecoder().decode(content.attachments[0].data), 'étage 3');
  }

  // Eve cannot.
  const eveKeyUnlocked = await unlockPrivateKey(eve.armoredPrivate, 'eve pass');
  await assert.rejects(decryptArmored(armored, { decryptionKey: eveKeyUnlocked }), e => e.code === 'decryptFailed');
});

test('tells an unknown signer and a wrong signer apart from a good signature', async () => {
  const signingKey = await unlockPrivateKey(eve.armoredPrivate, 'eve pass');
  const armored = await encryptMime(new TextEncoder().encode('hi'), { recipientArmored: [bob.armoredPublic], signingKey });
  const decryptionKey = await unlockPrivateKey(bob.armoredPrivate, 'bob pass');
  // Signed by Eve, checked against Alice's key: not Alice's signature, and not a forgery either.
  assert.equal((await decryptArmored(armored, { decryptionKey, verificationArmored: [alice.armoredPublic] })).signature.state, 'unknownKey');
  assert.equal((await decryptArmored(armored, { decryptionKey })).signature.state, 'unknownKey');
  // Unsigned.
  const plain = await encryptMime(new TextEncoder().encode('hi'), { recipientArmored: [bob.armoredPublic] });
  assert.equal((await decryptArmored(plain, { decryptionKey })).signature.state, 'none');
});

test('verifies a detached signature over the signed part and refuses a tampered one', async () => {
  const signingKey = await unlockPrivateKey(alice.armoredPrivate, 'alice pass');
  const part = 'Content-Type: text/plain; charset=utf-8\n\nSigné\n';
  const raw = (body) => [
    'Content-Type: multipart/signed; boundary="sig"; protocol="application/pgp-signature"; micalg=pgp-sha512',
    '', '--sig', body, '--sig', 'Content-Type: application/pgp-signature', '', '%SIG%', '--sig--', '',
  ].join('\r\n');
  const root = parseMime(new TextEncoder().encode(raw(part.replace(/\n/g, '\r\n'))));
  const signed = canonicalEntityBytes(root.source, root.children[0]);
  const signature = await openpgp.sign({
    message: await openpgp.createMessage({ binary: signed }), signingKeys: signingKey, detached: true, format: 'armored',
  });
  assert.equal((await verifyDetached(signed, signature, [alice.armoredPublic])).state, 'good');
  const tampered = canonicalEntityBytes(...((r) => [r.source, r.children[0]])(parseMime(new TextEncoder().encode(raw('Content-Type: text/plain\r\n\r\nSigne\r\n')))));
  assert.equal((await verifyDetached(tampered, signature, [alice.armoredPublic])).state, 'bad');
  assert.equal((await verifyDetached(signed, signature, [])).state, 'unknownKey');
  assert.equal((await verifyDetached(signed, 'garbage', [alice.armoredPublic])).state, 'bad');
});

test('verifies inline cleartext signatures', async () => {
  const signingKey = await unlockPrivateKey(alice.armoredPrivate, 'alice pass');
  const cleartext = await openpgp.sign({ message: await openpgp.createCleartextMessage({ text: 'Bonjour' }), signingKeys: signingKey });
  const ok = await verifyCleartext(cleartext, [alice.armoredPublic]);
  assert.equal(ok.text, 'Bonjour');
  assert.equal(ok.signature.state, 'good');
  const forged = cleartext.replace('Bonjour', 'Bonsoir');
  assert.equal((await verifyCleartext(forged, [alice.armoredPublic])).signature.state, 'bad');
});
