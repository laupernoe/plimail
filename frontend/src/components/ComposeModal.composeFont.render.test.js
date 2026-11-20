// The default writing font in the composer: what the editor shows and what a send carries, so the
// server wraps the HTML part in it. Default sends nothing, so the message is built as before.

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
const ComposeFontSetting = (await import('./ComposeFontSetting.jsx')).default;


const requests = [];
globalThis.fetch = async (url, options) => {
  const path = String(url);
  if (path.endsWith('/mail/draft')) { requests.push(['draft', JSON.parse(options.body)]); return { ok: true, status: 200, json: async () => ({ uid: 40 + requests.length, folder: 'Drafts' }) }; }
  if (path.endsWith('/mail/send')) { requests.push(['send', JSON.parse(options.body)]); return { ok: true, status: 200, json: async () => ({ messageId: '<x@y>' }) }; }
  return { ok: true, status: 200, json: async () => ({}) };
};
const ACCOUNTS = [{ id: 'acct', email_address: 'me@example.test', aliases: [], signature: '<p>Me</p>', signature_enabled: true }];


const click = el => React.act(async () => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
async function mount(composeData, { family = '', size = '', plaintextEmail = false } = {}) {
  requests.length = 0;
  useStore.setState({ accounts: ACCOUNTS, plaintextEmail, composing: true, prepareComposeSwitch: null, composeData, composeFontFamily: family, composeFontSize: size });
  const root = createRoot(document.getElementById('root'));
  await React.act(async () => root.render(React.createElement(ComposeModal)));
  await React.act(async () => {});
  return root;
}
const unmount = root => React.act(async () => root.unmount());
const send = async () => {
  await click([...document.querySelectorAll('button')].find(b => b.textContent.includes('compose.send')));
  await React.act(async () => { await new Promise(r => setImmediate(r)); });
  return requests.filter(([kind]) => kind === 'send').map(([, body]) => body);
};
const type = () => React.act(async () => { document.querySelector('.ProseMirror').editor.commands.insertContent('Hello'); });
const fresh = { accountId: 'acct', to: ['ann@example.test'], subject: 'Hi', body: '' };
const reply = { accountId: 'acct', to: ['ann@example.test'], subject: 'Re: Hi', body: '', isReply: true, quotedBody: '\n\n> hi', quotedBodyHtml: '<blockquote><p style="font-family:Comic Sans MS">hi</p></blockquote>' };
const ARIAL = 'Arial, Helvetica, sans-serif';

test('a new message starts in the default writing font and sends it for the HTML part', async () => {
  const root = await mount(fresh, { family: ARIAL, size: '11px' });
  try {
    const wrap = document.querySelector('.tiptap-compose');
    assert.equal(wrap.style.getPropertyValue('--compose-font-family'), ARIAL);
    assert.equal(wrap.style.getPropertyValue('--compose-font-size'), '11px');
    await type();
    const [sent] = await send();
    assert.deepEqual(sent.composeFont, { family: ARIAL, size: '11px' });
    // The font is the wrapper's, not a mark on each run of text.
    assert.doesNotMatch(sent.body, /font-size|font-family/);
  } finally { await unmount(root); }
});

test('a reply carries the font too, and its quote is sent as it was', async () => {
  const root = await mount(reply, { family: 'Georgia, serif', size: '' });
  try {
    const [sent] = await send();
    assert.deepEqual(sent.composeFont, { family: 'Georgia, serif' });
    assert.match(sent.quotedBodyHtml, /Comic Sans MS/);
  } finally { await unmount(root); }
});

test('on Default nothing changes: no font is sent and the editor keeps its own', async () => {
  const root = await mount(fresh);
  try {
    assert.equal(document.querySelector('.tiptap-compose').style.getPropertyValue('--compose-font-family'), '');
    await type();
    const [sent] = await send();
    assert.equal('composeFont' in sent, false);
  } finally { await unmount(root); }
});

test('a plain-text message has no font to carry', async () => {
  const root = await mount(fresh, { family: ARIAL, size: '11px', plaintextEmail: true });
  try {
    const textarea = document.querySelector('textarea');
    await React.act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(textarea, 'Hello');
      textarea.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    const [sent] = await send();
    assert.equal('composeFont' in sent, false);
  } finally { await unmount(root); }
});

test('the setting lists each font in its own face and saves the choice', async () => {
  useStore.setState({ composeFontFamily: '', composeFontSize: '' });
  const root = createRoot(document.getElementById('root'));
  try {
    await React.act(async () => root.render(React.createElement(ComposeFontSetting, { selectStyle: {} })));
    const [familySelect, sizeSelect] = document.querySelectorAll('select');
    const georgia = [...familySelect.options].find(o => o.textContent === 'Georgia');
    assert.match(georgia.getAttribute('style'), /font-family: Georgia, serif/);
    const choose = (select, value) => React.act(async () => {
      select.value = value;
      select.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    await choose(familySelect, 'Georgia, serif');
    await choose(sizeSelect, '16px');
    assert.equal(useStore.getState().composeFontFamily, 'Georgia, serif');
    assert.equal(useStore.getState().composeFontSize, '16px');
    const sample = document.querySelector('[data-testid="compose-font-sample"]');
    assert.equal(sample.style.fontFamily, 'Georgia, serif');
    assert.equal(sample.style.fontSize, '16px');
  } finally { await React.act(async () => root.unmount()); }
});
