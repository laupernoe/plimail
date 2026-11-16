// Render test for adding a calendar account with a mail account's password.
// Same harness as CalendarOffer.render.test.js: sucrase transforms JSX, react-i18next is stubbed.

import { test } from 'node:test';
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
    if (url.endsWith('.json')) {
      return { format: 'module', shortCircuit: true, source: `export default ${readFileSync(new URL(url), 'utf8')}` };
    }
    if (url.endsWith('.jsx')) {
      const out = transform(readFileSync(new URL(url), 'utf8'), { transforms: ['jsx'], jsxRuntime: 'automatic', filePath: url });
      return { format: 'module', shortCircuit: true, source: out.code.replaceAll('import.meta.env', 'globalThis.__VITE_ENV__') };
    }
    if (url.startsWith('file:') && url.endsWith('.js')) {
      const code = readFileSync(new URL(url), 'utf8');
      if (code.includes('import.meta.env')) return { format: 'module', shortCircuit: true, source: code.replaceAll('import.meta.env', 'globalThis.__VITE_ENV__') };
    }
    return nextLoad(url, context);
  },
});

const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid', pretendToBeVisual: true });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
  Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
  getComputedStyle: dom.window.getComputedStyle, IS_REACT_ACT_ENVIRONMENT: true,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
});
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { api } = await import('../../utils/api.js');
const { CalendarAccountsPanel } = await import('./AccountsModal.jsx');

const doc = dom.window.document;
const act = fn => React.act(fn);

async function setValue(el, value) {
  const proto = el.tagName === 'SELECT' ? dom.window.HTMLSelectElement.prototype : dom.window.HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new dom.window.Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  });
}

test("a server the mail account's password may not go to is explained, not shown as server text", async () => {
  const sent = [];
  api.calendar.mailAccounts = async () => [{ id: 'm1', email: 'me@example.com', host: 'imap.example.com', username: 'me@example.com' }];
  api.calendar.addAccount = async (data) => {
    sent.push(data);
    throw Object.assign(new Error('server words'), { status: 400, code: 'mail_password_host' });
  };
  const root = createRoot(doc.getElementById('root'));
  await act(async () => { root.render(React.createElement(CalendarAccountsPanel, { accounts: [], onChanged: async () => {} })); });
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });

  await setValue(doc.querySelector('input[placeholder="https://caldav.example.com/dav/"]'), 'https://elsewhere.example.net/');
  await setValue(doc.querySelector('select'), 'm1');
  await act(async () => { doc.querySelector('form').requestSubmit(); });
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].mailAccountId, 'm1');
  assert.match(doc.body.textContent, /calendar\.accounts\.mailPasswordHost/);
  assert.doesNotMatch(doc.body.textContent, /server words/);
  await act(async () => root.unmount());
});
