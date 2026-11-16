// Render test for the unlock prompt (PgpUnlockPrompt.jsx): keys protected under an earlier
// password are moved to the password the server confirms in this same dialog, never to a secret
// the tab still held (another tab may have changed the password since). Same loader hooks as
// ComposeModal.protection.render.test.js.
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
const PgpUnlockPrompt = (await import('./PgpUnlockPrompt.jsx')).default;
const { generateKeyPair, unlockPrivateKey } = await import('../utils/pgp.js');
const { deriveKeySecret, setKeySecret, keySecret } = await import('../utils/pgpSecret.js');
const { requestKeyUnlock } = await import('../utils/pgpUnlock.js');

const SALT = btoa(String.fromCharCode(...new Uint8Array(16).fill(9)));
const OLD = await deriveKeySecret('old password', SALT);
const NEW = await deriveKeySecret('new password', SALT);
const pair = await generateKeyPair({ email: 'me@example.com', passphrase: OLD });
const KEY = { id: '00000000-0000-4000-8000-000000000001', fingerprint: pair.fingerprint, emails: ['me@example.com'], armoredPublic: pair.armoredPublic, armoredPrivate: pair.armoredPrivate, protection: 'login', stale: true };

const puts = [];
globalThis.fetch = async (url, init = {}) => {
  const path = String(url);
  const body = init.body ? JSON.parse(init.body) : null;
  const json = data => ({ ok: true, status: 200, json: async () => data });
  if (path === '/api/pgp/keys' && (init.method || 'GET') === 'GET') return json({ keys: [KEY] });
  if (path === '/api/pgp/kdf') return json({ salt: SALT });
  if (path === '/api/pgp/verify-password') return json({ ok: body.password === 'new password', hasPassword: true });
  if (path === '/api/pgp/keys/protection') { puts.push(body); return json({ updated: body.keys.length }); }
  return json({});
};

const until = async (check, ms = 30000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out: ${document.body.textContent}`);
    await React.act(() => new Promise(r => setTimeout(r, 25)));
  }
};
const type = async (value) => {
  const input = document.querySelector('form[role="dialog"] input[type="password"]');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  await React.act(async () => { setter.call(input, value); input.dispatchEvent(new window.Event('input', { bubbles: true })); });
  await React.act(async () => { document.querySelector('form[role="dialog"]').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); });
};

test('recovering keys asks the current password first, and moves them to the one the server confirmed', async () => {
  useStore.setState({ user: { id: 'u1', hasPassword: true } });
  // This tab still holds the old password's secret, marked verified: the password was changed in
  // another tab. Moving the keys "to" it would move them to the old password again.
  setKeySecret('u1', OLD, { verified: true });
  const root = createRoot(document.getElementById('root'));
  await React.act(async () => root.render(React.createElement(PgpUnlockPrompt)));
  let done = false;
  await React.act(async () => { requestKeyUnlock({ stale: true }).then(() => { done = true; }); });
  await until(() => document.body.textContent.includes('pgp.unlock.staleBody'));

  await type('wrong');
  await until(() => document.body.textContent.includes('pgp.unlock.wrongPassword'));
  await type('new password');
  await until(() => document.body.textContent.includes('pgp.unlock.previousBody'));
  await type('old password');
  await until(() => done);

  assert.equal(puts.length, 1);
  const [moved] = puts[0].keys;
  await unlockPrivateKey(moved.armoredPrivate, NEW);
  await assert.rejects(unlockPrivateKey(moved.armoredPrivate, OLD), { code: 'wrongPassphrase' });
  assert.equal(keySecret('u1'), NEW, 'the tab now holds the current password\'s secret');
  await React.act(async () => root.unmount());
});
