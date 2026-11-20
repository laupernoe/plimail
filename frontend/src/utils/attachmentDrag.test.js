import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  attachmentDownloadUrl, downloadUrlData, dragFilename, setAttachmentDragData, supportsDownloadUrlDrag,
} from './attachmentDrag.js';

const fakeTransfer = () => {
  const data = {};
  return { data, effectAllowed: 'all', setData(k, v) { data[k] = v; } };
};

test('DownloadURL is mime:name:absolute-url', () => {
  assert.equal(
    downloadUrlData({ type: 'application/pdf', filename: 'Facture 12.pdf', url: 'https://mail.example/api/x' }),
    'application/pdf:Facture 12.pdf:https://mail.example/api/x');
});

test('a colon or a path separator in the name cannot cut it short or leave the folder', () => {
  assert.equal(dragFilename('Re: offre 10:30.pdf'), 'Re_ offre 10_30.pdf');
  assert.equal(dragFilename('../../etc/passwd'), '_.._etc_passwd');
  assert.equal(dragFilename('a\\b\u0000\u001f.txt'), 'a_b.txt');
  const v = downloadUrlData({ type: 'text/plain', filename: 'a:b.txt', url: 'https://h/x' });
  assert.equal(v.split(':').slice(0, 2).join(':'), 'text/plain:a_b.txt');
});

test('unicode names are kept as they are', () => {
  assert.equal(dragFilename('Rapport été 2026 — 日本.pdf'), 'Rapport été 2026 — 日本.pdf');
});

test('an empty, dot-only or missing name falls back to "attachment"', () => {
  assert.equal(dragFilename(''), 'attachment');
  assert.equal(dragFilename(undefined), 'attachment');
  assert.equal(dragFilename('..'), 'attachment');
  assert.equal(dragFilename('.bashrc'), 'bashrc');
});

test('a missing or malformed type becomes application/octet-stream', () => {
  assert.match(downloadUrlData({ type: undefined, filename: 'x', url: 'https://h/' }), /^application\/octet-stream:x:/);
  assert.match(downloadUrlData({ type: 'evil:type', filename: 'x', url: 'https://h/' }), /^application\/octet-stream:x:/);
});

test('the drag carries the download and, unless told not to, the link as text', () => {
  const dt = fakeTransfer();
  setAttachmentDragData(dt, { type: 'image/png', filename: 'a.png', url: 'https://h/a' });
  assert.equal(dt.effectAllowed, 'copy');
  assert.deepEqual(dt.data, { DownloadURL: 'image/png:a.png:https://h/a', 'text/plain': 'https://h/a' });
  assert.equal(dt.data['text/uri-list'], undefined);

  const blob = fakeTransfer();
  setAttachmentDragData(blob, { type: 'application/octet-stream', filename: 's.pdf', url: 'blob:https://h/1', link: false });
  assert.deepEqual(blob.data, { DownloadURL: 'application/octet-stream:s.pdf:blob:https://h/1' });
});

test('the download URL is absolute and encodes the part', () => {
  assert.equal(attachmentDownloadUrl('m1', '1.2', 'https://mail.example/inbox/x'),
    'https://mail.example/api/mail/messages/m1/attachments/1.2');
  assert.equal(attachmentDownloadUrl('m1', 'a/b', 'https://mail.example/'),
    'https://mail.example/api/mail/messages/m1/attachments/a%2Fb');
});

test('only Chromium-based browsers count as understanding DownloadURL', () => {
  assert.equal(supportsDownloadUrlDrag({ userAgentData: { brands: [{ brand: 'Chromium', version: '140' }] } }), true);
  assert.equal(supportsDownloadUrlDrag({ userAgentData: { brands: [{ brand: 'Microsoft Edge', version: '140' }] } }), true);
  assert.equal(supportsDownloadUrlDrag({ userAgent: 'Mozilla/5.0 Firefox/140.0' }), false);
  assert.equal(supportsDownloadUrlDrag(undefined), false);
});
