// Render test for Settings → Security → Password (PasswordChangeSection.jsx): the keys that unlock
// with the password go to the server re-encrypted, in the same request as the new password; a key
// the current password does not open is named first, and nothing is sent unless the user goes on.
// Same loader hooks as PgpUnlockPrompt.render.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';

registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith('react-i18next/dist/es/index.js') || url.endsWith('/react-i18next')) {
    return { format: 'module', shortCircuit: true, source: [
      'export const useTranslation = () => ({ t: (key) => key, i18n: { language: "en", changeLanguage: () => {} } });',
      'export const initReactI18next = { type: "3rdParty", init: () => {} };',
      'export default { useTranslation, initReactI18next };',
    ].join('\n') };
  }
  if (url.endsWith('.json')) return { format: 'module', shortCircuit: true, source: `export default ${readFileSync(new URL(url), 'utf8')}` };
  if (url.endsWith('.jsx')) {
    const code = transform(readFileSync(new URL(url), 'utf8'), { transforms: ['jsx'], jsxRuntime: 'automatic', filePath: url }).code;
    return { format: 'module', shortCircuit: true, source: code.replaceAll('import.meta.env', 'globalThis.__VITE_ENV__') };
  }
  if (url.startsWith('file:') && url.endsWith('.js')) {
    const code = readFileSync(new URL(url), 'utf8');
    if (code.includes('import.meta.env')) return { format: 'module', shortCircuit: true, source: code.replaceAll('import.meta.env', 'globalThis.__VITE_ENV__') };
  }
  return nextLoad(url, context);
} });

const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid', pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document,
  localStorage: dom.window.localStorage, sessionStorage: dom.window.sessionStorage,
  CustomEvent: dom.window.CustomEvent, Node: dom.window.Node, Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement, DOMParser: dom.window.DOMParser,
  IS_REACT_ACT_ENVIRONMENT: true, __VITE_ENV__: { MODE: 'test', PROD: true } });
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const PasswordChangeSection = (await import('./PasswordChangeSection.jsx')).default;
const { generateKeyPair, unlockPrivateKey } = await import('../utils/pgp.js');
const { deriveKeySecret, keySecret, setKeySecret } = await import('../utils/pgpSecret.js');

const SALT = btoa(String.fromCharCode(...new Uint8Array(16).fill(4)));
const OLD = await deriveKeySecret('old password', SALT);
const NEW = await deriveKeySecret('new password', SALT);
const mine = await generateKeyPair({ email: 'me@example.com', passphrase: OLD });
const older = await generateKeyPair({ email: 'old@example.com', passphrase: 'an earlier password\'s secret' });
const KEY = { id: '00000000-0000-4000-8000-000000000001', fingerprint: mine.fingerprint, emails: ['me@example.com'], armoredPublic: mine.armoredPublic, armoredPrivate: mine.armoredPrivate, protection: 'login', stale: false };
const OLDER = { ...KEY, id: '00000000-0000-4000-8000-000000000002', fingerprint: older.fingerprint, emails: ['old@example.com'], armoredPublic: older.armoredPublic, armoredPrivate: older.armoredPrivate };

let keys = [KEY];
const changes = [];
const patches = [];
globalThis.fetch = async (url, init = {}) => {
  const path = String(url);
  const body = init.body ? JSON.parse(init.body) : null;
  const json = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
  if (path === '/api/pgp/keys' && (init.method || 'GET') === 'GET') return json({ keys });
  if (path === '/api/pgp/kdf') return json({ salt: SALT });
  if (path === '/api/pgp/verify-password') return json({ ok: body.password === 'old password', hasPassword: true });
  if (path === '/api/auth/password') { changes.push(body); return json({ ok: true }); }
  if (path.startsWith('/api/pgp/keys/') && init.method === 'PATCH') { patches.push([path, body]); return json({ ok: true }); }
  return json({});
};

const until = async (check, ms = 60000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out: ${document.body.textContent}`);
    await React.act(() => new Promise(r => setTimeout(r, 25)));
  }
};
const setValue = async (input, value) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  await React.act(async () => { setter.call(input, value); input.dispatchEvent(new window.Event('input', { bubbles: true })); });
};
const click = async (el) => React.act(async () => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
const button = text => [...document.querySelectorAll('button')].find(b => b.textContent === text);
async function fill(current) {
  await click(button('admin.password.change'));
  const field = label => document.querySelector(`input[aria-label="${label}"]`);
  await setValue(field('admin.password.current'), current);
  await setValue(field('admin.password.new'), 'new password');
  await setValue(field('admin.password.confirm'), 'new password');
  await React.act(async () => { document.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); });
}

test('a wrong current password stops before anything is re-encrypted or sent', async () => {
  useStore.setState({ user: { id: 'u1', hasPassword: true } });
  const root = createRoot(document.getElementById('root'));
  await React.act(async () => root.render(React.createElement(PasswordChangeSection)));
  await fill('not it');
  await until(() => document.body.textContent.includes('admin.password.wrongCurrent'));
  assert.equal(changes.length, 0);
  await React.act(async () => root.unmount());
});

test('the keys go re-encrypted with the new password, and the tab keeps the new secret', async () => {
  setKeySecret('u1', OLD, { verified: true });
  const root = createRoot(document.getElementById('root'));
  await React.act(async () => root.render(React.createElement(PasswordChangeSection)));
  await fill('old password');
  await until(() => document.body.textContent.includes('admin.password.saved'));
  assert.equal(changes.length, 1);
  assert.equal(changes[0].currentPassword, 'old password');
  assert.equal(changes[0].newPassword, 'new password');
  assert.deepEqual(changes[0].pgpKeys.map(k => k.id), [KEY.id]);
  await unlockPrivateKey(changes[0].pgpKeys[0].armoredPrivate, NEW);
  assert.equal(keySecret('u1'), NEW);
  await React.act(async () => root.unmount());
});

test('a key the current password does not open is named, and the change waits for the user', async () => {
  changes.length = 0;
  keys = [KEY, OLDER];
  const root = createRoot(document.getElementById('root'));
  await React.act(async () => root.render(React.createElement(PasswordChangeSection)));
  await fill('old password');
  await until(() => document.querySelector('[role="alertdialog"]'));
  assert.match(document.querySelector('[role="alertdialog"]').textContent, /old@example\.com/);
  assert.doesNotMatch(document.querySelector('[role="alertdialog"]').textContent, /me@example\.com/);
  assert.equal(changes.length, 0, 'nothing sent before the user decides');

  // Cancel: nothing changes.
  await click(button('common.cancel'));
  assert.equal(changes.length, 0);

  await fill('old password');
  await until(() => document.querySelector('[role="alertdialog"]'));
  await click(button('admin.password.continueAnyway'));
  await until(() => document.body.textContent.includes('admin.password.saved'));
  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0].pgpKeys.map(k => k.id), [KEY.id], 'the key that did not open is not sent');
  // It is marked stale, so it is no longer offered to others.
  assert.deepEqual(patches, [[`/api/pgp/keys/${OLDER.id}`, { stale: true }]]);
  await React.act(async () => root.unmount());
});
