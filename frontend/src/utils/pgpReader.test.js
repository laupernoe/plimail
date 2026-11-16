import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as openpgp from 'openpgp';
import { encryptMime, generateKeyPair, unlockPrivateKey } from './pgp.js';
import { buildMimeEntity, entityBytes } from './mimeBuild.js';
import { canonicalEntityBytes, parseMime } from './mimeParse.js';
import {
  analyzeRaw, decryptMessage, deliveryAddresses, findDecryptionKey, findDecryptionKeys, pgpVisibleAttachments, senderAuthenticated, verifySigned, withTrust,
} from './pgpReader.js';

const alice = await generateKeyPair({ email: 'alice@example.org', passphrase: 'a-pass-123' });
const bob = await generateKeyPair({ email: 'bob@example.net', passphrase: 'b-pass-123' });
const enc = new TextEncoder();
const own = [{ id: 'k1', fingerprint: bob.fingerprint, emails: ['bob@example.net'], armoredPublic: bob.armoredPublic, armoredPrivate: bob.armoredPrivate }];
const aliceAsSender = (verified) => [{ fingerprint: alice.fingerprint, armored: alice.armoredPublic, source: 'keyring', verified }];

// A PGP/MIME message as Thunderbird or Proton sends it (RFC 3156 section 4).
const pgpMime = (armored, extraHeaders = []) => enc.encode([
  'From: Alice <alice@example.org>', 'To: bob@example.net', 'Subject: ...', 'MIME-Version: 1.0', ...extraHeaders,
  'Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="enc"',
  '', 'This is an OpenPGP/MIME encrypted message (RFC 4880 and 3156)',
  '--enc', 'Content-Type: application/pgp-encrypted', 'Content-Description: PGP/MIME version identification', '', 'Version: 1', '',
  '--enc', 'Content-Type: application/octet-stream; name="encrypted.asc"', 'Content-Disposition: inline; filename="encrypted.asc"', '',
  armored.replace(/\n/g, '\r\n'), '--enc--', '',
].join('\r\n'));

test('reads a PGP/MIME message: finds the key, decrypts, verifies, shows the protected subject', async () => {
  const signingKey = await unlockPrivateKey(alice.armoredPrivate, 'a-pass-123');
  const entity = buildMimeEntity({
    html: '<p>Le code est 4521</p>', text: 'Le code est 4521',
    attachments: [{ filename: 'alice.asc', mimeType: 'application/pgp-keys', data: enc.encode(alice.armoredPublic) }],
    headers: { from: { email: 'alice@example.org' }, to: [{ email: 'bob@example.net' }], subject: 'Code du coffre' },
  });
  const armored = await encryptMime(entityBytes(entity), { recipientArmored: [bob.armoredPublic, alice.armoredPublic], signingKey });
  const analyzed = analyzeRaw(pgpMime(armored));
  assert.equal(analyzed.kind, 'encrypted');
  const row = await findDecryptionKey(analyzed.armored, own);
  assert.equal(row.id, 'k1');
  assert.equal(await findDecryptionKey(analyzed.armored, []), null);

  const decryptionKey = await unlockPrivateKey(bob.armoredPrivate, 'b-pass-123');
  const verified = await decryptMessage(analyzed, { decryptionKey, senderKeys: aliceAsSender(true) });
  assert.equal(verified.subject, 'Code du coffre');
  assert.equal(verified.html, '<p>Le code est 4521</p>');
  assert.equal(verified.signature.state, 'verified');
  assert.equal(verified.attachments[0].mimeType, 'application/pgp-keys');
  // A key the user has not verified yet: a good signature, said as such.
  assert.equal((await decryptMessage(analyzed, { decryptionKey, senderKeys: aliceAsSender(false) })).signature.state, 'good');
  // No key for the sender: unknown, never "verified".
  assert.equal((await decryptMessage(analyzed, { decryptionKey, senderKeys: [] })).signature.state, 'unknownKey');
});

test('reads sign-then-encrypt: a multipart/signed entity inside the encryption', async () => {
  const signingKey = await unlockPrivateKey(alice.armoredPrivate, 'a-pass-123');
  const inner = 'Content-Type: text/plain; charset=utf-8\r\n\r\nSigné puis chiffré\r\n';
  const innerNode = parseMime(enc.encode(inner.replace(/\r\n$/, '')));
  const sig = await openpgp.sign({ message: await openpgp.createMessage({ binary: canonicalEntityBytes(innerNode.source, innerNode) }), signingKeys: signingKey, detached: true });
  const signedEntity = [
    'Content-Type: multipart/signed; micalg=pgp-sha512; protocol="application/pgp-signature"; boundary="s"', '',
    '--s', inner.replace(/\r\n$/, ''), '--s', 'Content-Type: application/pgp-signature', '', sig.replace(/\n/g, '\r\n'), '--s--', '',
  ].join('\r\n');
  const armored = await encryptMime(enc.encode(signedEntity), { recipientArmored: [bob.armoredPublic] });
  const decryptionKey = await unlockPrivateKey(bob.armoredPrivate, 'b-pass-123');
  const out = await decryptMessage(analyzeRaw(pgpMime(armored)), { decryptionKey, senderKeys: aliceAsSender(false) });
  assert.equal(out.text, 'Signé puis chiffré');
  assert.equal(out.signature.state, 'good');
});

test('reads inline PGP and cleartext-signed text', async () => {
  const signingKey = await unlockPrivateKey(alice.armoredPrivate, 'a-pass-123');
  const armored = await openpgp.encrypt({ message: await openpgp.createMessage({ text: 'Inline secret' }), encryptionKeys: await openpgp.readKey({ armoredKey: bob.armoredPublic }) });
  const raw = enc.encode(`Content-Type: text/plain\r\n\r\n${armored.replace(/\n/g, '\r\n')}`);
  const analyzed = analyzeRaw(raw);
  assert.equal(analyzed.kind, 'inlineEncrypted');
  const decryptionKey = await unlockPrivateKey(bob.armoredPrivate, 'b-pass-123');
  const out = await decryptMessage(analyzed, { decryptionKey, senderKeys: [] });
  assert.equal(out.text, 'Inline secret');
  assert.equal(out.html, null);

  const clear = await openpgp.sign({ message: await openpgp.createCleartextMessage({ text: 'Je confirme.' }), signingKeys: signingKey });
  const signed = analyzeRaw(enc.encode(`Content-Type: text/plain\r\n\r\n${clear.replace(/\n/g, '\r\n')}`));
  assert.equal(signed.kind, 'inlineSigned');
  assert.equal((await verifySigned(signed, aliceAsSender(true))).state, 'verified');
});

test('verifies a multipart/signed message over the exact bytes of its first part', async () => {
  const signingKey = await unlockPrivateKey(alice.armoredPrivate, 'a-pass-123');
  const part = 'Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nJe signe =C3=A7a.\r\n';
  // The line break before the next delimiter is not part of what is signed (RFC 3156 5).
  const node = parseMime(enc.encode(part.replace(/\r\n$/, '')));
  const sig = await openpgp.sign({ message: await openpgp.createMessage({ binary: canonicalEntityBytes(node.source, node) }), signingKeys: signingKey, detached: true });
  const message = (body) => enc.encode([
    'From: alice@example.org', 'Autocrypt: addr=alice@example.org; keydata=AAAA',
    'Content-Type: multipart/signed; micalg=pgp-sha512; protocol="application/pgp-signature"; boundary="b"', '',
    '--b', body.replace(/\r\n$/, ''), '--b', 'Content-Type: application/pgp-signature; name="signature.asc"', '', sig.replace(/\n/g, '\r\n'), '--b--', '',
  ].join('\r\n'));
  const analyzed = analyzeRaw(message(part));
  assert.equal(analyzed.kind, 'signed');
  assert.equal(analyzed.autocrypt.addr, 'alice@example.org');
  assert.equal((await verifySigned(analyzed, aliceAsSender(false))).state, 'good');
  // One byte changed in the signed part.
  assert.equal((await verifySigned(analyzeRaw(message(part.replace('signe', 'signé'))), aliceAsSender(false))).state, 'bad');
});

test('withTrust never upgrades a bad or unknown signature', () => {
  assert.equal(withTrust({ state: 'bad', fingerprint: 'ab' }, [{ fingerprint: 'ab', verified: true }]).state, 'bad');
  assert.equal(withTrust({ state: 'unknownKey' }, [{ fingerprint: 'ab', verified: true }]).state, 'unknownKey');
  assert.equal(withTrust(null).state, 'none');
});

test('lists none of an encrypted message\'s parts as attachments, and a signed one without its signature', () => {
  const atts = [{ type: 'application/pdf', filename: 'a.pdf' }, { type: 'application/pgp-signature', filename: 'signature.asc' }];
  assert.deepEqual(pgpVisibleAttachments({ pgp: 'encrypted', attachments: atts }), []);
  assert.deepEqual(pgpVisibleAttachments({ pgp: 'signed', attachments: atts }), [atts[0]]);
  assert.deepEqual(pgpVisibleAttachments({ attachments: atts }), atts);
  assert.equal(analyzeRaw(enc.encode('Content-Type: text/plain\r\n\r\nNothing here\r\n')), null);
});

test('a signature over part of the message is not a signed message', async () => {
  const signingKey = await unlockPrivateKey(alice.armoredPrivate, 'a-pass-123');
  const clear = (await openpgp.sign({ message: await openpgp.createCleartextMessage({ text: 'Signed bit' }), signingKeys: signingKey })).replace(/\n/g, '\r\n');
  // Unsigned text around a signed block: the reader would show both under a "valid signature".
  const around = analyzeRaw(enc.encode(`Content-Type: text/plain\r\n\r\nUnsigned intro\r\n${clear}\r\nUnsigned footer\r\n`));
  assert.equal(around.kind, 'partlySigned');
  assert.equal((await verifySigned(around, aliceAsSender(true))).state, 'partial');
  // A multipart/signed under a multipart/mixed (a list footer added beside it).
  const mixed = enc.encode([
    'Content-Type: multipart/mixed; boundary="m"', '', '--m',
    'Content-Type: multipart/signed; protocol="application/pgp-signature"; micalg=pgp-sha512; boundary="s"', '',
    '--s', 'Content-Type: text/plain', '', 'signed', '--s', 'Content-Type: application/pgp-signature', '', 'x', '--s--',
    '--m', 'Content-Type: text/plain', '', 'Unsubscribe here', '--m--', '',
  ].join('\r\n'));
  assert.equal(analyzeRaw(mixed).kind, 'partlySigned');
  // A whole cleartext-signed body is still a signed message.
  assert.equal(analyzeRaw(enc.encode(`Content-Type: text/plain\r\n\r\n  ${clear}\r\n`)).kind, 'inlineSigned');
});

test('an armored block quoted or pasted in ordinary mail is not an encrypted message', async () => {
  const armored = await encryptMime(enc.encode('x'), { recipientArmored: [bob.armoredPublic] });
  assert.equal(analyzeRaw(enc.encode(`Content-Type: text/plain\r\n\r\nYou sent this:\r\n${armored}`)), null);
  const quoted = armored.split('\n').map(l => `> ${l}`).join('\r\n');
  assert.equal(analyzeRaw(enc.encode(`Content-Type: text/plain\r\n\r\n${quoted}`)), null);
});

test('with hidden recipients every key is a candidate, those for the delivery address first', async () => {
  const other = await generateKeyPair({ email: 'other@example.org', passphrase: 'o-pass-123' });
  const rows = [
    { id: 'o', fingerprint: other.fingerprint, emails: ['other@example.org'], armoredPublic: other.armoredPublic },
    ...own,
  ];
  const hidden = await encryptMime(enc.encode('x'), { recipientArmored: [bob.armoredPublic], hidden: true });
  const root = parseMime(enc.encode('To: someone@example.com\r\nDelivered-To: bob@example.net\r\n\r\nx'));
  const found = await findDecryptionKeys(hidden, rows, { preferEmails: deliveryAddresses(root) });
  assert.deepEqual(found.map(r => r.id), ['k1', 'o']);
  // A message that names its recipients is only for those.
  const named = await encryptMime(enc.encode('x'), { recipientArmored: [bob.armoredPublic] });
  assert.deepEqual((await findDecryptionKeys(named, rows)).map(r => r.id), ['k1']);
});

test('trusts the receiving server\'s authentication of From, only the topmost result', () => {
  const root = (...headers) => parseMime(enc.encode(`${headers.join('\r\n')}\r\n\r\nx`));
  assert.equal(senderAuthenticated(root('Authentication-Results: mx.example.com; dkim=pass header.d=example.org; dmarc=pass header.from=example.org'), 'a@example.org'), true);
  assert.equal(senderAuthenticated(root('Authentication-Results: mx.example.com; dkim=pass header.d=mail.example.org'), 'a@mail.example.org'), true);
  assert.equal(senderAuthenticated(root('Authentication-Results: mx.example.com; dkim=pass header.d=example.org'), 'a@sub.example.org'), true);
  // A DKIM pass for someone else's domain says nothing about From.
  assert.equal(senderAuthenticated(root('Authentication-Results: mx.example.com; dkim=pass header.d=attacker.example; dmarc=fail'), 'a@example.org'), false);
  assert.equal(senderAuthenticated(root('Authentication-Results: mx.example.com; dmarc=pass header.from=attacker.example'), 'a@example.org'), false);
  // A forged result further down (added by the sender) is not the one read.
  assert.equal(senderAuthenticated(root(
    'Authentication-Results: mx.example.com; dkim=none; dmarc=fail',
    'Authentication-Results: fake; dkim=pass header.d=example.org; dmarc=pass',
  ), 'a@example.org'), false);
  assert.equal(senderAuthenticated(root('Subject: x'), 'a@example.org'), false);
});

test('shows an encrypted message\'s parts as received when asked', () => {
  const atts = [{ type: 'application/octet-stream', filename: 'encrypted.asc' }];
  assert.deepEqual(pgpVisibleAttachments({ pgp: 'encrypted', attachments: atts }, { original: true }), atts);
});
