// ComposePopup, the /compose window: it opens a blank composer, opens no socket, and goes once the
// message is out of its hands (closed, and no send still in its undo window).
// The composer and the toasts are stubbed; the question is only what the window does around them.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('react-i18next/dist/es/index.js') || url.endsWith('/react-i18next')) {
      return { format: 'module', shortCircuit: true, source: [
        'export const useTranslation = () => ({ t: (k) => k, i18n: { language: "en", changeLanguage: () => {} } });',
        'export const initReactI18next = { type: "3rdParty", init: () => {} };',
        'export const Trans = ({ children }) => children ?? null;',
        'export const I18nextProvider = ({ children }) => children ?? null;',
        'export default { useTranslation, initReactI18next };',
      ].join('\n') };
    }
    if (url.endsWith('/components/ComposeModal.jsx')) {
      return { format: 'module', shortCircuit: true, source: 'export default function ComposeModal() { return "COMPOSER"; }' };
    }
    if (url.endsWith('/components/NotificationToasts.jsx')) {
      return { format: 'module', shortCircuit: true, source: 'export default function NotificationToasts() { return null; }' };
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

const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid/compose?account=acc2', pretendToBeVisual: true });
const closed = [];
dom.window.close = () => { closed.push(Date.now()); };
let sockets = 0;
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
  CustomEvent: dom.window.CustomEvent, Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  IS_REACT_ACT_ENVIRONMENT: true,
  WebSocket: class { constructor() { sockets++; } },
});
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };

const requests = [];
let accountsResponse;
globalThis.fetch = async (url, opts = {}) => {
  requests.push(`${opts.method || 'GET'} ${url}`);
  if (url === '/api/accounts') return accountsResponse();
  return { ok: true, status: 200, json: async () => ({}) };
};

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const ComposePopup = (await import('./ComposePopup.jsx')).default;

const accounts = [{ id: 'acc1', email_address: 'a@x.test' }, { id: 'acc2', email_address: 'b@x.test' }];
const settle = (ms = 60) => React.act(async () => { await new Promise(r => setTimeout(r, ms)); });
const text = () => document.getElementById('root').textContent;

describe('ComposePopup', () => {
  let root;
  beforeEach(async () => {
    closed.length = 0; requests.length = 0; sockets = 0;
    accountsResponse = () => ({ ok: true, status: 200, json: async () => accounts });
    useStore.setState({ user: { id: 7 }, composing: false, composeSession: 0, composeData: null, notifications: [], selectedAccountId: null });
    root = createRoot(document.getElementById('root'));
    await React.act(async () => root.render(React.createElement(ComposePopup)));
    await settle();
  });
  afterEach(async () => { await React.act(async () => root.unmount()); });

  test('loads the accounts, opens a blank composer on the account asked for, and opens no socket', async () => {
    assert.ok(requests.includes('GET /api/accounts'));
    assert.ok(text().includes('COMPOSER'));
    assert.equal(useStore.getState().composing, true);
    assert.equal(useStore.getState().selectedAccountId, 'acc2');
    assert.equal(sockets, 0);
    assert.equal(requests.filter(r => r !== 'GET /api/accounts').length, 0);
  });

  test('stays open while the composer is', async () => {
    await settle(1500);
    assert.equal(closed.length, 0);
  });

  test('closes itself once the composer is closed', async () => {
    await React.act(async () => useStore.getState().closeCompose());
    await settle(1600);
    assert.equal(closed.length, 1);
  });

  test('a sent message still in its undo window keeps the window, and the composer coming back does too', async () => {
    await React.act(async () => {
      useStore.getState().closeCompose();
      useStore.setState({ notifications: [{ id: 'n1', heldSendId: 'p1', onUndo: () => {} }] });
    });
    await settle(1600);
    assert.equal(closed.length, 0);
    await React.act(async () => useStore.setState({ notifications: [] }));
    await settle(1600);
    assert.equal(closed.length, 1);
  });
});
