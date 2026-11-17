// Render test for Settings → Mail → Out of office. Pins that the page says clearly when the
// server cannot send automatic replies, sends the reply as the routes take it, keeps the text of
// a reply that is turned off, and asks before replacing another active script.
//
// Same loader hooks as ServerFiltersSection.render.test.js.

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
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
globalThis.fetch = async (url, init = {}) => {
  const path = String(url);
  const method = init.method || 'GET';
  const body = init.body ? JSON.parse(init.body) : null;
  if (path === `/api/sieve/${ACCOUNT}` && method === 'GET') return json(server.status);
  if (path === `/api/sieve/${ACCOUNT}/vacation` && method === 'PUT') {
    if (server.otherActive && !body.replaceActive) return json({ error: 'active', code: 'other_active', active: server.otherActive }, 409);
    server.saved = body;
    return json({ ok: true, active: 'plimail' });
  }
  return json({ error: 'unexpected' }, 500);
};

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const { default: VacationSection, vacationPayload } = await import('./VacationSection.jsx');

const settle = () => React.act(async () => { await new Promise(r => setTimeout(r, 0)); });
const text = () => document.getElementById('root').textContent;
const buttonNamed = (label) => [...document.querySelectorAll('button')].find(b => b.textContent === label);
const field = id => document.getElementById(id);
async function click(el) { await React.act(async () => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); }); await settle(); }
async function type(el, value) {
  await React.act(async () => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}

const supported = (vacation = null, extra = {}) => ({
  supported: true, implementation: 'Dovecot Pigeonhole', extensions: ['fileinto', 'vacation', 'date', 'relational'],
  scripts: [], active: null, otherActive: null,
  plimail: { exists: !!vacation, managed: !!vacation, rules: [], vacation, content: null },
  ...extra,
});

let root;
beforeEach(() => {
  server = { status: supported() };
  useStore.setState({
    accounts: [{ id: ACCOUNT, email_address: 'alice@example.invalid', protocol: 'imap', oauth_provider: null, enabled: true }],
  });
});
afterEach(async () => {
  await React.act(async () => root?.unmount());
  root = null;
});

async function mount() {
  root = createRoot(document.getElementById('root'));
  await React.act(async () => { root.render(React.createElement(VacationSection)); });
  await settle();
  await settle();
}

test('says plainly when the server has no Sieve, and offers no form', async () => {
  server.status = { supported: false, reason: 'unreachable' };
  await mount();
  assert.match(text(), /admin\.vacation\.needsSieve/);
  assert.match(text(), /admin\.serverFilters\.reasonUnreachable/);
  assert.equal(buttonNamed('admin.vacation.save'), undefined);
});

test('says so when the server has Sieve but no automatic replies', async () => {
  server.status = supported(null, { extensions: ['fileinto'] });
  await mount();
  assert.match(text(), /admin\.vacation\.noVacationExtension/);
  assert.equal(buttonNamed('admin.vacation.save'), undefined);
});

test('turns the reply on with its dates and other addresses', async () => {
  await mount();
  assert.match(text(), /admin\.vacation\.off/);
  await click(document.querySelector('input[type="checkbox"]'));
  await type(field('vacation-subject'), 'Away');
  await type(field('vacation-body'), 'Back on the 4th.');
  await type(field('vacation-start'), '2026-12-20');
  await type(field('vacation-end'), '2027-01-04');
  await type(field('vacation-addresses'), 'alias@example.invalid, other@example.invalid');
  await click(buttonNamed('admin.vacation.save'));
  assert.deepEqual(server.saved, { vacation: {
    enabled: true, subject: 'Away', body: 'Back on the 4th.', start: '2026-12-20', end: '2027-01-04', days: 7,
    addresses: ['alias@example.invalid', 'other@example.invalid'],
  } });
  assert.match(text(), /admin\.vacation\.savedOn/);
});

test('shows a saved reply as on, and turning it off keeps its text', async () => {
  const vacation = { enabled: true, subject: '', body: 'Away', start: null, end: null, days: 3, addresses: [] };
  server.status = supported(vacation, { active: 'plimail', scripts: [{ name: 'plimail', active: true }] });
  await mount();
  assert.match(text(), /admin\.vacation\.on/);
  assert.equal(field('vacation-body').value, 'Away');
  await click(document.querySelector('input[type="checkbox"]'));
  await click(buttonNamed('admin.vacation.save'));
  assert.deepEqual(server.saved.vacation, { ...vacation, enabled: false });
});

test('hides the dates when the server cannot use them', async () => {
  server.status = supported(null, { extensions: ['vacation'] });
  await mount();
  assert.equal(field('vacation-start'), null);
  assert.match(text(), /admin\.vacation\.noDates/);
});

test('asks before replacing another active script', async () => {
  server.otherActive = 'roundcube';
  await mount();
  await click(document.querySelector('input[type="checkbox"]'));
  await type(field('vacation-body'), 'Away');
  await click(buttonNamed('admin.vacation.save'));
  assert.equal(server.saved, undefined);
  assert.match(document.querySelector('[role="alertdialog"]').textContent, /confirmReplaceActive:\{"active":"roundcube"\}/);
  await click(buttonNamed('admin.serverFilters.replaceActive'));
  assert.equal(server.saved.replaceActive, true);
});

test('sends empty dates as none and splits the addresses', () => {
  assert.deepEqual(vacationPayload({ enabled: false, subject: '', body: '', start: '', end: '', days: '5', addresses: ' a@x.invalid;b@x.invalid  ' }), {
    enabled: false, subject: '', body: '', start: null, end: null, days: 5, addresses: ['a@x.invalid', 'b@x.invalid'],
  });
});
