// Render test for the folder export / import dialog: what it asks for, what it sends and what its report shows.
// The harness is Sidebar.emptyFolder.render.test.js, with English strings so the text can be read.


import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('react-i18next/dist/es/index.js') || url.endsWith('/react-i18next')) {
      return { format: 'module', shortCircuit: true, source: [
        // English strings with their {{values}} filled in: the folder names in the messages are
        // what these tests check.
        `const en = ${readFileSync(new URL('../locales/en.json', import.meta.url), 'utf8')};`,
        'const t = (k, o) => { const s = k.split(".").reduce((n, p) => n?.[p], en); return typeof s === "string" ? s.replace(/{{(\\w+)}}/g, (m, v) => String(o?.[v] ?? m)) : (typeof o === "string" ? o : o?.defaultValue ?? k); };',
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
      const code = readFileSync(new URL(url), 'utf8');
      const out = transform(code, { transforms: ['jsx'], jsxRuntime: 'automatic', filePath: url });
      return { format: 'module', shortCircuit: true, source: shimViteEnv(out.code) };
    }
    if (url.startsWith('file:') && url.endsWith('.js')) {
      const code = readFileSync(new URL(url), 'utf8');
      if (code.includes('import.meta.env')) {
        return { format: 'module', shortCircuit: true, source: shimViteEnv(code) };
      }
    }
    return nextLoad(url, context);
  },
});

const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid', pretendToBeVisual: true });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document,
  localStorage: dom.window.localStorage, CustomEvent: dom.window.CustomEvent,
  Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
  getComputedStyle: dom.window.getComputedStyle,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
dom.window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.matchMedia = dom.window.matchMedia;
dom.window.Element.prototype.scrollIntoView = () => {};
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };
globalThis.fetch = async () => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({}), text: async () => '{}' });


globalThis.Blob = dom.window.Blob; // api.js tells a file body by instanceof
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const MailTransferDialog = (await import('./MailTransferDialog.jsx')).default;

const ACCOUNT = { id: 'acct-1', email_address: 'a@example.com', name: 'A', enabled: true, folder_mappings: {} };
const FOLDERS = [{ path: 'INBOX', name: 'INBOX' }, { path: 'Projects', name: 'Projects' }];
const doc = () => dom.window.document;
const byText = (selector, text) => [...doc().querySelectorAll(selector)].find(el => el.textContent === text);

let root;
async function mount(mode) {
  if (root) await React.act(async () => root.unmount());
  useStore.setState({ accounts: [ACCOUNT], folders: { 'acct-1': FOLDERS } });
  await React.act(async () => {
    root = createRoot(doc().getElementById('root'));
    root.render(React.createElement(MailTransferDialog, { mode, accountId: 'acct-1', folderPath: 'Projects', onClose() {} }));
  });
}

const reply = report => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => report, text: async () => JSON.stringify(report) });

async function chooseFile(name) {
  const input = doc().querySelector('input[type="file"]');
  const file = new dom.window.File(['From a@b.c Wed Jan  3 01:05:34 1996\nSubject: x\n\nhi\n'], name);
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await React.act(async () => input.dispatchEvent(new dom.window.Event('change', { bubbles: true })));
}

describe('MailTransferDialog: export', () => {
  test('starts a download of the chosen format for this account and folder', async () => {
    const clicked = [];
    dom.window.HTMLAnchorElement.prototype.click = function click() { clicked.push(this.getAttribute('href')); };
    await mount('export');
    assert.ok(byText('h2', 'Export Projects'));
    await React.act(async () => doc().querySelectorAll('input[type="radio"]')[1].click());
    await React.act(async () => byText('button', 'Export').click());
    assert.equal(clicked.length, 1);
    const url = new URL(clicked[0], 'http://x');
    assert.equal(url.pathname, '/api/mail-transfer/export');
    assert.equal(url.searchParams.get('accountId'), 'acct-1');
    assert.equal(url.searchParams.get('folder'), 'Projects');
    assert.equal(url.searchParams.get('format'), 'zip');
  });
});

describe('MailTransferDialog: import', () => {
  test('cannot start without a file, then sends the file to the chosen folder and shows the report', async () => {
    const sent = [];
    globalThis.fetch = async (url, opts) => {
      sent.push({ url: String(url), method: opts.method, header: opts.headers['X-Requested-With'], type: opts.headers['Content-Type'] });
      return reply({ imported: 2, duplicates: 1, failed: 1, processed: 4, failures: [{ label: 'message 3', reason: 'Mailbox full' }], failuresTruncated: 0, aborted: null });
    };
    await mount('import');
    assert.ok(byText('h2', 'Import into Projects'));
    assert.equal(byText('button', 'Import').disabled, true);

    await chooseFile('Archive.mbox');
    const select = doc().querySelector('select');
    await React.act(async () => { select.value = 'INBOX'; select.dispatchEvent(new dom.window.Event('change', { bubbles: true })); });
    await React.act(async () => doc().querySelector('input[type="checkbox"]').click());
    assert.equal(byText('button', 'Import').disabled, false);
    await React.act(async () => byText('button', 'Import').click());
    await React.act(async () => new Promise(resolve => setTimeout(resolve, 0)));

    assert.equal(sent.length, 1);
    const url = new URL(sent[0].url, 'http://x');
    assert.equal(url.pathname, '/api/mail-transfer/import');
    assert.equal(url.searchParams.get('folder'), 'INBOX');
    assert.equal(url.searchParams.get('format'), 'mbox');
    assert.equal(url.searchParams.get('markSeen'), '0');
    assert.equal(sent[0].method, 'POST');
    assert.equal(sent[0].header, 'Plimail');
    assert.equal(sent[0].type, 'application/octet-stream');

    const text = doc().body.textContent;
    assert.ok(text.includes('Import finished'));
    assert.ok(text.includes('Archive.mbox: message 3'));
    assert.ok(text.includes('Mailbox full'));
  });

  test('says when the import stopped early, and why', async () => {
    globalThis.fetch = async () => reply({ imported: 5, duplicates: 0, failed: 0, processed: 5, failures: [], failuresTruncated: 0, aborted: 'too_large' });
    await mount('import');
    await chooseFile('a.eml');
    await React.act(async () => byText('button', 'Import').click());
    await React.act(async () => new Promise(resolve => setTimeout(resolve, 0)));
    assert.ok(doc().querySelector('[role="alert"]').textContent.includes('size limit'));
  });
});
