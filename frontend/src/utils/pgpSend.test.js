import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as openpgp from 'openpgp';
import { decryptArmored, generateKeyPair, unlockPrivateKey } from './pgp.js';
import { extractContent, parseMime } from './mimeParse.js';
import { PgpSendError, classifyRecipients, emailOfRecipient, encryptedSendPayload, ownKeyFor, pgpSendProblem } from './pgpSend.js';

const me = await generateKeyPair({ email: 'me@example.com', passphrase: 'me-pass-123' });
const bob = await generateKeyPair({ email: 'bob@example.net', passphrase: 'bob-pass-123' });
const ownKey = { id: 'k', fingerprint: me.fingerprint, emails: ['me@example.com'], armoredPublic: me.armoredPublic, armoredPrivate: me.armoredPrivate };
const { publicKey: expired } = await openpgp.generateKey({
  type: 'ecc', curve: 'curve25519Legacy', userIDs: [{ email: 'old@example.org' }], keyExpirationTime: 1,
  date: new Date(Date.now() - 86_400_000), format: 'armored',
});

const lookup = {
  'bob@example.net': { source: 'keyring', keys: [{ fingerprint: bob.fingerprint, armored: bob.armoredPublic, source: 'manual', verified: true }] },
  'old@example.org': { source: 'keyring', keys: [{ fingerprint: 'x', armored: expired, source: 'manual', verified: false }] },
  'nobody@example.org': { source: null, keys: [] },
  'flaky@example.org': { source: null, keys: [], error: true },
};

test('reads addresses out of composer chips', () => {
  assert.equal(emailOfRecipient('Bob <Bob@Example.net>'), 'bob@example.net');
  assert.equal(emailOfRecipient(' carol@example.org '), 'carol@example.org');
});

test('classifies each recipient\'s key: usable, missing, expired, failed lookup', async () => {
  const statuses = await classifyRecipients(['bob@example.net', 'old@example.org', 'nobody@example.org', 'flaky@example.org', 'unasked@example.org'], lookup);
  assert.deepEqual(statuses.map(s => [s.email, s.status]), [
    ['bob@example.net', 'ok'], ['old@example.org', 'invalid'], ['nobody@example.org', 'missing'],
    ['flaky@example.org', 'error'], ['unasked@example.org', 'error'],
  ]);
  assert.equal(statuses[0].verified, true);
});

test('blocks the send while any recipient lacks a usable key', async () => {
  const statuses = await classifyRecipients(['bob@example.net', 'nobody@example.org'], lookup);
  assert.deepEqual(pgpSendProblem({ recipients: ['bob@example.net', 'nobody@example.org'], statuses, ownKey }), { code: 'missingKeys', emails: ['nobody@example.org'] });
  assert.equal(pgpSendProblem({ recipients: ['bob@example.net'], statuses, ownKey }), null);
  // Not looked up yet: wait, do not guess.
  assert.deepEqual(pgpSendProblem({ recipients: ['bob@example.net', 'new@example.org'], statuses, ownKey }), { code: 'checking' });
  // Without a key of their own, the sender could not read their Sent copy.
  assert.deepEqual(pgpSendProblem({ recipients: ['bob@example.net'], statuses, ownKey: null }), { code: 'noOwnKey' });
  assert.deepEqual(pgpSendProblem({ recipients: ['bob@example.net'], statuses, ownKey, sign: true, signingReady: false }), { code: 'passphrase' });
  assert.equal(ownKeyFor([ownKey], 'ME@example.com'), ownKey);
  assert.equal(ownKeyFor([ownKey], 'other@example.com'), null);
});

test('builds a send body with only ciphertext, readable by the recipient and the sender, signed', async () => {
  const statuses = await classifyRecipients(['bob@example.net'], lookup);
  const signingKey = await unlockPrivateKey(me.armoredPrivate, 'me-pass-123');
  const payload = {
    accountId: 'a1', to: ['Bob <bob@example.net>'], cc: [], bcc: [], subject: 'Plan', body: '<p>Le plan secret</p>', bodyIsHtml: true,
    editedSignature: '<b>Moi</b>', quotedBodyHtml: '<blockquote>avant</blockquote>', inReplyTo: '<x@y>',
    attachments: [{ filename: 'plan.txt', content: 'cGxhbg==' }],
  };
  const body = await encryptedSendPayload({
    payload, attachments: [{ name: 'plan.txt', type: 'text/plain', data: btoa('plan B') }],
    statuses, ownKey, signingKey, fromName: 'Me', fromEmail: 'me@example.com',
  });
  assert.deepEqual(Object.keys(body).sort(), ['accountId', 'bcc', 'body', 'cc', 'editedSignature', 'inReplyTo', 'pgp', 'subject', 'to']);
  assert.equal(body.body, '');
  assert.equal(body.editedSignature, '');
  const json = JSON.stringify(body);
  for (const secret of ['Le plan secret', 'Moi', 'avant', 'plan B', 'cGxhbg==']) assert.ok(!json.includes(secret), secret);

  for (const [armoredPrivate, pass] of [[bob.armoredPrivate, 'bob-pass-123'], [me.armoredPrivate, 'me-pass-123']]) {
    const decryptionKey = await unlockPrivateKey(armoredPrivate, pass);
    const { data, signature } = await decryptArmored(body.pgp.encrypted, { decryptionKey, verificationArmored: [me.armoredPublic] });
    assert.equal(signature.state, 'good');
    const content = extractContent(parseMime(data));
    assert.match(content.html, /Le plan secret.*Moi.*avant/s);
    assert.equal(content.subject, 'Plan');
    assert.equal(new TextDecoder().decode(content.attachments[0].data), 'plan B');
  }
});

test('never encrypts past a recipient without a key, forwarded parts or the size limit', async () => {
  const statuses = await classifyRecipients(['bob@example.net', 'nobody@example.org'], lookup);
  let encrypted = false;
  const encrypt = async () => { encrypted = true; return 'x'; };
  const base = { payload: { to: ['bob@example.net'], cc: ['nobody@example.org'], bcc: [], subject: '', body: 'hi' }, statuses, ownKey, fromEmail: 'me@example.com', encrypt };
  await assert.rejects(encryptedSendPayload(base), e => e instanceof PgpSendError && e.code === 'missingKeys' && e.detail[0] === 'nobody@example.org');
  await assert.rejects(encryptedSendPayload({ ...base, forwardedCount: 1 }), e => e.code === 'forwarded');
  await assert.rejects(encryptedSendPayload({ ...base, attachments: [{ size: 30 * 1024 * 1024 }] }), e => e.code === 'tooLarge');
  // Bcc counts as much as To.
  await assert.rejects(encryptedSendPayload({ ...base, payload: { to: ['bob@example.net'], cc: [], bcc: ['nobody@example.org'], body: '' } }), e => e.code === 'missingKeys');
  assert.equal(encrypted, false);
});
