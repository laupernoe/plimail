// Render test for Settings → Mail → Server filters. Pins that the page says whether the server
// has Sieve, shows which script is active, warns when another one is, saves rules only after the
// user confirms replacing the active script, and asks before overwriting a script Plimail did
// not write.
//
// Same loader hooks as ScheduledList.render.test.js.

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
  IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };

const ACCOUNT = '00000000-0000-4000-8000-000000000001';
let server;
const calls = [];
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
globalThis.fetch = async (url, init = {}) => {
  const path = String(url);
  const method = init.method || 'GET';
  const body = init.body ? JSON.parse(init.body) : null;
  calls.push({ path, method, body });
  if (path === `/api/accounts/${ACCOUNT}/folders`) return json([{ path: 'INBOX' }, { path: 'Invoices' }]);
  if (path === `/api/sieve/${ACCOUNT}` && method === 'GET') return json(server.status);
  if (path === `/api/sieve/${ACCOUNT}/rules` && method === 'PUT') {
    if (server.otherActive && !body.replaceActive && body.activate !== false) {
      return json({ error: 'active', code: 'other_active', active: server.otherActive }, 409);
    }
    server.saved = body;
    return json({ ok: true, active: 'plimail' });
  }
  if (path === `/api/sieve/${ACCOUNT}/scripts/roundcube` && method === 'GET') return json({ name: 'roundcube', content: 'keep;' });
  if (path === `/api/sieve/${ACCOUNT}/scripts/roundcube` && method === 'PUT') {
    if (!body.overwrite) return json({ error: 'not ours', code: 'not_plimail', name: 'roundcube' }, 409);
    server.rawSaved = body;
    return json({ ok: true });
  }
  return json({ error: 'unexpected' }, 500);
};

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const { default: ServerFiltersSection, sieveAccounts } = await import('./ServerFiltersSection.jsx');

const settle = () => React.act(async () => { await new Promise(r => setTimeout(r, 0)); });
const text = () => document.getElementById('root').textContent;
const buttonNamed = (label) => [...document.querySelectorAll('button')].find(b => b.textContent === label);
async function click(el) { await React.act(async () => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); }); await settle(); }
async function type(el, value) {
  await React.act(async () => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new window.Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  });
}

let root;
beforeEach(() => {
  calls.length = 0;
  server = {
    otherActive: 'roundcube',
    status: {
      supported: true, implementation: 'Dovecot Pigeonhole', extensions: ['fileinto', 'imap4flags'],
      scripts: [{ name: 'roundcube', active: true }], active: 'roundcube', otherActive: 'roundcube',
      plimail: { exists: false, managed: false, rules: [], content: null },
    },
  };
  useStore.setState({
    accounts: [{ id: ACCOUNT, email_address: 'alice@example.invalid', protocol: 'imap', oauth_provider: null, enabled: true }],
    folders: {},
  });
});
afterEach(async () => {
  await React.act(async () => root?.unmount());
  root = null;
});

async function mount() {
  root = createRoot(document.getElementById('root'));
  await React.act(async () => { root.render(React.createElement(ServerFiltersSection)); });
  await settle();
  await settle();
}

test('leaves out OAuth and POP accounts, which cannot log in to ManageSieve with a password', () => {
  const list = sieveAccounts([
    { id: 'a', protocol: 'imap', oauth_provider: null },
    { id: 'b', protocol: 'imap', oauth_provider: 'google' },
    { id: 'c', protocol: 'pop3', oauth_provider: null },
  ]);
  assert.deepEqual(list.map(a => a.id), ['a']);
});

test('says Sieve is available, which script is active, and warns that another one is', async () => {
  await mount();
  assert.match(text(), /admin\.serverFilters\.supported/);
  assert.match(text(), /Dovecot Pigeonhole/);
  assert.match(text(), /admin\.serverFilters\.otherActiveWarning:\{"active":"roundcube"\}/);
  assert.match(text(), /roundcubeadmin\.serverFilters\.active/);
});

test('says when the server has no Sieve', async () => {
  server.status = { supported: false, reason: 'unreachable' };
  await mount();
  assert.match(text(), /admin\.serverFilters\.unsupported/);
  assert.match(text(), /admin\.serverFilters\.reasonUnreachable/);
  assert.equal(buttonNamed('admin.serverFilters.saveRules'), undefined);
});

test('saves a rule only after the user confirms replacing the active script', async () => {
  await mount();
  await click(buttonNamed('admin.serverFilters.addRule'));
  await type(document.querySelector('input[aria-label="admin.serverFilters.containsLabel"]'), 'invoice');
  await type(document.querySelector('select[aria-label="admin.serverFilters.folderLabel"]'), 'Invoices');
  await click(buttonNamed('admin.serverFilters.saveRules'));
  assert.equal(server.saved, undefined);
  assert.ok(document.querySelector('[role="alertdialog"]'));
  assert.match(document.querySelector('[role="alertdialog"]').textContent, /confirmReplaceActive:\{"active":"roundcube"\}/);

  await click(buttonNamed('admin.serverFilters.replaceActive'));
  assert.deepEqual(server.saved, {
    rules: [{ field: 'from', contains: 'invoice', action: 'move', folder: 'Invoices', address: '' }],
    replaceActive: true,
  });
});

test('can save the rules without activating them, leaving the other script running', async () => {
  await mount();
  await click(buttonNamed('admin.serverFilters.addRule'));
  await type(document.querySelector('input[aria-label="admin.serverFilters.containsLabel"]'), 'boss');
  await type(document.querySelector('select[aria-label="admin.serverFilters.actionLabel"]'), 'markRead');
  await click(buttonNamed('admin.serverFilters.saveRules'));
  await click(buttonNamed('admin.serverFilters.saveInactive'));
  assert.equal(server.saved.activate, false);
  assert.equal(server.saved.replaceActive, undefined);
});

test('asks before saving over a script Plimail did not write', async () => {
  await mount();
  await click(buttonNamed('admin.serverFilters.rawTab'));
  await type(document.querySelector('select[aria-label="admin.serverFilters.scriptLabel"]'), 'roundcube');
  await settle();
  assert.equal(document.querySelector('textarea').value, 'keep;');
  await click(buttonNamed('admin.serverFilters.saveScript'));
  assert.equal(server.rawSaved, undefined);
  assert.match(document.querySelector('[role="alertdialog"]').textContent, /confirmOverwrite:\{"name":"roundcube"\}/);
  await click(buttonNamed('admin.serverFilters.overwrite'));
  assert.equal(server.rawSaved.overwrite, true);
  assert.equal(server.rawSaved.content, 'keep;');
});
