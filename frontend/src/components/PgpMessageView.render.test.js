// Render test for an encrypted message in the reading pane (PgpMessageView.jsx). Pins that the
// message is decrypted here with the key's passphrase, that a wrong one shows nothing, and that
// the decrypted HTML is shown in a frame without scripts or same-origin access, sanitized, with
// a policy that loads nothing remote.
//
// Same loader hooks as SecureMessagesSection.render.test.js.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('react-i18next/dist/es/index.js') || url.endsWith('/react-i18next')) {
      return { format: 'module', shortCircuit: true, source: [
        'export const useTranslation = () => ({ t: (k, o) => (o ? k + " " + JSON.stringify(o) : k), i18n: { language: "en", changeLanguage: () => {} } });',
        'export const initReactI18next = { type: "3rdParty", init: () => {} };',
        'export default { useTranslation, initReactI18next };',
      ].join('\n') };
    }
    const path = url.split('?')[0];
    if (path.endsWith('.jsx')) {
      const out = transform(readFileSync(new URL(path), 'utf8'), { transforms: ['jsx'], jsxRuntime: 'automatic', filePath: path });
      return { format: 'module', shortCircuit: true, source: out.code.replaceAll('import.meta.env', 'globalThis.__VITE_ENV__') };
    }
    if (url.startsWith('file:') && url.endsWith('.js')) {
      const code = readFileSync(new URL(url), 'utf8');
      if (code.includes('import.meta.env')) {
        return { format: 'module', shortCircuit: true, source: code.replaceAll('import.meta.env', 'globalThis.__VITE_ENV__') };
      }
    }
    return nextLoad(url, context);
  },
});

const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid/', pretendToBeVisual: true });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document,
  localStorage: dom.window.localStorage, sessionStorage: dom.window.sessionStorage,
  CustomEvent: dom.window.CustomEvent, Node: dom.window.Node, Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };

const { createElement, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: PgpMessageView, DecryptedBody, decryptedFrameDocument, DECRYPTED_FRAME_SANDBOX, ATTACHMENT_BLOB_TYPE, autocryptOffer } = await import('./PgpMessageView.jsx');
const { encryptMime, generateKeyPair } = await import('../utils/pgp.js');
const { buildMimeEntity, entityBytes } = await import('../utils/mimeBuild.js');
const { forgetAllUnlockedKeys, isUnlocked } = await import('../utils/pgpSession.js');

const ID = '00000000-0000-4000-8000-0000000000aa';
const PASS = 'correct horse battery';
const me = await generateKeyPair({ email: 'me@example.com', passphrase: PASS });
const hostile = '<p>Bonjour</p><script>parent.stolen = 1</script><img src="https://tracker.example/p.gif">'
  + '<img src="cid:logo@x"><a href="https://example.org" onclick="alert(1)">lien</a><form action="https://evil.example"><input name="pw"></form>';
const entity = buildMimeEntity({ html: hostile, text: 'Bonjour', headers: { subject: 'Secret subject' } });
const armored = await encryptMime(entityBytes(entity), { recipientArmored: [me.armoredPublic] });
const raw = new TextEncoder().encode([
  'From: bob@example.net', 'Subject: ...',
  'Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="e"', '',
  '--e', 'Content-Type: application/pgp-encrypted', '', 'Version: 1', '',
  '--e', 'Content-Type: application/octet-stream', '', armored.replace(/\n/g, '\r\n'), '--e--', '',
].join('\r\n'));

const calls = [];
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
globalThis.fetch = async (url, init = {}) => {
  const path = String(url);
  calls.push({ path, method: init.method || 'GET', body: init.body });
  if (path === `/api/mail/messages/${ID}/raw.eml`) return new Response(raw, { status: 200 });
  if (path === '/api/pgp/keys') return json({ keys: [{ id: 'k1', fingerprint: me.fingerprint, emails: ['me@example.com'], armoredPublic: me.armoredPublic, armoredPrivate: me.armoredPrivate }] });
  if (path === '/api/pgp/lookup') return json({ results: { 'bob@example.net': { source: null, keys: [] } } });
  return json({ error: 'unexpected' }, 500);
};

let root, container;
beforeEach(async () => {
  calls.length = 0;
  forgetAllUnlockedKeys();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root.render(createElement(PgpMessageView, { message: { id: ID, from_email: 'bob@example.net', subject: '...' } })); });
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

const until = async (check, ms = 8000) => {
  const end = Date.now() + ms;
  for (;;) {
    await act(async () => { await new Promise(r => setTimeout(r, 20)); });
    if (check()) return;
    if (Date.now() > end) throw new Error(`timed out; shows: ${container.textContent}`);
  }
};
function type(input, value) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value').set;
  setter.call(input, value);
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
}
async function unlockWith(pass) {
  await until(() => !!container.querySelector('input[type="password"]'));
  await act(async () => { type(container.querySelector('input[type="password"]'), pass); });
  await act(async () => { container.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); });
}

test('asks for the passphrase, decrypts, and shows the HTML in a frame without scripts or same-origin', async () => {
  await unlockWith(PASS);
  await until(() => !!container.querySelector('iframe'));
  const frame = container.querySelector('iframe');
  const sandbox = frame.getAttribute('sandbox');
  assert.equal(sandbox, DECRYPTED_FRAME_SANDBOX);
  assert.ok(!sandbox.includes('allow-scripts'));
  assert.ok(!sandbox.includes('allow-same-origin'));
  const doc = frame.getAttribute('srcdoc');
  assert.match(doc, /Content-Security-Policy" content="default-src 'none'; img-src data:/);
  assert.ok(doc.includes('<p>Bonjour</p>'));
  assert.ok(!/<script/i.test(doc));
  assert.ok(!/onclick/i.test(doc));
  assert.ok(!/<form|<input/i.test(doc));
  // The protected subject, since the outer one is a placeholder.
  assert.ok(container.textContent.includes('Secret subject'));
  // Remembered for this tab, as the box (on by default) says; nothing was sent anywhere.
  assert.ok(isUnlocked(me.fingerprint));
  assert.ok(calls.every(c => c.method === 'GET' || c.path === '/api/pgp/lookup'));
  assert.ok(!calls.some(c => String(c.body || '').includes('Bonjour')));
});

test('a wrong passphrase shows nothing of the message', async () => {
  await unlockWith('wrong one');
  await until(() => container.textContent.includes('pgp.errors.wrongPassphrase'));
  assert.equal(container.querySelector('iframe'), null);
  assert.ok(!container.textContent.includes('Bonjour'));
  assert.ok(!isUnlocked(me.fingerprint));
});

test('the frame document blocks remote content and keeps only images the message carries', () => {
  const doc = decryptedFrameDocument('<img src="https://x.example/a.png"><img src="cid:a@b"><img src="cid:missing">', [
    { contentId: 'a@b', mimeType: 'image/png', data: new Uint8Array([137, 80, 78, 71]) },
  ]);
  assert.ok(doc.includes('src="data:image/png;base64,iVBORw=="'));
  assert.ok(!doc.includes('cid:missing'));
  // Remote images stay in the markup but the frame's policy (img-src data:) never loads them.
  assert.match(doc, /img-src data:;/);
});

test('a cid: that does not decode does not break the message', () => {
  assert.doesNotThrow(() => decryptedFrameDocument('<img src="cid:%E0%A4%A">'));
});

test('decrypted files download as octet-stream, whatever type the sender declared', () => {
  assert.equal(ATTACHMENT_BLOB_TYPE, 'application/octet-stream');
});

test('a decrypted file drags out from its local blob: URL, never as a link to the server', async () => {
  Object.defineProperty(globalThis.navigator, 'userAgentData', {
    value: { brands: [{ brand: 'Chromium', version: '140' }] }, configurable: true,
  });
  try {
    const box = document.createElement('div');
    document.body.appendChild(box);
    const r = createRoot(box);
    const content = { text: 'x', attachments: [{ filename: 'contrat: signé.pdf', mimeType: 'application/pdf', data: new Uint8Array([1, 2, 3]) }] };
    await act(async () => { r.render(createElement(DecryptedBody, { content, subject: 's' })); });
    const link = box.querySelector('a[download]');
    const data = {};
    const ev = new window.Event('dragstart', { bubbles: true, cancelable: true });
    ev.dataTransfer = { effectAllowed: 'all', setData(k, v) { data[k] = v; } };
    await act(async () => { link.dispatchEvent(ev); });
    assert.ok(link.href.startsWith('blob:'));
    assert.deepEqual(Object.keys(data), ['DownloadURL']);
    assert.equal(data.DownloadURL, `application/octet-stream:contrat_ signé.pdf:${link.href}`);
    act(() => r.unmount());
    box.remove();
  } finally {
    Object.defineProperty(globalThis.navigator, 'userAgentData', { value: undefined, configurable: true });
  }
});

test('never takes an Autocrypt key without asking, whatever the headers claim', async () => {
  const bob = await generateKeyPair({ email: 'bob@example.net', passphrase: 'x-pass-123' });
  const { readKey } = await import('openpgp');
  const keydata = btoa(String.fromCharCode(...(await readKey({ armoredKey: bob.armoredPublic })).write()));
  const posted = [];
  const before = globalThis.fetch;
  globalThis.fetch = async (url, init) => { if (String(url) === '/api/pgp/keyring') posted.push(init); return before(url, init); };
  const { parseMime } = await import('../utils/mimeParse.js');
  try {
    // An Authentication-Results header the sender wrote themselves, which nothing removed.
    const forged = 'Authentication-Results: mx.example.com; dkim=pass header.d=example.net; dmarc=pass header.from=example.net\r\n';
    const offer = await autocryptOffer({ autocrypt: { addr: 'bob@example.net', keydata }, root: parseMime(new TextEncoder().encode(`${forged}From: bob@example.net\r\n\r\nx`)) }, 'bob@example.net', []);
    assert.equal(offer.email, 'bob@example.net');
    assert.equal(offer.source, 'autocrypt');
    assert.equal(offer.collected, undefined);
    assert.equal(posted.length, 0);
  } finally { globalThis.fetch = before; }
});

test('shows the message as received when there is nothing to decrypt in it', async () => {
  let shown = false;
  const plainId = '00000000-0000-4000-8000-0000000000bb';
  const before = globalThis.fetch;
  globalThis.fetch = async (url, init) => (String(url) === `/api/mail/messages/${plainId}/raw.eml`
    ? new Response(new TextEncoder().encode('Content-Type: text/plain\r\n\r\nSee the .pgp file attached.\r\n'), { status: 200 })
    : before(url, init));
  try {
    await act(async () => { root.render(createElement(PgpMessageView, { message: { id: plainId, from_email: 'x@example.org' }, onShowOriginal: () => { shown = true; } })); });
    await until(() => shown);
  } finally { globalThis.fetch = before; }
});

// A key Plimail made, protected by the passphrase derived from the Plimail password: the secret
// this tab got at sign-in opens it, and the message, without a question.
test('a key protected by the Plimail password opens the message by itself', async () => {
  const { setKeySecret, setKeySecretOwner, forgetKeySecret } = await import('../utils/pgpSecret.js');
  const SECRET = 'v1.derived-at-sign-in';
  const auto = await generateKeyPair({ email: 'auto@example.com', passphrase: SECRET });
  const encrypted = await encryptMime(entityBytes(buildMimeEntity({ text: 'Opened by itself', headers: { subject: 'Auto' } })), { recipientArmored: [auto.armoredPublic] });
  const autoId = '00000000-0000-4000-8000-0000000000cc';
  const autoRaw = new TextEncoder().encode([
    'From: bob@example.net', 'Subject: ...',
    'Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="e"', '',
    '--e', 'Content-Type: application/pgp-encrypted', '', 'Version: 1', '',
    '--e', 'Content-Type: application/octet-stream', '', encrypted.replace(/\n/g, '\r\n'), '--e--', '',
  ].join('\r\n'));
  const before = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const path = String(url);
    if (path === `/api/mail/messages/${autoId}/raw.eml`) return new Response(autoRaw, { status: 200 });
    if (path === '/api/pgp/keys') return json({ keys: [{ id: 'k2', fingerprint: auto.fingerprint, emails: ['auto@example.com'], armoredPublic: auto.armoredPublic, armoredPrivate: auto.armoredPrivate, protection: 'login' }] });
    return before(url, init);
  };
  setKeySecretOwner('u-reader');
  setKeySecret('u-reader', SECRET);
  try {
    await act(async () => { root.render(createElement(PgpMessageView, { message: { id: autoId, from_email: 'bob@example.net', subject: '...' } })); });
    await until(() => container.textContent.includes('Opened by itself'));
    assert.equal(container.querySelector('input[type="password"]'), null, 'no passphrase asked');
    assert.ok(isUnlocked(auto.fingerprint));
  } finally {
    globalThis.fetch = before;
    forgetKeySecret();
    setKeySecretOwner(null);
  }
});
