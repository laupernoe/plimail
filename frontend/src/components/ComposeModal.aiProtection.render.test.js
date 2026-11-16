// A message under the lock (PGP or a password link) is meant to leave the browser encrypted. The
// composer's AI actions send the draft's plain text to the AI provider, so they are off while the
// lock is on, with the reason on the button, and an open suggestion is dropped.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { setImmediate } from 'node:timers';
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
  DOMParser: dom.window.DOMParser, MutationObserver: dom.window.MutationObserver,
  getComputedStyle: dom.window.getComputedStyle, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
dom.window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };
// No PGP keys of one's own, so the lock turns on a password link.
globalThis.fetch = async (url) => {
  if (String(url) === '/api/pgp/keys') return { ok: true, status: 200, json: async () => ({ keys: [] }) };
  return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
};

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const { api } = await import('../utils/api.js');
const ComposeModal = (await import('./ComposeModal.jsx')).default;

const chats = [];
let root;

before(async () => {
  api.ai.status = async () => ({ enabled: true, features: { compose: true, summarize: true } });
  api.ai.chat = async (messages) => { chats.push(messages); return 'Better draft'; };
  useStore.setState({
    user: { id: 'u1' },
    accounts: [{ id: 'acct', enabled: true, email_address: 'me@example.invalid', name: 'Me', color: '#fff' }],
    plaintextEmail: false, composing: false, composeData: null, prepareComposeSwitch: null,
  });
  useStore.getState().openCompose({ accountId: 'acct', to: ['bob@example.invalid'], cc: [], subject: 'Plan', body: '<p>secret plan</p>', bodyIsHtml: true });
  root = createRoot(document.getElementById('root'));
  await React.act(async () => { root.render(React.createElement(ComposeModal)); });
  await settle();
});

after(() => React.act(async () => root.unmount()));

const settle = () => React.act(async () => { for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)); });
const button = (label) => [...document.querySelectorAll('button')].find(b => b.textContent === label);
const press = (el) => React.act(async () => { el.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true })); });
const click = (el) => React.act(async () => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
// The password link is chosen from the Send menu, and its panel's close button turns it off.
const passwordPanel = () => document.querySelector('section[aria-label="compose.sendWithPassword"]');
const choosePasswordLink = async () => {
  await click(document.querySelector('button[aria-label="compose.sendOptions"]'));
  await click(document.querySelector('[data-preset="sendWithPassword"]'));
};
const aiButton = () => document.querySelector('button[title="compose.toolbar.aiAssist"], button[title="compose.toolbar.aiProtected"]');

test('choosing a password link drops an open suggestion and turns the AI actions off, saying why', async () => {
  await press(aiButton());
  await press(button('compose.toolbar.aiImprove'));
  await settle();
  assert.ok(button('compose.toolbar.aiApply'), 'the suggestion is shown');
  assert.equal(chats.length, 1);

  await choosePasswordLink();
  await settle();
  assert.ok(passwordPanel(), 'the password link is on');
  assert.equal(button('compose.toolbar.aiApply'), undefined, 'the suggestion is gone');
  assert.equal(aiButton().getAttribute('title'), 'compose.toolbar.aiProtected');
  assert.equal(aiButton().getAttribute('aria-disabled'), 'true');
  assert.equal(document.querySelector('[data-testid="ai-spellcheck"]'), null);

  await press(aiButton());
  assert.equal(button('compose.toolbar.aiImprove'), undefined, 'the AI menu does not open');
  assert.equal(chats.length, 1, 'nothing more went to the provider');
});

test('cancelling the protection brings the AI actions back', async () => {
  await click(button('pgp.compose.cancelProtection'));
  await settle();
  assert.equal(passwordPanel(), null, 'the password link is off');
  assert.equal(aiButton().getAttribute('title'), 'compose.toolbar.aiAssist');
  assert.ok(document.querySelector('[data-testid="ai-spellcheck"]'));
});
