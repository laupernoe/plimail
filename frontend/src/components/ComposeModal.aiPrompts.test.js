// The composer's AI actions: each one's instruction, and that none of them asks for a sign-off
// of its own (the composer appends the signature).

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('react-i18next/dist/es/index.js') || url.endsWith('/react-i18next')) {
      return { format: 'module', shortCircuit: true, source: [
        'export const useTranslation = () => ({ t: (k, o) => (o ? `${k} ${JSON.stringify(o)}` : k), i18n: { language: "en", changeLanguage: () => {} } });',
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
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' });

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const { api } = await import('../utils/api.js');
const ComposeModal = (await import('./ComposeModal.jsx')).default;

const chats = [];

before(() => {
  api.ai.status = async () => ({ enabled: true, features: { compose: true } });
  api.ai.chat = async (messages) => { chats.push(messages); return 'ok'; };
  useStore.setState({
    user: { id: 'u1' },
    accounts: [{ id: 'acct', enabled: true, email_address: 'me@example.invalid', name: 'Me', color: '#fff' }],
  });
});

async function run(menuKey) {
  chats.length = 0;
  useStore.setState({ plaintextEmail: false, composing: false, composeData: null, prepareComposeSwitch: null });
  useStore.getState().openCompose({ accountId: 'acct', to: ['bob@example.invalid'], cc: [], subject: 'Plan', body: '<p>helo bob</p>', bodyIsHtml: true });
  const root = createRoot(document.getElementById('root'));
  await React.act(async () => { root.render(React.createElement(ComposeModal)); });
  await React.act(async () => {});
  const press = (el) => React.act(async () => { el.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true })); });
  await press(document.querySelector('button[title="compose.toolbar.aiAssist"]'));
  await press([...document.querySelectorAll('button')].find(b => b.textContent === menuKey));
  await React.act(async () => {});
  await React.act(async () => root.unmount());
  return chats[0];
}

describe('composer AI actions', () => {
  test('Fix spelling keeps wording, tone and language and changes nothing else', async () => {
    const [system, user] = await run('compose.toolbar.aiFixGrammar');
    assert.match(system.content, /only the spelling, grammar and punctuation/);
    assert.match(system.content, /wording, tone, style, formatting and language exactly/);
    assert.equal(user.content, 'helo bob');
  });

  test('Make clearer rewrites for clarity in the same language, keeping the meaning', async () => {
    const [system, user] = await run('compose.toolbar.aiMakeClearer');
    assert.match(system.content, /clearer/);
    assert.match(system.content, /meaning, the facts and the language/);
    assert.equal(user.content, 'helo bob');
  });

  for (const [name, key] of [['Improve', 'aiImprove'], ['Shorten', 'aiShorten'], ['Fix spelling', 'aiFixGrammar'], ['Make clearer', 'aiMakeClearer']]) {
    test(`${name} adds no sign-off of its own`, async () => {
      const [system] = await run(`compose.toolbar.${key}`);
      assert.match(system.content, /Do not add a greeting, closing line, sign-off, name or signature/);
    });
  }
});
