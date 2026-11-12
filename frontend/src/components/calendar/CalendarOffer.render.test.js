// Render test for the "also add the calendars" offer shown after a mail account is added.
// Same harness as AddAccount.render.test.js: sucrase transforms JSX, react-i18next is stubbed.

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
        'export const useTranslation = () => ({ t: (k) => k, i18n: { language: "en" } });',
        'export default { useTranslation };',
      ].join('\n') };
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
});
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { api } = await import('../../utils/api.js');
const CalendarOffer = (await import('./CalendarOffer.jsx')).default;

const doc = dom.window.document;
const root = createRoot(doc.getElementById('root'));
const act = fn => React.act(fn);
const text = () => doc.getElementById('root').textContent;
const button = label => [...doc.querySelectorAll('button')].find(b => b.textContent.trim() === label);
const click = el => act(async () => { el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });

const mount = async (onDismiss = () => {}) => {
  await act(async () => { root.render(null); });
  await act(async () => {
    root.render(React.createElement(CalendarOffer, { account: { id: 'm1', imap_host: 'imap.example.com' }, onDismiss }));
  });
};

test('adds the calendars of the account on request and says so', async () => {
  const calls = [];
  api.calendar.addFromMail = async (id) => { calls.push(id); return {}; };
  await mount();
  assert.match(text(), /calendarOffer\.prompt/);
  await click(button('calendarOffer.add'));
  assert.deepEqual(calls, ['m1']);
  assert.match(text(), /calendarOffer\.added/);
  assert.equal(button('calendarOffer.add'), undefined);
});

test('reports a missing CalDAV server', async () => {
  api.calendar.addFromMail = async () => { throw Object.assign(new Error('nothing'), { code: 'no_caldav' }); };
  await mount();
  await click(button('calendarOffer.add'));
  assert.match(text(), /calendarOffer\.none/);
});

test('can be dismissed without calling the server', async () => {
  let called = false;
  let dismissed = false;
  api.calendar.addFromMail = async () => { called = true; };
  await mount(() => { dismissed = true; });
  await click(button('common.dismiss'));
  assert.equal(dismissed, true);
  assert.equal(called, false);
});

test('starts at once when the user already said yes, trying the server found first', async () => {
  const calls = [];
  api.calendar.addFromMail = async (...args) => { calls.push(args); return {}; };
  await act(async () => { root.render(null); });
  await act(async () => {
    root.render(React.createElement(CalendarOffer, { account: { id: 'm2', imap_host: 'imap.example.com' }, auto: true, serverUrl: 'https://dav.example.com/', onDismiss: () => {} }));
  });
  assert.deepEqual(calls, [['m2', 'https://dav.example.com/']]);
  assert.match(text(), /calendarOffer\.added/);
});
