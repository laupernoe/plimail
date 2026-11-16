import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMessage, sealMessage, unlock } from './secureMessageCrypto.js';
import { noticeEmail, secureSettingsProblem, securePayloadFrom, sendProtected, SECURE_MAX_ATTACHMENT_BYTES } from './secureSend.js';

const t = (key, values = {}) => `${key}(${Object.values(values).join(',')})`;
const formatDate = iso => `on ${iso}`;
const built = (over = {}) => ({
  toFinal: ['bob@example.com'], ccFinal: ['carol@example.com'], bccFinal: ['dan@example.com'],
  payload: {
    accountId: 'acc-1', to: ['bob@example.com'], cc: ['carol@example.com'], bcc: ['dan@example.com'],
    subject: 'Salary review', body: '<p>The figures are attached.</p>', bodyIsHtml: true,
    editedSignature: '<b>Maria</b>', quotedBodyHtml: '<blockquote>earlier</blockquote>', inReplyTo: '<x@y>',
    attachments: [{ filename: 'figures.pdf', content: 'AQID', encoding: 'base64', contentType: 'application/pdf' }],
    ...over,
  },
});
const ATTACHMENTS = [{ name: 'figures.pdf', type: 'application/pdf', data: 'AQID', size: 3 }];

function fakeApi({ sendFails = false } = {}) {
  const calls = { created: [], sent: [], removed: [] };
  return {
    calls,
    secureMessages: {
      create: async (body) => {
        calls.created.push(body);
        return { id: 'sm-1', url: 'https://mail.example.com/s/TOKEN', expiresAt: '2026-11-23T10:00:00.000Z', senderName: 'Maria Rossi', senderEmail: 'maria@example.com' };
      },
      remove: async (id) => { calls.removed.push(id); },
    },
    post: async (path, body, headers) => {
      calls.sent.push({ path, body, headers });
      if (sendFails) throw new Error('SMTP refused');
      return { messageId: '<n@example.com>' };
    },
  };
}
const seal = (pw, p) => sealMessage(pw, p, { iterations: 1000 });
const settings = { password: 'long enough pw', confirm: 'long enough pw', expiresInDays: 30 };

test('the recipients get a notice, with no subject, body, quote or attachment of the message', async () => {
  const api = fakeApi();
  await sendProtected({ built: built(), attachments: ATTACHMENTS, settings, t, formatDate, api, idempotencyKey: 'k1', seal });
  assert.equal(api.calls.sent.length, 1);
  const { path, body, headers } = api.calls.sent[0];
  assert.equal(path, '/mail/send');
  assert.deepEqual(headers, { 'X-Idempotency-Key': 'k1' });
  assert.equal(body.subject, 'compose.secure.noticeSubject(Maria Rossi)');
  assert.ok(body.body.includes('href="https://mail.example.com/s/TOKEN"'));
  assert.ok(body.body.includes('on 2026-11-23T10:00:00.000Z'));
  const all = JSON.stringify(body);
  for (const secret of ['Salary review', 'figures', 'earlier', 'Maria</b>']) assert.ok(!all.includes(secret), secret);
  assert.equal(body.attachments, undefined);
  assert.equal(body.quotedBodyHtml, undefined);
  assert.equal(body.editedSignature, '');
  assert.equal(body.undoSeconds, 0);
  // Still addressed and threaded as the message was.
  assert.deepEqual([body.to, body.cc, body.bcc, body.inReplyTo], [['bob@example.com'], ['carol@example.com'], ['dan@example.com'], '<x@y>']);
});

test('the protected message holds the real content, for every recipient, and opens with the password', async () => {
  const api = fakeApi();
  await sendProtected({ built: built(), attachments: ATTACHMENTS, settings, t, formatDate, api, seal });
  const [created] = api.calls.created;
  assert.deepEqual(created.recipients, ['bob@example.com', 'carol@example.com', 'dan@example.com']);
  assert.equal(created.expiresInDays, 30);
  assert.equal(created.accountId, 'acc-1');
  assert.ok(!JSON.stringify(created).includes('Salary'));
  const { encKey } = await unlock(settings.password, created);
  const opened = await openMessage(encKey, created);
  assert.equal(opened.subject, 'Salary review');
  assert.ok(opened.html.includes('The figures are attached.'));
  assert.ok(opened.html.includes('<b>Maria</b>'));
  assert.ok(opened.html.includes('earlier'));
  assert.deepEqual([...opened.attachments[0].data], [1, 2, 3]);
});

test('a notice that fails to go deletes the protected message again', async () => {
  const api = fakeApi({ sendFails: true });
  await assert.rejects(sendProtected({ built: built(), attachments: [], settings, t, formatDate, api, seal }), /SMTP refused/);
  assert.deepEqual(api.calls.removed, ['sm-1']);
});

test('refuses forwarded attachments and more than 25 MB before anything is made', async () => {
  const api = fakeApi();
  await assert.rejects(sendProtected({ built: built(), attachments: [], forwardedCount: 1, settings, t, formatDate, api, seal }), { code: 'forwarded' });
  const huge = [{ name: 'big.bin', data: '', size: SECURE_MAX_ATTACHMENT_BYTES + 1 }];
  await assert.rejects(sendProtected({ built: built(), attachments: huge, settings, t, formatDate, api, seal }), { code: 'tooLarge' });
  assert.equal(api.calls.created.length, 0);
});

test('a plain-text message gets a plain-text notice', () => {
  const n = noticeEmail({ t, formatDate, url: 'https://x/s/T', expiresAt: 'D', senderName: 'M', html: false });
  assert.ok(n.body.includes('https://x/s/T'));
  assert.ok(!n.body.includes('<'));
  const p = securePayloadFrom({ subject: 's', body: 'hello', bodyIsHtml: false, editedSignature: 'Maria', quotedBody: '\n> old' });
  assert.equal(p.html, '');
  assert.equal(p.text, 'hello\n\n-- \nMaria\n> old');
});

test('the notice escapes the sender name', () => {
  const n = noticeEmail({ t, formatDate, url: 'https://x/s/T', expiresAt: 'D', senderName: '<img src=x>' });
  assert.ok(!n.body.includes('<img'));
});

test('protection settings need 8 characters and a matching confirmation', () => {
  assert.equal(secureSettingsProblem({ password: 'short', confirm: 'short' }), 'tooShort');
  assert.equal(secureSettingsProblem({ password: 'long enough', confirm: 'long enougH' }), 'mismatch');
  assert.equal(secureSettingsProblem({ password: 'long enough', confirm: 'long enough' }), null);
});
