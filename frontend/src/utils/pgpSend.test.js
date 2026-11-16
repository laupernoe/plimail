import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as openpgp from 'openpgp';
import { decryptArmored, encryptionKeyIds, generateKeyPair, unlockPrivateKey } from './pgp.js';
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

test('hides every recipient key ID when the message has Bcc, so no one learns who else got it', async () => {
  const carol = await generateKeyPair({ email: 'carol@example.org', passphrase: 'c-pass-123' });
  const results = { ...lookup, 'carol@example.org': { source: 'keyring', keys: [{ fingerprint: carol.fingerprint, armored: carol.armoredPublic, verified: false }] } };
  const statuses = await classifyRecipients(['bob@example.net', 'carol@example.org'], results);
  const payload = { to: ['bob@example.net'], cc: [], bcc: ['carol@example.org'], subject: 'x', body: 'hi', bodyIsHtml: false };
  const body = await encryptedSendPayload({ payload, statuses, ownKey, fromEmail: 'me@example.com' });
  assert.deepEqual([...new Set(await encryptionKeyIds(body.pgp.encrypted))], ['0000000000000000']);
  // Bob, the Bcc recipient and the sender's Sent copy all still open it.
  for (const [k, p] of [[bob.armoredPrivate, 'bob-pass-123'], [carol.armoredPrivate, 'c-pass-123'], [me.armoredPrivate, 'me-pass-123']]) {
    await decryptArmored(body.pgp.encrypted, { decryptionKey: await unlockPrivateKey(k, p) });
  }
  // Without Bcc the recipients are named, as usual.
  const plain = await encryptedSendPayload({ payload: { ...payload, bcc: [], cc: ['carol@example.org'] }, statuses, ownKey, fromEmail: 'me@example.com' });
  assert.ok((await encryptionKeyIds(plain.pgp.encrypted)).every(id => id !== '0000000000000000'));
});

test('keeps the lock\'s mode for a restore, without any passphrase or password', async () => {
  const { protectionForRestore, initialPgp, initialSecure, pgpDefaults } = await import('./pgpSend.js');
  assert.deepEqual(protectionForRestore({ pgp: { ...pgpDefaults(), sign: false, passphrase: 'secret' } }), { mode: 'pgp', sign: false });
  assert.deepEqual(protectionForRestore({ secure: { password: 'pw', confirm: 'pw', expiresInDays: 30 } }), { mode: 'password', expiresInDays: 30 });
  assert.equal(protectionForRestore({}), null);
  assert.deepEqual(initialPgp({ mode: 'pgp', sign: false }), { ...pgpDefaults(), sign: false });
  assert.equal(initialPgp(null), null);
  assert.deepEqual(initialSecure({ mode: 'password', expiresInDays: 30 }, () => ({ password: '', confirm: '', expiresInDays: 7 })), { password: '', confirm: '', expiresInDays: 30 });
});

test('a message going encrypted automatically comes back encrypted, as required; one turned off stays off', async () => {
  const { protectionForRestore, initialPgp, initialAutoOptOut, pgpDefaults } = await import('./pgpSend.js');
  // Sent (or about to be) encrypted because every recipient had a key: an undo, a failure or the
  // screen lock must not hand it back as plain mail that Send would deliver in the clear.
  const auto = protectionForRestore({ autoEncrypt: true });
  assert.deepEqual(auto, { mode: 'pgp', sign: true, auto: true });
  assert.deepEqual(initialPgp(auto), { ...pgpDefaults(), auto: true }, 'reopens with encryption required');
  assert.equal(initialAutoOptOut(auto), false);
  // The user chose encryption: kept as it was, whatever automatic encryption says.
  assert.deepEqual(protectionForRestore({ pgp: pgpDefaults(), autoEncrypt: false, optedOut: true }), { mode: 'pgp', sign: true });
  // "Don't encrypt" for this message.
  const off = protectionForRestore({ optedOut: true });
  assert.deepEqual(off, { mode: 'plain' });
  assert.equal(initialPgp(off), null);
  assert.equal(initialAutoOptOut(off), true);
  // A password link wins over everything else: it is what the user chose last.
  assert.equal(protectionForRestore({ secure: { expiresInDays: 7 }, autoEncrypt: true }).mode, 'password');
});

test('encrypts automatically only when every recipient has a usable key', async () => {
  const { encryptionDecision } = await import('./pgpSend.js');
  const ok = email => ({ email, status: 'ok', keys: [{}] });
  const base = { autoSetting: true, ownKey, recipients: ['a@x.org', 'b@x.org'], statuses: [ok('a@x.org'), ok('b@x.org')] };
  assert.deepEqual(encryptionDecision(base), { mode: 'pgp', auto: true });
  // One recipient without a key: plain, quietly.
  assert.deepEqual(encryptionDecision({ ...base, statuses: [ok('a@x.org'), { email: 'b@x.org', status: 'missing', keys: [] }] }), { mode: 'plain' });
  assert.deepEqual(encryptionDecision({ ...base, statuses: [ok('a@x.org')] }), { mode: 'plain' });
  assert.deepEqual(encryptionDecision({ ...base, statuses: [ok('a@x.org'), { email: 'b@x.org', status: 'error', keys: [] }] }), { mode: 'plain' });
  // Turned off: in Settings, or for this message.
  assert.deepEqual(encryptionDecision({ ...base, autoSetting: false }), { mode: 'plain' });
  assert.deepEqual(encryptionDecision({ ...base, optedOut: true }), { mode: 'plain' });
  // No key of the user's own for the From address (the Sent copy would be unreadable), no recipient,
  // still looking keys up, or something the browser cannot encrypt.
  assert.deepEqual(encryptionDecision({ ...base, ownKey: null }), { mode: 'plain' });
  assert.deepEqual(encryptionDecision({ ...base, recipients: [] }), { mode: 'plain' });
  assert.deepEqual(encryptionDecision({ ...base, checking: true }), { mode: 'plain', checking: true });
  assert.deepEqual(encryptionDecision({ ...base, forwardedCount: 1 }), { mode: 'plain' });
  assert.deepEqual(encryptionDecision({ ...base, attachmentBytes: 30 * 1024 * 1024 }), { mode: 'plain' });
  // Chosen: "Send encrypted" (required, whatever the keys) and "Send with a password".
  assert.deepEqual(encryptionDecision({ ...base, explicit: true, statuses: [], autoSetting: false }), { mode: 'pgp', auto: false });
  assert.deepEqual(encryptionDecision({ ...base, secure: true, explicit: true }), { mode: 'password' });
});

test('decides on every recipient, and looks up only what is not still being typed', async () => {
  const { composerRecipients, encryptionDecision } = await import('./pgpSend.js');
  const { recipients, lookup } = composerRecipients(
    ['Bob <Bob@Example.net>', 'dave@intranet', 'ivan@пример.рф', 'bob@example.net'],
    ['carol@exa', '', ' eve@example.org '],
  );
  assert.deepEqual(recipients, ['bob@example.net', 'dave@intranet', 'ivan@пример.рф', 'carol@exa', 'eve@example.org']);
  // Chips are looked up whatever they look like; a typed address only once whole.
  assert.deepEqual(lookup, ['bob@example.net', 'dave@intranet', 'ivan@пример.рф', 'eve@example.org']);
  // A recipient with no answer (not looked up, or nothing found) has no key: plain, never "encrypted".
  const ok = email => ({ email, status: 'ok', keys: [{}] });
  assert.deepEqual(encryptionDecision({ autoSetting: true, ownKey, recipients, statuses: lookup.map(ok) }), { mode: 'plain' });
  assert.deepEqual(encryptionDecision({ autoSetting: true, ownKey, recipients: lookup, statuses: lookup.map(ok) }), { mode: 'pgp', auto: true });
});

test('signs with an imported key before one Plimail made, and never with a stale one', async () => {
  const { ownKeyFor, staleKeyFor } = await import('./pgpSend.js');
  const imported = { id: 'imp', emails: ['me@example.com'], auto: false, keyCreatedAt: '2019-01-01' };
  const made = { id: 'auto', emails: ['me@example.com'], auto: true, keyCreatedAt: '2026-01-01' };
  const stale = { id: 'old', emails: ['me@example.com'], auto: true, stale: true, keyCreatedAt: '2027-01-01' };
  assert.equal(ownKeyFor([made, imported, stale], 'me@example.com').id, 'imp');
  assert.equal(ownKeyFor([made, stale], 'me@example.com').id, 'auto');
  assert.equal(ownKeyFor([stale], 'me@example.com'), null);
  assert.equal(staleKeyFor([stale], 'me@example.com').id, 'old');
  assert.equal(staleKeyFor([stale, made], 'me@example.com'), null, 'a usable key: nothing to warn about');
});

test('how the message went decides its restore, over a password panel the send just closed', async () => {
  const { protectionForRestore } = await import('./pgpSend.js');
  const secure = { password: '', confirm: '', expiresInDays: 7 };
  assert.deepEqual(protectionForRestore({ secure, sent: { auto: false } }), { mode: 'pgp', sign: true });
  assert.deepEqual(protectionForRestore({ secure, sent: { auto: true } }), { mode: 'pgp', sign: true, auto: true });
  assert.equal(protectionForRestore({ secure }).mode, 'password');
});
