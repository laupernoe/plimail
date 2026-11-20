// The /compose route: App draws the composer window alone (ComposePopup), not the mailbox.
//
// Same loader hooks as App.render.test.js, with MailApp, LoginPage and ComposePopup stubbed: the
// question is only which screen App picks for the path.

import { test, describe, afterEach } from 'node:test';
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
    if (url.endsWith('/components/MailApp.jsx')) {
      return { format: 'module', shortCircuit: true, source: 'export default function MailApp() { return "MAIL_APP"; }' };
    }
    if (url.endsWith('/components/ComposePopup.jsx')) {
      return { format: 'module', shortCircuit: true, source: 'export default function ComposePopup() { return "COMPOSE_POPUP"; }' };
    }
    if (url.endsWith('/components/LoginPage.jsx')) {
      return { format: 'module', shortCircuit: true, source: 'export default function LoginPage() { return "LOGIN_PAGE"; }' };
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

// The page sits at /login, where Sign out sends the browser. jsdom cannot load another page and
// reports any navigation to one, but a navigation to the page it is on does nothing.
const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid/compose', pretendToBeVisual: true });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document,
  localStorage: dom.window.localStorage, CustomEvent: dom.window.CustomEvent,
  Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
  // applyTheme rasterises the favicon during boot.
  Image: dom.window.Image,
  getComputedStyle: dom.window.getComputedStyle, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };

// Every request, as "METHOD /path". /api/auth/me answers as the test scripts it; anything else
// succeeds, unless the network is down.
const calls = [];
let meResponse;
let offline = false;
globalThis.fetch = async (url, opts = {}) => {
  calls.push(`${opts.method || 'GET'} ${url}`);
  if (offline) throw new TypeError('Failed to fetch');
  if (url === '/api/auth/me') return meResponse();
  return { ok: true, status: 200, json: async () => ({ ok: true }) };
};

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { MemoryRouter } = await import('react-router-dom');
const { useStore } = await import('./store/index.js');
const App = (await import('./App.jsx')).default;

const user = { id: 7, username: 'matt' };
const settle = () => React.act(async () => { await new Promise(r => setTimeout(r, 30)); });

let root = null;
async function mountAt(path, me) {
  meResponse = me;
  useStore.setState({ user: null, isLocked: false });
  root = createRoot(document.getElementById('root'));
  await React.act(async () => { root.render(React.createElement(MemoryRouter, { initialEntries: [path] }, React.createElement(App))); });
  await settle();
  return document.getElementById('root').textContent;
}
afterEach(async () => { const r = root; root = null; if (r) await React.act(async () => r.unmount()); });

describe('the /compose route', () => {
  const signedIn = () => ({ ok: true, status: 200, json: async () => ({ user }) });
  const signedOut = () => ({ ok: false, status: 401, json: async () => ({ error: 'Not authenticated' }) });

  test('shows the composer alone, not the mailbox', async () => {
    const text = await mountAt('/compose', signedIn);
    assert.ok(text.includes('COMPOSE_POPUP'));
    assert.ok(!text.includes('MAIL_APP'));
  });

  test('the mailbox is still at /', async () => {
    const text = await mountAt('/', signedIn);
    assert.ok(text.includes('MAIL_APP'));
    assert.ok(!text.includes('COMPOSE_POPUP'));
  });

  test('signed out, it goes to the login page', async () => {
    const text = await mountAt('/compose', signedOut);
    assert.ok(text.includes('LOGIN_PAGE'));
    assert.ok(!text.includes('COMPOSE_POPUP'));
  });

  test('locked, the lock screen comes first', async () => {
    meResponse = () => ({ ok: true, status: 200, json: async () => ({ user: { ...user, locked: true } }) });
    const text = await mountAt('/compose', meResponse);
    assert.ok(text.includes('lockScreen.unlockButton'));
    assert.ok(!text.includes('COMPOSE_POPUP'));
  });
});
