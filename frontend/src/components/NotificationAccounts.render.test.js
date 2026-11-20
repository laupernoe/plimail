// Render test for the per-mailbox notification switches in Settings > Notifications: each one
// writes notifications_muted for its own account only, and a failed save leaves it as it was.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('react-i18next/dist/es/index.js') || url.endsWith('/react-i18next')) {
      return { format: 'module', shortCircuit: true, source: [
        'const t = (k, o) => (o && typeof o === "object" && Object.keys(o).length ? `${k}:${JSON.stringify(o)}` : k);',
        'export const useTranslation = () => ({ t, i18n: { language: "en", changeLanguage: () => {} } });',
        'export const initReactI18next = { type: "3rdParty", init: () => {} };',
        'export const Trans = ({ children }) => children ?? null;',
        'export const I18nextProvider = ({ children }) => children ?? null;',
        'export default { useTranslation, initReactI18next };',
      ].join('\n') };
    }
    if (url.endsWith('.json')) {
      return { format: 'module', shortCircuit: true, source: `export default ${readFileSync(new URL(url), 'utf8')}` };
    }
    const shimViteEnv = (code) => code.replaceAll('import.meta.env', 'globalThis.__VITE_ENV__');
    if (url.endsWith('.jsx')) {
      const out = transform(readFileSync(new URL(url), 'utf8'), { transforms: ['jsx'], jsxRuntime: 'automatic', filePath: url });
      return { format: 'module', shortCircuit: true, source: shimViteEnv(out.code) };
    }
    if (url.startsWith('file:') && url.endsWith('.js')) {
      const code = readFileSync(new URL(url), 'utf8');
      if (code.includes('import.meta.env')) return { format: 'module', shortCircuit: true, source: shimViteEnv(code) };
    }
    return nextLoad(url, context);
  },
});

const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid', pretendToBeVisual: true });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document,
  localStorage: dom.window.localStorage, CustomEvent: dom.window.CustomEvent,
  Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
  getComputedStyle: dom.window.getComputedStyle, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
dom.window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
dom.window.Element.prototype.scrollIntoView = () => {};
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' });

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const { api } = await import('../utils/api.js');
const NotificationAccounts = (await import('./NotificationAccounts.jsx')).default;

let root = null;
async function mount(accounts) {
  useStore.setState({ accounts });
  root = createRoot(document.getElementById('root'));
  await React.act(async () => { root.render(React.createElement(NotificationAccounts)); });
}
afterEach(async () => {
  if (root) await React.act(async () => root.unmount());
  root = null;
});
const buttons = () => [...document.querySelectorAll('[data-testid="notification-account"] button')];

test('lists every mailbox, on unless muted, and muting one writes only that account', async () => {
  const sent = [];
  api.updateAccount = async (id, data) => { sent.push([id, data]); return {}; };
  await mount([
    { id: 'a', name: 'Work', email_address: 'w@example.invalid', notifications_muted: false },
    { id: 'b', name: 'Home', email_address: 'h@example.invalid' },
  ]);
  assert.deepEqual(buttons().map(b => b.getAttribute('aria-pressed')), ['true', 'true']);
  await React.act(async () => { buttons()[1].click(); });
  assert.deepEqual(sent, [['b', { notifications_muted: true }]]);
  assert.deepEqual(buttons().map(b => b.getAttribute('aria-pressed')), ['true', 'false']);
  await React.act(async () => { buttons()[1].click(); });
  assert.deepEqual(sent[1], ['b', { notifications_muted: false }]);
  assert.equal(buttons()[1].getAttribute('aria-pressed'), 'true');
});

test('a failed save is reported and the switch stays as it was', async () => {
  api.updateAccount = async () => { throw new Error('nope'); };
  await mount([{ id: 'a', name: 'Work', email_address: 'w@example.invalid' }]);
  await React.act(async () => { buttons()[0].click(); });
  assert.equal(buttons()[0].getAttribute('aria-pressed'), 'true');
  assert.match(document.body.textContent, /nope/);
});
