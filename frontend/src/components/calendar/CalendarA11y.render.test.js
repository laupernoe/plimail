// Render test for calendar accessibility fixes: the calendar list markup, the colour picker commit, and the event popover focus.

import { test, describe, before, beforeEach, afterEach } from 'node:test';
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
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
dom.window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
dom.window.Element.prototype.scrollIntoView = () => {};
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' });

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { api } = await import('../../utils/api.js');
const { CalendarListTab } = await import('./AccountsModal.jsx');
const EventDetail = (await import('./EventDetail.jsx')).default;

const CAL = { id: 'c1', accountId: 'a1', serverName: 'Personal', displayName: '', color: '#4f8df7', visible: true, ignored: false };
let saves;
let root = null;
before(() => {
  api.calendar.accounts = async () => [{ id: 'a1', name: 'Fastmail' }];
  api.calendar.allCalendars = async () => [CAL, { ...CAL, id: 'c2', serverName: 'Work' }];
  api.calendar.updateCalendar = async (id, patch) => { saves.push([id, patch]); return { ...CAL, id, ...patch }; };
});
beforeEach(() => { saves = []; });
afterEach(async () => {
  if (root) await React.act(async () => root.unmount());
  root = null;
  document.body.innerHTML = '<div id="root"></div>';
});
const settle = () => React.act(async () => { await new Promise(r => setTimeout(r, 5)); });
const render = async (el) => {
  root = createRoot(document.getElementById('root'));
  await React.act(async () => { root.render(el); });
  await settle(); await settle();
};

describe('calendar list', () => {
  test('a list holds only list items', async () => {
    await render(React.createElement(CalendarListTab));
    const ul = document.querySelector('ul');
    assert.ok(ul);
    assert.equal(ul.children.length, 2);
    assert.ok([...ul.children].every(c => c.tagName === 'LI'));
  });

  test('the custom colour saves once on commit, not on every input', async () => {
    await render(React.createElement(CalendarListTab));
    await React.act(async () => { document.querySelector('button[aria-expanded]').click(); });
    const input = document.querySelector('input[type="color"]');
    const set = async (v, type) => React.act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, v);
      input.dispatchEvent(new window.Event(type, { bubbles: true }));
    });
    await set('#112233', 'input');
    await set('#223344', 'input');
    assert.equal(saves.length, 0);
    assert.ok(document.querySelector('input[type="color"]'), 'the picker stays open');
    await set('#223344', 'change');
    await settle();
    assert.deepEqual(saves, [['c1', { color: '#223344' }]]);
  });
});

describe('event popover', () => {
  test('takes focus, closes on Escape and hands focus back', async () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();
    let closed = 0;
    const occ = { id: 'e:', eventId: 'e', calendarId: 'c1', summary: 'Standup', allDay: false, status: 'CONFIRMED', start: new Date().toISOString(), end: new Date().toISOString() };
    await render(React.createElement(EventDetail, { occ, rect: null, isMobile: false, onClose: () => { closed++; }, calendar: CAL, color: '#4f8df7', locale: 'en' }));
    const dialog = document.querySelector('[role="dialog"]');
    assert.equal(document.activeElement, dialog);
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(closed, 1);
    await React.act(async () => root.unmount());
    root = null;
    assert.equal(document.activeElement, trigger);
  });
});
