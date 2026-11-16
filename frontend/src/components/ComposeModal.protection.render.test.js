import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { setImmediate } from 'node:timers';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';

registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith('react-i18next/dist/es/index.js') || url.endsWith('/react-i18next')) {
    return { format: 'module', shortCircuit: true, source: [
      'export const useTranslation = () => ({ t: (key) => key, i18n: { language: "en", changeLanguage: () => {} } });',
      'export const initReactI18next = { type: "3rdParty", init: () => {} };',
      'export const Trans = ({ children }) => children ?? null;',
      'export const I18nextProvider = ({ children }) => children ?? null;',
      'export default { useTranslation, initReactI18next };',
    ].join('\n') };
  }
  if (url.endsWith('.json')) return { format: 'module', shortCircuit: true,
    source: `export default ${readFileSync(new URL(url), 'utf8')}` };
  if (url.endsWith('.jsx')) {
    const code = transform(readFileSync(new URL(url), 'utf8'), {
      transforms: ['jsx'], jsxRuntime: 'automatic', filePath: url,
    }).code;
    return { format: 'module', shortCircuit: true, source: code.replaceAll('import.meta.env', 'globalThis.__VITE_ENV__') };
  }
  if (url.startsWith('file:') && url.endsWith('.js')) {
    const code = readFileSync(new URL(url), 'utf8');
    if (code.includes('import.meta.env')) return { format: 'module', shortCircuit: true,
      source: code.replaceAll('import.meta.env', 'globalThis.__VITE_ENV__') };
  }
  return nextLoad(url, context);
} });

const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid', pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document,
  localStorage: dom.window.localStorage,
  CustomEvent: dom.window.CustomEvent, Node: dom.window.Node, Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement, DOMParser: dom.window.DOMParser,
  MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IS_REACT_ACT_ENVIRONMENT: true, __VITE_ENV__: { MODE: 'test', PROD: true } });
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.matchMedia = dom.window.matchMedia;
globalThis.requestAnimationFrame = cb => setTimeout(() => cb(Date.now()), 0);
globalThis.cancelAnimationFrame = id => clearTimeout(id);

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const ComposeModal = (await import('./ComposeModal.jsx')).default;


// A protected message put back in the composer (undone send, failed held send, the screen lock)
// must reopen protected. It reopened plain, and Send then delivered it in the clear.

const OWN_KEY = { id: 'k1', fingerprint: 'ab'.repeat(20), emails: ['on@example.test'], armoredPublic: 'x', armoredPrivate: 'y' };
globalThis.fetch = async (url) => {
  const path = String(url);
  if (path === '/api/pgp/keys') return { ok: true, status: 200, json: async () => ({ keys: [OWN_KEY] }) };
  if (path === '/api/pgp/lookup') return { ok: true, status: 200, json: async () => ({ results: {} }) };
  return { ok: true, status: 200, json: async () => ({}) };
};
const ACCOUNTS = [{ id: 'on', email_address: 'on@example.test', aliases: [], signature: '', signature_enabled: false }];
const click = el => React.act(async () => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
const settle = () => React.act(async () => { for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)); });
const lock = () => document.querySelector('button[aria-label="compose.secure.toggle"]');
const radio = key => [...document.querySelectorAll('button[role="radio"]')].find(b => b.textContent === key);
async function mount(composeData) {
  useStore.setState({ accounts: ACCOUNTS, plaintextEmail: true, composing: true, prepareComposeSwitch: null, composeData, composeSession: 1 });
  const root = createRoot(document.getElementById('root'));
  await React.act(async () => root.render(React.createElement(ComposeModal)));
  await settle();
  return root;
}
const unmount = root => React.act(async () => root.unmount());

test('a restored encrypted message reopens with PGP on', async () => {
  const root = await mount({ accountId: 'on', to: ['bob@example.net'], subject: 's', body: 'hi', restored: true, protection: { mode: 'pgp', sign: false } });
  try {
    assert.equal(lock().getAttribute('aria-pressed'), 'true');
    assert.equal(radio('pgp.compose.modePgp').getAttribute('aria-checked'), 'true');
    const sign = [...document.querySelectorAll('label')].find(l => l.textContent.includes('pgp.compose.sign'))?.querySelector('input');
    assert.equal(sign.checked, false);
  } finally { await unmount(root); }
});

test('a restored password-protected message reopens in that mode, asking for the password again', async () => {
  const root = await mount({ accountId: 'on', to: ['bob@example.net'], subject: 's', body: 'hi', restored: true, protection: { mode: 'password', expiresInDays: 30 } });
  try {
    assert.equal(lock().getAttribute('aria-pressed'), 'true');
    assert.equal(radio('pgp.compose.modePassword').getAttribute('aria-checked'), 'true');
    const passwords = [...document.querySelectorAll('input[type="password"]')];
    assert.ok(passwords.length >= 2);
    assert.ok(passwords.every(i => i.value === ''));
  } finally { await unmount(root); }
});

test('the screen lock keeps the mode for the composer that reopens, never the passphrase', async () => {
  const root = await mount({ accountId: 'on', to: ['bob@example.net'], subject: 's', body: 'hi' });
  try {
    await click(lock());
    await settle();
    assert.equal(radio('pgp.compose.modePgp').getAttribute('aria-checked'), 'true');
    await React.act(async () => { window.dispatchEvent(new window.CustomEvent('mailflow:will-lock')); });
    const kept = useStore.getState().composeData;
    assert.deepEqual(kept.protection, { mode: 'pgp', sign: true });
    assert.ok(!JSON.stringify(kept).includes('passphrase'));
  } finally { await unmount(root); }
});

test('an unprotected message stays unprotected', async () => {
  const root = await mount({ accountId: 'on', to: ['bob@example.net'], subject: 's', body: 'hi', restored: true });
  try {
    assert.equal(lock().getAttribute('aria-pressed'), 'false');
    await React.act(async () => { window.dispatchEvent(new window.CustomEvent('mailflow:will-lock')); });
    assert.equal(useStore.getState().composeData.protection, null);
  } finally { await unmount(root); }
});
