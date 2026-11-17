// Render test for "Sign in with a passkey" on the sign-in page. A passkey sign-in gives no
// password, so it must not derive the OpenPGP key secret from whatever the password field holds:
// a secret derived from a half-typed password would be kept as the real one and open nothing.
// The first key needed afterwards asks for the password in the unlock prompt instead. Also pinned:
// where passkeys cannot work (an IP address), the button is off and says why.
//
// @simplewebauthn/browser is stubbed in the loader: there is no authenticator in jsdom.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@simplewebauthn/browser') return { url: 'stub:simplewebauthn', shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === 'stub:simplewebauthn') {
      return { format: 'module', shortCircuit: true, source: [
        'export const browserSupportsWebAuthn = () => true;',
        'export const browserSupportsWebAuthnAutofill = async () => false;',
        'export const startAuthentication = async (opts) => globalThis.__passkeyStart(opts);',
        'export const startRegistration = async () => { throw new Error("not in this test"); };',
        'export const WebAuthnAbortService = { cancelCeremony() {} };',
      ].join('\n') };
    }
    if (url.endsWith('react-i18next/dist/es/index.js') || url.endsWith('/react-i18next')) {
      return { format: 'module', shortCircuit: true, source: [
        // One t for every render, as react-i18next's: LoginPage's first effect depends on it.
        'const t = (k, o) => (o ? k + " " + JSON.stringify(o) : k);',
        'const i18n = { language: "en", changeLanguage: () => {} };',
        'export const useTranslation = () => ({ t, i18n });',
        'export const initReactI18next = { type: "3rdParty", init: () => {} };',
        'export const Trans = ({ children }) => children ?? null;',
        'export default { useTranslation, initReactI18next };',
      ].join('\n') };
    }
    if (url.endsWith('.json')) {
      return { format: 'module', shortCircuit: true, source: `export default ${readFileSync(new URL(url), 'utf8')}` };
    }
    const shimViteEnv = (code) => code.replaceAll('import.meta.env', 'globalThis.__VITE_ENV__');
    const path = url.split('?')[0];
    if (path.endsWith('.jsx')) {
      const out = transform(readFileSync(new URL(path), 'utf8'), { transforms: ['jsx'], jsxRuntime: 'automatic', filePath: path });
      return { format: 'module', shortCircuit: true, source: shimViteEnv(out.code) };
    }
    if (url.startsWith('file:') && url.endsWith('.js')) {
      const code = readFileSync(new URL(url), 'utf8');
      if (code.includes('import.meta.env')) return { format: 'module', shortCircuit: true, source: shimViteEnv(code) };
    }
    return nextLoad(url, context);
  },
});

const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.com/login', pretendToBeVisual: true });
Object.defineProperty(dom.window, 'isSecureContext', { value: true });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document,
  localStorage: dom.window.localStorage, sessionStorage: dom.window.sessionStorage,
  CustomEvent: dom.window.CustomEvent, Node: dom.window.Node, Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement, getComputedStyle: dom.window.getComputedStyle,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
  IS_REACT_ACT_ENVIRONMENT: true,
});
globalThis.requestAnimationFrame ??= cb => setTimeout(() => cb(Date.now()), 0);
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };

const USER = { id: 'u-alice', username: 'alice', isAdmin: false, totpEnabled: true };
let status;
let calls;
const json = (body, code = 200) => new Response(JSON.stringify(body), { status: code });
globalThis.fetch = async (url, init = {}) => {
  const path = String(url);
  const method = init.method || 'GET';
  calls.push(`${method} ${path}`);
  if (path === '/api/passkeys/status') return json(status);
  if (path === '/api/passkeys/login/options') return json({ options: { challenge: 'abc', rpId: 'mail.example.com' } });
  if (path === '/api/passkeys/login/verify') return json({ user: USER });
  if (path === '/api/auth/registration-status') return json({ open: false, internalAuthDisabled: false });
  if (path === '/api/auth/oidc/providers') return json({ providers: [] });
  if (path === '/api/auth/preferences') return json({ preferences: {} });
  if (path === '/api/pgp/kdf') return json({ salt: 'c2FsdHNhbHRzYWx0c2FsdHNhbHQ=' });
  return json({});
};
globalThis.__passkeyStart = async () => ({ id: 'cred', response: {} });

const { default: React, act } = await import("react");
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const { STORAGE_KEY, keySecret } = await import('../utils/pgpSecret.js');
const { currentUnlockRequest, ensureKeySecret, cancelUnlock } = await import('../utils/pgpUnlock.js');
const { default: LoginPage } = await import('./LoginPage.jsx');

const host = document.getElementById('root');
let root;
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });
const until = async (check, what) => {
  for (let i = 0; i < 60; i++) { if (check()) return; await flush(); }
  assert.fail(`timed out waiting for ${what}; page shows: ${host.textContent}`);
};
const passkeyButton = () => [...host.querySelectorAll('button')].find(b => b.textContent.includes('passkeys.signIn'));
async function type(input, value) {
  const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
  await act(async () => { setValue.call(input, value); input.dispatchEvent(new dom.window.Event('input', { bubbles: true })); });
}

beforeEach(async () => {
  calls = [];
  status = { available: true, rpId: 'mail.example.com' };
  sessionStorage.clear();
  useStore.setState({ user: null });
  root = createRoot(host);
  await act(async () => { root.render(React.createElement(LoginPage)); });
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
});

test('a passkey sign-in signs in without deriving the key secret from the password field', async () => {
  await until(() => passkeyButton(), 'the passkey button');
  // Something half-typed in the password field, then the passkey instead.
  await type(host.querySelector('input[type="password"]'), 'half-typ');
  await act(async () => { passkeyButton().dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
  await until(() => useStore.getState().user?.id === USER.id, 'the signed-in user');
  await flush();
  assert.ok(calls.includes('POST /api/passkeys/login/verify'));
  assert.ok(!calls.includes('GET /api/pgp/kdf'), 'no key secret was derived');
  assert.equal(sessionStorage.getItem(STORAGE_KEY), null);
  assert.equal(keySecret(USER.id), null);

  // The first key needed asks for the password.
  const pending = ensureKeySecret(USER.id);
  await flush();
  assert.ok(currentUnlockRequest(), 'the unlock prompt is requested');
  cancelUnlock();
  await assert.rejects(pending, err => err?.code === 'unlockCancelled');
});

test('at an IP address the button is off and says why', async () => {
  await act(async () => { root.unmount(); });
  status = { available: false, reason: 'ip' };
  root = createRoot(host);
  await act(async () => { root.render(React.createElement(LoginPage)); });
  await until(() => passkeyButton(), 'the passkey button');
  assert.equal(passkeyButton().disabled, true);
  assert.ok(host.textContent.includes('passkeys.blocked.ip'));
  assert.ok(!calls.includes('POST /api/passkeys/login/options'));
});
