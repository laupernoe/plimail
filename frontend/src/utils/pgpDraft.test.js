import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, unlockPrivateKey, decryptArmored } from './pgp.js';
import { PgpDraftError, draftDocument, encryptedDraftBody, openEncryptedDraft, openOwnMessage, withInlineImages } from './pgpDraft.js';
import { splitDraftSignature } from './draftSignature.js';

const PASS = 'own-pass-123';
const mine = await generateKeyPair({ email: 'me@example.com', passphrase: PASS });
const other = await generateKeyPair({ email: 'other@example.com', passphrase: 'other-pass-1' });
const OWN = { id: 'k1', fingerprint: mine.fingerprint, emails: ['me@example.com'], armoredPublic: mine.armoredPublic, armoredPrivate: mine.armoredPrivate };
const openKey = row => unlockPrivateKey(row.armoredPrivate, PASS);

const FIELDS = {
  to: ['Bob <bob@example.net>'], cc: [], bcc: ['hidden@example.org'], subject: 'Plans',
  body: '<p>the secret plan</p>', bodyIsHtml: true, quotedBodyHtml: '<blockquote>earlier</blockquote>',
  editedSignature: '<b>Me</b>', inReplyTo: '<prev@example.net>',
};

// The raw draft as routes/draft.js stores it: headers over a multipart/encrypted body.
const rawDraft = armored => new TextEncoder().encode([
  'Subject: Plans', 'MIME-Version: 1.0',
  'Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="b"', '',
  '--b', 'Content-Type: application/pgp-encrypted', '', 'Version: 1', '',
  '--b', 'Content-Type: application/octet-stream', '', armored.trim(), '--b--', '',
].join('\r\n'));

test('the body for /draft has the headers and the ciphertext, and nothing of the text', async () => {
  const body = await encryptedDraftBody({ fields: FIELDS, ownKey: OWN, fromEmail: 'me@example.com' });
  assert.deepEqual(Object.keys(body).sort(), ['bcc', 'cc', 'inReplyTo', 'pgp', 'subject', 'to']);
  assert.equal(body.subject, 'Plans');
  assert.match(body.pgp.encrypted, /^-----BEGIN PGP MESSAGE-----/);
  assert.ok(!JSON.stringify(body).includes('secret plan'));
  const { data } = await decryptArmored(body.pgp.encrypted, { decryptionKey: await openKey(OWN) });
  assert.ok(new TextDecoder().decode(data).includes('the secret plan'));
});

test('it is encrypted to the user\'s own key only', async () => {
  const body = await encryptedDraftBody({ fields: FIELDS, ownKey: OWN });
  const otherKey = await unlockPrivateKey(other.armoredPrivate, 'other-pass-1');
  await assert.rejects(decryptArmored(body.pgp.encrypted, { decryptionKey: otherKey }));
});

test('no key of the user\'s own: no draft at all, never one in the clear', async () => {
  await assert.rejects(encryptedDraftBody({ fields: FIELDS, ownKey: null }), e => e instanceof PgpDraftError && e.code === 'noOwnKey');
});

test('it reopens as written: body and quote, the signature lifted out, how it was encrypted', async () => {
  const body = await encryptedDraftBody({ fields: FIELDS, ownKey: OWN, auto: true });
  const opened = await openEncryptedDraft(rawDraft(body.pgp.encrypted), { ownKeys: [OWN], openKey });
  assert.equal(opened.auto, true);
  const split = splitDraftSignature(opened.html);
  assert.equal(split.signature, '<b>Me</b>');
  assert.equal(split.body, '<p>the secret plan</p><blockquote>earlier</blockquote>');
  assert.equal(opened.attachments.length, 0);
  const required = await encryptedDraftBody({ fields: FIELDS, ownKey: OWN });
  assert.equal((await openEncryptedDraft(rawDraft(required.pgp.encrypted), { ownKeys: [OWN], openKey })).auto, false);
});

test('a plain-text draft is laid out as the server lays one out', () => {
  const doc = draftDocument({ body: 'a < b\nline', bodyIsHtml: false, editedSignature: 'Me', quotedBody: '\n> old' });
  assert.equal(doc.text, 'a < b\nline\n\n-- \nMe\n> old');
  assert.ok(doc.html.startsWith('<p style="margin:0">a &lt; b</p><p style="margin:0">line</p><div data-mailflow-signature="1"'));
});

test('images in the body come back as they were', async () => {
  const img = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const fields = { ...FIELDS, body: `<p>x<img src="data:image/png;base64,${img}"></p>` };
  const body = await encryptedDraftBody({ fields, ownKey: OWN });
  const opened = await openEncryptedDraft(rawDraft(body.pgp.encrypted), { ownKeys: [OWN], openKey });
  assert.ok(opened.html.includes(`src="data:image/png;base64,${img}"`));
  assert.equal(withInlineImages('<img src="cid:nope">', []), '<img src="cid:nope">');
});

test('a draft no key of the user\'s opens, and a cancelled unlock, are said as such', async () => {
  const body = await encryptedDraftBody({ fields: FIELDS, ownKey: { armoredPublic: other.armoredPublic } });
  await assert.rejects(openEncryptedDraft(rawDraft(body.pgp.encrypted), { ownKeys: [OWN], openKey }), e => e.code === 'notForYou');
  const mineToo = await encryptedDraftBody({ fields: FIELDS, ownKey: OWN });
  const cancelled = Object.assign(new Error('unlockCancelled'), { code: 'unlockCancelled' });
  await assert.rejects(openOwnMessage(mineToo.pgp.encrypted, { ownKeys: [OWN], openKey: async () => { throw cancelled; } }), e => e === cancelled);
  await assert.rejects(openEncryptedDraft(new TextEncoder().encode('Subject: x\r\n\r\nplain'), { ownKeys: [OWN], openKey }), e => e.code === 'unreadable');
});
