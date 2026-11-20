// Render test for Settings → Mail → Signatures. Pins that the library lists each signature with
// the addresses using it, that creating, duplicating and deleting (only once confirmed) go to the
// server, and that an account or alias is assigned a signature, after which the accounts, which
// carry the copy the composer starts with, are fetched again.
//
// Same loader hooks as SecureMessagesSection.render.test.js, plus JSON for the store's imports.

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
        'export const useTranslation = () => ({ t: (k, o) => (o ? k + " " + JSON.stringify(o) : k), i18n: { language: "en", changeLanguage: () => {} } });',
        'export const initReactI18next = { type: "3rdParty", init: () => {} };',
        'export default { useTranslation, initReactI18next };',
      ].join('\n') };
    }
    if (url.endsWith('.json')) {
      return { format: 'module', shortCircuit: true, source: `export default ${readFileSync(new URL(url), 'utf8')}` };
    }
    const path = url.split('?')[0];
    if (path.endsWith('.jsx')) {
      const out = transform(readFileSync(new URL(path), 'utf8'), { transforms: ['jsx'], jsxRuntime: 'automatic', filePath: path });
      return { format: 'module', shortCircuit: true, source: out.code.replaceAll('import.meta.env', 'globalThis.__VITE_ENV__') };
    }
    if (url.startsWith('file:') && url.endsWith('.js')) {
      const code = readFileSync(new URL(url), 'utf8');
      if (code.includes('import.meta.env')) {
        return { format: 'module', shortCircuit: true, source: code.replaceAll('import.meta.env', 'globalThis.__VITE_ENV__') };
      }
    }
    return nextLoad(url, context);
  },
});

const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid/', pretendToBeVisual: true });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document,
  localStorage: dom.window.localStorage, sessionStorage: dom.window.sessionStorage,
  CustomEvent: dom.window.CustomEvent, Node: dom.window.Node, Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement, DOMParser: dom.window.DOMParser,
  MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.matchMedia = globalThis.matchMedia;
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };

const { createElement, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const { default: SignaturesSection } = await import('./SignaturesSection.jsx');

const FORMAL = '00000000-0000-4000-8000-0000000000f1';
const SHORT = '00000000-0000-4000-8000-0000000000f2';
const WORK = '00000000-0000-4000-8000-0000000000a1';
const SALES = '00000000-0000-4000-8000-0000000000b1';
let server;
const calls = [];
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
globalThis.fetch = async (url, init = {}) => {
  const path = String(url);
  const method = init.method || 'GET';
  const body = init.body ? JSON.parse(init.body) : undefined;
  calls.push({ path, method, body });
  if (path === '/api/signatures' && method === 'GET') return json(server.signatures);
  if (path === '/api/signatures' && method === 'POST') {
    const entry = { id: `00000000-0000-4000-8000-00000000000${server.signatures.length + 3}`, ...body };
    server.signatures.push(entry);
    return json(entry, 201);
  }
  if (path.startsWith('/api/signatures/') && method === 'DELETE') {
    server.signatures = server.signatures.filter(s => !path.endsWith(s.id));
    return json({ ok: true });
  }
  if (path === '/api/signatures/assignment' && method === 'PUT') {
    const account = server.accounts.find(a => a.id === body.accountId);
    if (body.aliasId) account.aliases.find(al => al.id === body.aliasId).signature_id = body.signatureId;
    else account.signature_id = body.signatureId;
    return json({ ...body, signature: null });
  }
  if (path === '/api/accounts' && method === 'GET') return json(server.accounts);
  return json({ error: 'unexpected' }, 500);
};

let root, container;
beforeEach(async () => {
  calls.length = 0;
  server = {
    signatures: [
      { id: FORMAL, name: 'Formal', html: '<p>Kind regards, Jane</p><script>alert(1)</script>' },
      { id: SHORT, name: 'Short', html: '<p>J.</p>' },
    ],
    accounts: [{
      id: WORK, name: 'Work', email_address: 'jane@work.example', signature_id: FORMAL,
      aliases: [{ id: SALES, name: 'Sales', email: 'sales@work.example', signature_id: null }],
    }],
  };
  useStore.setState({ accounts: structuredClone(server.accounts) });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root.render(createElement(SignaturesSection)); });
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

const until = async (check, ms = 4000) => {
  const end = Date.now() + ms;
  for (;;) {
    await act(async () => { await new Promise(r => setTimeout(r, 15)); });
    if (check()) return;
    if (Date.now() > end) throw new Error(`timed out; shows: ${container.textContent}`);
  }
};
const text = () => container.textContent;
const buttonsNamed = key => [...container.querySelectorAll('button')].filter(b => b.textContent === key);
const click = el => act(async () => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
function type(input, value) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value').set;
  setter.call(input, value);
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
}
const select = (label) => container.querySelector(`select[aria-label="${label}"]`);
async function choose(el, value) {
  await act(async () => {
    el.value = value;
    el.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
}

test('lists each signature with the addresses that use it, previews sanitized', async () => {
  await until(() => text().includes('Formal'));
  assert.ok(text().includes('admin.signatures.usedBy {"list":"jane@work.example"}'));
  assert.ok(text().includes('admin.signatures.unused'));
  const previews = container.querySelectorAll('[data-signature-preview]');
  assert.equal(previews.length, 2);
  assert.ok(previews[0].innerHTML.includes('Kind regards'));
  assert.ok(!container.querySelector('[data-signature-preview] script'));
});

test('creates a signature with a name and the editor’s html', async () => {
  await until(() => text().includes('Formal'));
  await click(buttonsNamed('admin.signatures.new')[0]);
  const form = container.querySelector('[data-signature-form]');
  await act(async () => { form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); });
  assert.ok(text().includes('admin.signatures.errorName'), 'a name is required');
  assert.ok(!calls.some(c => c.method === 'POST'));

  await act(async () => { type(form.querySelector('input'), ' Holiday '); });
  const editor = form.querySelector('[contenteditable="true"]');
  await act(async () => {
    editor.innerHTML = '<p>Away until Monday</p>';
    editor.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  await act(async () => { form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); });
  await until(() => text().includes('Holiday'));
  const post = calls.find(c => c.method === 'POST');
  assert.deepEqual(post.body, { name: 'Holiday', html: '<p>Away until Monday</p>' });
});

test('duplicates a signature under a new name, and deletes only once confirmed', async () => {
  await until(() => text().includes('Short'));
  await click(buttonsNamed('admin.signatures.duplicate')[1]);
  await until(() => calls.some(c => c.method === 'POST'));
  assert.deepEqual(calls.find(c => c.method === 'POST').body, { name: 'admin.signatures.copyName {"name":"Short"}', html: '<p>J.</p>' });

  await click(buttonsNamed('common.delete')[0]);
  assert.ok(!calls.some(c => c.method === 'DELETE'));
  await click(buttonsNamed('admin.signatures.confirmDelete')[0]);
  await until(() => calls.some(c => c.method === 'DELETE'));
  assert.equal(calls.find(c => c.method === 'DELETE').path, `/api/signatures/${FORMAL}`);
});

test('assigns a signature to an account and to an alias, then fetches the accounts again', async () => {
  await until(() => !!select('jane@work.example'));
  assert.equal(select('jane@work.example').value, FORMAL);
  const aliasOptions = [...select('sales@work.example').options].map(o => o.textContent);
  assert.deepEqual(aliasOptions, ['admin.signatures.sameAsAccount', 'Formal', 'Short']);

  await choose(select('jane@work.example'), SHORT);
  await until(() => calls.some(c => c.path === '/api/accounts'));
  assert.deepEqual(calls.find(c => c.path === '/api/signatures/assignment').body, { accountId: WORK, aliasId: null, signatureId: SHORT });
  await until(() => useStore.getState().accounts[0].signature_id === SHORT);

  calls.length = 0;
  await choose(select('jane@work.example'), '');
  await until(() => calls.some(c => c.path === '/api/signatures/assignment'));
  assert.deepEqual(calls.find(c => c.path === '/api/signatures/assignment').body, { accountId: WORK, aliasId: null, signatureId: null });

  calls.length = 0;
  await choose(select('sales@work.example'), FORMAL);
  await until(() => calls.some(c => c.path === '/api/signatures/assignment'));
  assert.deepEqual(calls.find(c => c.path === '/api/signatures/assignment').body, { accountId: WORK, aliasId: SALES, signatureId: FORMAL });
});
