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


// The signature picker: any signature of the library, whichever account sends, replacing only
// the signature block; a From change afterwards keeps the choice.

const requests = [];
const LIBRARY = [
  { id: 'sig-formal', name: 'Formal', html: '<p>Kind regards, Jane Doe</p>' },
  { id: 'sig-short', name: 'Short', html: '<p>J.</p>' },
];
globalThis.fetch = async (url, options) => {
  const path = String(url);
  if (path.endsWith('/api/signatures')) return { ok: true, status: 200, json: async () => LIBRARY };
  if (path.endsWith('/mail/draft')) { requests.push(['draft', JSON.parse(options.body)]); return { ok: true, status: 200, json: async () => ({ uid: 40 + requests.length, folder: 'Drafts' }) }; }
  if (path.endsWith('/mail/send')) { requests.push(['send', JSON.parse(options.body)]); return { ok: true, status: 200, json: async () => ({ messageId: '<x@y>' }) }; }
  return { ok: true, status: 200, json: async () => ({}) };
};
const ACCOUNTS = [
  { id: 'work', email_address: 'jane@work.test', aliases: [], signature: '<p>Work sig</p>', signature_id: 'w', signature_enabled: true },
  { id: 'home', email_address: 'jane@home.test', aliases: [], signature: '<p>Home sig</p>', signature_id: 'h', signature_enabled: true },
  { id: 'bare', email_address: 'bare@example.test', aliases: [], signature: null, signature_enabled: true },
];
const flush = () => React.act(async () => { await new Promise(r => setImmediate(r)); });
const picker = () => document.querySelector('button[aria-label="compose.chooseSignature"]');
const toggle = () => document.querySelector('button[aria-label="compose.insertSignature"]');
const menuItem = name => [...document.querySelectorAll('[role="menuitem"]')].find(b => b.textContent === name);
const click = el => React.act(async () => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
const pick = async (name) => { await click(picker()); await click(menuItem(name)); };
const textareas = () => [...document.querySelectorAll('textarea')];
const signatureBox = () => textareas().find(el => /sig|regards|J\./.test(el.value));
const bodyBox = () => textareas().find(el => el.value.includes('typed'));
const setText = (el, value) => React.act(async () => {
  Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(el, value);
  el.dispatchEvent(new window.Event('input', { bubbles: true }));
});
const changeFrom = value => React.act(async () => {
  const from = document.querySelector('select');
  from.value = value;
  from.dispatchEvent(new window.Event('change', { bubbles: true }));
});
async function mount(composeData, { plain = true } = {}) {
  requests.length = 0;
  useStore.setState({ accounts: ACCOUNTS, plaintextEmail: plain, composing: true, prepareComposeSwitch: null, composeData });
  const root = createRoot(document.getElementById('root'));
  await React.act(async () => root.render(React.createElement(ComposeModal)));
  await flush();
  return root;
}
const unmount = root => React.act(async () => root.unmount());
const send = async () => {
  const button = [...document.querySelectorAll('button')].find(b => b.textContent.includes('compose.send'));
  await click(button);
  await flush();
  return requests.filter(([kind]) => kind === 'send').map(([, body]) => body);
};

test('picking a library signature replaces the signature block and leaves the typed text alone', async () => {
  const root = await mount({ accountId: 'work', to: ['to@example.test'], subject: 's', body: 'typed by hand' });
  try {
    assert.equal(signatureBox().value, 'Work sig');
    await setText(bodyBox(), 'typed by hand, then more');
    await pick('Formal');
    assert.equal(signatureBox().value, 'Kind regards, Jane Doe');
    assert.equal(bodyBox().value, 'typed by hand, then more');
    const [sent] = await send();
    assert.equal(sent.accountId, 'work');
    assert.equal(sent.body, 'typed by hand, then more');
    assert.equal(sent.editedSignature, 'Kind regards, Jane Doe');
  } finally { await unmount(root); }
});

test('a From change swaps in the new sender\'s signature, unless one was picked', async () => {
  let root = await mount({ accountId: 'work', to: ['to@example.test'], subject: 's', body: 'typed' });
  try {
    await changeFrom('account:home');
    assert.equal(signatureBox().value, 'Home sig');
  } finally { await unmount(root); }

  root = await mount({ accountId: 'work', to: ['to@example.test'], subject: 's', body: 'typed' });
  try {
    await pick('Short');
    await changeFrom('account:home');
    assert.equal(signatureBox().value, 'J.');
    const [sent] = await send();
    assert.equal(sent.accountId, 'home');
    assert.equal(sent.editedSignature, 'J.');
  } finally { await unmount(root); }
});

test('an account with no signature of its own can send with one from the library', async () => {
  const root = await mount({ accountId: 'bare', to: ['to@example.test'], subject: 's', body: 'typed' });
  try {
    assert.equal(toggle(), null);
    await pick('Formal');
    assert.equal(toggle().getAttribute('aria-pressed'), 'true');
    const [sent] = await send();
    assert.equal(sent.editedSignature, 'Kind regards, Jane Doe');
  } finally { await unmount(root); }
});

test('"No signature" sends none, and the body is kept', async () => {
  const root = await mount({ accountId: 'work', to: ['to@example.test'], subject: 's', body: 'typed' });
  try {
    await pick('compose.noSignature');
    assert.equal(signatureBox(), undefined);
    assert.equal(bodyBox().value, 'typed');
    const [sent] = await send();
    assert.equal(sent.editedSignature, '');
  } finally { await unmount(root); }
});

test('in rich text, the picked signature goes into the signature block only', async () => {
  const root = await mount({ accountId: 'work', to: ['to@example.test'], subject: 's', body: '<p>typed</p>' }, { plain: false });
  try {
    await pick('Formal');
    const sigBlock = [...document.querySelectorAll('[contenteditable="true"]')].find(el => el.textContent.includes('Kind regards'));
    assert.ok(sigBlock, 'the signature block shows the picked signature');
    assert.ok(!sigBlock.textContent.includes('typed'));
    assert.ok(!document.body.textContent.includes('Work sig'));
    const [sent] = await send();
    assert.equal(sent.editedSignature, '<p>Kind regards, Jane Doe</p>');
    assert.match(sent.body, /typed/);
    assert.doesNotMatch(sent.body, /Kind regards/);
  } finally { await unmount(root); }
});
