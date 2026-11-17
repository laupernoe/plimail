import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// DOMPurify needs a window when it is imported.
const dom = new JSDOM('');
Object.assign(globalThis, { window: dom.window, document: dom.window.document });

const { generateKeyPair, encryptMime } = await import('./pgp.js');
const { buildMimeEntity, entityBytes } = await import('./mimeBuild.js');
const { encryptedDraftBody } = await import('./pgpDraft.js');
const { encryptedDraftFields, encryptedScheduledFields } = await import('./encryptedDraftOpen.js');
const { setKeySecret, setKeySecretOwner } = await import('./pgpSecret.js');

// Reopening what was saved encrypted: the composer gets the content decrypted, the signature in
// its own place, and the message stays encrypted. The key opens with the sign-in secret, unasked.

const SECRET = 'v1.secret-from-the-plimail-password';
const mine = await generateKeyPair({ email: 'me@example.com', passphrase: SECRET });
const OWN = { id: 'k1', fingerprint: mine.fingerprint, emails: ['me@example.com'], armoredPublic: mine.armoredPublic, armoredPrivate: mine.armoredPrivate, protection: 'login' };
setKeySecretOwner('u1');
setKeySecret('u1', SECRET);
const ownKeys = async () => [OWN];

const rawDraft = armored => new TextEncoder().encode([
  'Subject: Plans', 'MIME-Version: 1.0',
  'Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="b"', '',
  '--b', 'Content-Type: application/pgp-encrypted', '', 'Version: 1', '',
  '--b', 'Content-Type: application/octet-stream', '', armored.trim(), '--b--', '',
].join('\r\n'));

test('a draft reopens decrypted, its signature apart, encrypted as it was', async () => {
  const { pgp } = await encryptedDraftBody({
    fields: { to: ['bob@example.net'], subject: 'Plans', body: '<p>the plan<img src="x" onerror="alert(1)"></p>', bodyIsHtml: true, editedSignature: '<b>Me</b>' },
    ownKey: OWN, auto: true,
  });
  const fields = await encryptedDraftFields('m1', { rawMessage: async () => rawDraft(pgp.encrypted), ownKeys });
  assert.equal(fields.bodyIsHtml, true);
  assert.ok(fields.body.includes('the plan'));
  assert.ok(!fields.body.includes('onerror'), 'cleaned as any HTML the composer opens');
  assert.equal(fields.signature, '<b>Me</b>');
  assert.deepEqual(fields.protection, { mode: 'pgp', sign: true, auto: true });
  assert.deepEqual(fields.externalAttachments, []);
  assert.equal(fields.unresolvedExternalAttachments, false);
});

test('a draft with files inside (another program saved it) is not opened for editing', async () => {
  const entity = buildMimeEntity({ text: 'x', attachments: [{ filename: 'a.pdf', mimeType: 'application/pdf', data: new Uint8Array([1, 2]) }] });
  const armored = await encryptMime(entityBytes(entity), { recipientArmored: [mine.armoredPublic] });
  await assert.rejects(encryptedDraftFields('m1', { rawMessage: async () => rawDraft(armored), ownKeys }), e => e.code === 'hasAttachments');
});

test('an encrypted scheduled message opens with its files back in the composer', async () => {
  const entity = buildMimeEntity({
    html: '<p>later</p><div style="margin-top:16px">sig</div>', text: 'later',
    attachments: [{ filename: 'a.pdf', mimeType: 'application/pdf', data: new Uint8Array([1, 2, 3]) }],
  });
  const armored = await encryptMime(entityBytes(entity), { recipientArmored: [mine.armoredPublic] });
  const detail = { id: 's1', attachments: [{ index: 0, kind: 'pgp', filename: 'encrypted.asc' }] };
  const fields = await encryptedScheduledFields(detail, { attachmentBase64: async (id, index) => (id === 's1' && index === 0 ? btoa(armored) : null), ownKeys });
  assert.ok(fields.body.includes('later'));
  assert.equal(fields.signature, '', 'the signature is in the body it was sent with');
  assert.deepEqual(fields.attachments, [{ name: 'a.pdf', type: 'application/pdf', size: 3, data: 'AQID' }]);
  assert.deepEqual(fields.protection, { mode: 'pgp', sign: true });
});
