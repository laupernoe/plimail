// Render test for the recipient's page of a password-protected message (/s/<token>). Pins that the
// page derives the key in the browser and sends only the authentication key, says how many tries
// are left after a wrong password, shows the decrypted HTML in a frame that cannot run script,
// offers attachments as downloads, encrypts the reply before it leaves, and tells a removed link
// apart from a network failure.
//
// Loader hooks as in the other render tests: JSX through sucrase, and the page's strings (a Vite
// virtual module in the build) handed over from en.json.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';

const STRINGS_URL = 'virtual-secure-strings:en';
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'virtual:secure-page-strings') return { url: STRINGS_URL, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === STRINGS_URL) {
      const en = JSON.parse(readFileSync(new URL('../locales/en.json', import.meta.url), 'utf8')).securePage;
      return { format: 'module', shortCircuit: true, source: `export default ${JSON.stringify({ en })};` };
    }
    const path = url.split('?')[0];
    if (path.endsWith('.jsx')) {
      const out = transform(readFileSync(new URL(path), 'utf8'), { transforms: ['jsx'], jsxRuntime: 'automatic', filePath: path });
      return { format: 'module', shortCircuit: true, source: out.code };
    }
    return nextLoad(url, context);
  },
});

const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid/s/x', pretendToBeVisual: true });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document,
  localStorage: dom.window.localStorage,
  Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});

const { createElement, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: SecureMessagePage, tokenFromPath, frameDocument } = await import('./SecureMessagePage.jsx');
const { sealMessage, unlock, openReply, toBase64 } = await import('../utils/secureMessageCrypto.js');
const en = JSON.parse(readFileSync(new URL('../locales/en.json', import.meta.url), 'utf8')).securePage;

const TOKEN = 'T'.repeat(43);
const PASSWORD = 'blue-otter-41';
let server;
const calls = [];
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

globalThis.fetch = async (url, init = {}) => {
  calls.push({ url: String(url), init });
  if (server.down) throw new TypeError('network down');
  if (!server.sealed) return json({ error: 'gone', code: 'unavailable' }, 404);
  const { sealed } = server;
  if (url === `/api/s/${TOKEN}/meta`) {
    return json({ senderName: 'Maria Rossi', senderEmail: 'maria@example.com', salt: sealed.salt, iterations: sealed.iterations, expiresAt: '2026-12-01T10:00:00.000Z', remainingAttempts: 10 });
  }
  const key = url.endsWith('/open') ? JSON.parse(init.body).authKey : init.headers['X-Secure-Auth'];
  const ok = createHash('sha256').update(Buffer.from(String(key), 'hex')).digest('hex') === sealed.authVerifier;
  if (!ok) return json({ error: 'Wrong password', code: 'wrong_password', remainingAttempts: 9 }, 401);
  if (url === `/api/s/${TOKEN}/open`) return json({ ciphertext: sealed.ciphertext, iv: sealed.iv });
  if (url === `/api/s/${TOKEN}/reply`) {
    server.replies.push({ ciphertext: toBase64(new Uint8Array(init.body)), iv: init.headers['X-Secure-IV'] });
    return json({ ok: true }, 201);
  }
  return json({ error: 'unexpected' }, 500);
};

let root, container;
beforeEach(async () => {
  calls.length = 0;
  server = {
    replies: [],
    sealed: await sealMessage(PASSWORD, {
      subject: 'Lease agreement',
      html: '<p>Signed copy attached.</p><script>window.ran = true</script>',
      text: 'Signed copy attached.',
      attachments: [{ filename: 'lease.pdf', mimeType: 'application/pdf', data: new Uint8Array([37, 80, 68, 70]) }],
    }, { iterations: 1000 }),
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

const until = async (check, ms = 4000) => {
  const end = Date.now() + ms;
  for (;;) {
    await act(async () => { await new Promise(r => setTimeout(r, 15)); });
    if (check()) return;
    if (Date.now() > end) throw new Error(`timed out; page shows: ${container.textContent}`);
  }
};
const text = () => container.textContent;
function type(input, value) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value').set;
  setter.call(input, value);
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
}
async function submitPassword(pw) {
  const input = container.querySelector('#secure-password');
  await act(async () => { type(input, pw); });
  await act(async () => { container.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); });
}

test('reads the token from /s/<token> only', () => {
  assert.equal(tokenFromPath(`/s/${TOKEN}`), TOKEN);
  assert.equal(tokenFromPath(`/s/${TOKEN}/`), TOKEN);
  assert.equal(tokenFromPath('/s/short'), null);
  assert.equal(tokenFromPath(`/x/${TOKEN}`), null);
});

test('a wrong password says how many tries are left, and the right one shows the message safely', async () => {
  await act(async () => { root.render(createElement(SecureMessagePage, { token: TOKEN })); });
  await until(() => !!container.querySelector('#secure-password'));
  assert.ok(text().includes('Maria Rossi sent you a password-protected message'));
  assert.ok(text().includes('maria@example.com'));
  assert.ok(text().includes(en.neverAsks));

  await submitPassword('not-it-at-all');
  await until(() => text().includes('Attempts left: 9'));

  await submitPassword(PASSWORD);
  await until(() => text().includes('Lease agreement'));
  // Only the authentication key went to the server, never the password, and with no cookie.
  const opens = calls.filter(c => c.url.endsWith('/open'));
  assert.equal(opens.length, 2);
  for (const c of opens) {
    assert.ok(!c.init.body.includes(PASSWORD));
    assert.match(JSON.parse(c.init.body).authKey, /^[0-9a-f]{64}$/);
    assert.equal(c.init.credentials, 'omit');
    assert.equal(c.init.headers['X-Requested-With'], 'XMLHttpRequest');
  }
  const frame = container.querySelector('iframe');
  assert.ok(frame, 'the HTML is shown in a frame');
  const sandbox = frame.getAttribute('sandbox');
  assert.ok(!sandbox.includes('allow-scripts'));
  assert.ok(!sandbox.includes('allow-same-origin'));
  assert.ok(frame.getAttribute('srcdoc').includes('Signed copy attached.'));
  const link = [...container.querySelectorAll('a')].find(a => a.getAttribute('download') === 'lease.pdf');
  assert.ok(link?.getAttribute('href').startsWith('blob:'));
});

test('a reply is encrypted with the message key before it is posted', async () => {
  await act(async () => { root.render(createElement(SecureMessagePage, { token: TOKEN })); });
  await until(() => !!container.querySelector('#secure-password'));
  await submitPassword(PASSWORD);
  await until(() => !!container.querySelector('textarea'));
  await act(async () => { type(container.querySelector('textarea'), 'Thanks, signed and returned.'); });
  const replyForm = container.querySelectorAll('form')[0];
  await act(async () => { replyForm.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); });
  await until(() => text().includes(en.replySent));
  const post = calls.find(c => c.url.endsWith('/reply'));
  assert.equal(post.init.headers['Content-Type'], 'application/octet-stream');
  assert.ok(!Buffer.from(post.init.body).toString('utf8').includes('Thanks'));
  const { encKey } = await unlock(PASSWORD, server.sealed);
  assert.deepEqual(await openReply(encKey, server.replies[0]), { text: 'Thanks, signed and returned.' });
});

test('a link that is gone says so; a failed load offers to try again', async () => {
  server.sealed = null;
  await act(async () => { root.render(createElement(SecureMessagePage, { token: TOKEN })); });
  await until(() => text().includes(en.unavailableTitle));
  assert.ok(!container.querySelector('#secure-password'));

  act(() => root.unmount());
  root = createRoot(container);
  server.down = true;
  await act(async () => { root.render(createElement(SecureMessagePage, { token: TOKEN })); });
  await until(() => text().includes(en.loadFailed));
  assert.ok(text().includes(en.retry));
});

test('the frame document sets no referrer and opens links in a new tab', () => {
  const doc = frameDocument('<a href="https://example.com">x</a>');
  assert.ok(doc.includes('<meta name="referrer" content="no-referrer">'));
  assert.ok(doc.includes('<base target="_blank">'));
});
