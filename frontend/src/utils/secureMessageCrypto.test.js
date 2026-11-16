import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import {
  PBKDF2_ITERATIONS, decodePayload, encodePayload, fromBase64, openMessage, openReply, passwordStrength,
  sealMessage, sealReply, toBase64, unlock,
} from './secureMessageCrypto.js';

// Fewer iterations than the default keep the suite fast; one test runs the real count.
const FAST = { iterations: 1000 };
const payload = () => ({
  subject: 'Contrat signé',
  html: '<p>Voici le <b>contrat</b>.</p>',
  text: 'Voici le contrat.',
  attachments: [
    { filename: 'contrat.pdf', mimeType: 'application/pdf', data: new Uint8Array([1, 2, 3, 4, 5]) },
    { filename: 'vide.txt', mimeType: 'text/plain', data: new Uint8Array(0) },
    { filename: 'photo.jpg', mimeType: 'image/jpeg', data: crypto.getRandomValues(new Uint8Array(60_000)) },
  ],
});

test('a sealed message opens with its password, attachments byte for byte', async () => {
  const original = payload();
  const sealed = await sealMessage('correct horse battery', original, FAST);
  assert.equal(fromBase64(sealed.salt).length, 32);
  assert.equal(fromBase64(sealed.iv).length, 12);
  assert.equal(sealed.iterations, 1000);
  const { encKey, authKeyHex } = await unlock('correct horse battery', sealed);
  // The server's check: SHA-256 of the authentication key is the verifier it was given.
  assert.equal(createHash('sha256').update(Buffer.from(authKeyHex, 'hex')).digest('hex'), sealed.authVerifier);
  const opened = await openMessage(encKey, sealed);
  assert.equal(opened.subject, original.subject);
  assert.equal(opened.html, original.html);
  assert.equal(opened.text, original.text);
  assert.deepEqual(opened.attachments.map(a => [a.filename, a.mimeType, [...a.data]]),
    original.attachments.map(a => [a.filename, a.mimeType, [...a.data]]));
});

test('the default cost is 600 000 iterations, and it still round-trips', async () => {
  assert.equal(PBKDF2_ITERATIONS, 600_000);
  const sealed = await sealMessage('pw-123456', { subject: 's', text: 't' });
  assert.equal(sealed.iterations, 600_000);
  const { encKey } = await unlock('pw-123456', sealed);
  assert.equal((await openMessage(encKey, sealed)).text, 't');
});

test('a wrong password gives another authentication key, and does not decrypt', async () => {
  const sealed = await sealMessage('right password', payload(), FAST);
  const right = await unlock('right password', sealed);
  const wrong = await unlock('wrong password', sealed);
  assert.notEqual(wrong.authKeyHex, right.authKeyHex);
  await assert.rejects(openMessage(wrong.encKey, sealed));
});

test('the encryption key and the authentication key are not the same bytes', async () => {
  const sealed = await sealMessage('pw', { text: 'x' }, FAST);
  const { authKeyHex } = await unlock('pw', sealed);
  // Encrypting with the authentication key as the AES key does not produce this ciphertext.
  const key = await crypto.subtle.importKey('raw', Buffer.from(authKeyHex, 'hex'), 'AES-GCM', false, ['decrypt']);
  await assert.rejects(crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(sealed.iv) }, key, fromBase64(sealed.ciphertext)));
});

test('a changed ciphertext or IV is refused, not decrypted into something else', async () => {
  const sealed = await sealMessage('pw', payload(), FAST);
  const { encKey } = await unlock('pw', sealed);
  const bytes = fromBase64(sealed.ciphertext);
  bytes[10] ^= 1;
  await assert.rejects(openMessage(encKey, { ...sealed, ciphertext: toBase64(bytes) }));
  const iv = fromBase64(sealed.iv);
  iv[0] ^= 1;
  await assert.rejects(openMessage(encKey, { ...sealed, iv: toBase64(iv) }));
});

test('two seals of the same message share no salt, IV or ciphertext', async () => {
  const a = await sealMessage('pw', { text: 'same' }, FAST);
  const b = await sealMessage('pw', { text: 'same' }, FAST);
  assert.notEqual(a.salt, b.salt);
  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.ciphertext, b.ciphertext);
});

test('a reply opens with the message key, under its own IV', async () => {
  const sealed = await sealMessage('pw', { text: 'hi' }, FAST);
  const { encKey } = await unlock('pw', sealed);
  const reply = await sealReply(encKey, 'Merci, reçu.');
  assert.notEqual(reply.iv, sealed.iv);
  assert.deepEqual(await openReply(encKey, { ciphertext: toBase64(reply.ciphertext), iv: reply.iv }), { text: 'Merci, reçu.' });
  const other = await unlock('other', sealed);
  await assert.rejects(openReply(other.encKey, { ciphertext: toBase64(reply.ciphertext), iv: reply.iv }));
});

test('the password is taken as Unicode text, whatever its normal form', async () => {
  const sealed = await sealMessage('café-secret', { text: 'x' }, FAST);
  const { encKey } = await unlock('café-secret', sealed);
  assert.equal((await openMessage(encKey, sealed)).text, 'x');
});

test('a payload whose sizes do not add up is refused', () => {
  const bytes = encodePayload({ text: 'x', attachments: [{ filename: 'a', data: new Uint8Array(10) }] });
  assert.throws(() => decodePayload(bytes.subarray(0, bytes.length - 1)));
  const wrongVersion = bytes.slice();
  wrongVersion[0] = 9;
  assert.throws(() => decodePayload(wrongVersion));
});

test('base64 handles more than a call stack of bytes', () => {
  const big = crypto.getRandomValues(new Uint8Array(65536)).slice();
  const large = new Uint8Array(1_000_000);
  for (let i = 0; i < large.length; i += big.length) large.set(big.subarray(0, Math.min(big.length, large.length - i)), i);
  assert.deepEqual(fromBase64(toBase64(large)), large);
  assert.equal(toBase64(large), Buffer.from(large).toString('base64'));
});

test('password strength', () => {
  assert.equal(passwordStrength('short'), 'tooShort');
  assert.equal(passwordStrength('abcdefgh'), 'weak');
  assert.equal(passwordStrength('abcdefghijkl'), 'fair');
  assert.equal(passwordStrength('Abcdefgh1234!xyz'), 'strong');
});
