// Render test for searching the calendar: the field in the toolbar, the debounced request, the
// results that take the place of the view, the empty and error states, and opening a result.

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
const { useStore } = await import('../../store/index.js');
const { api } = await import('../../utils/api.js');
const { shortcutBus } = await import('../../utils/shortcutBus.js');
const CalendarPage = (await import('../CalendarPage.jsx')).default;

const CALS = [{ id: 'c1', name: 'Personal', color: '#4f8df7', visible: true }];
const NEXT = new Date().getFullYear() + 1;
const local = (y, m, d, h) => new Date(y, m - 1, d, h).toISOString();
const occ = (over) => ({
  id: 'e:', eventId: 'e', calendarId: 'c1', summary: 'x', allDay: false, status: 'CONFIRMED',
  start: local(NEXT, 2, 3, 9), end: local(NEXT, 2, 3, 10), attendees: [], upcoming: true, ...over,
});

let searches;
let signals;
let answer;
before(() => {
  api.calendar.accounts = async () => [{ id: 'a1', name: 'Fastmail', lastSyncAt: '2026-01-01T00:00:00Z' }];
  api.calendar.calendars = async () => CALS;
  api.calendar.events = async () => ({ events: [] });
  api.calendar.searchEvents = async (q, opts) => {
    searches.push(q);
    signals.push(opts?.signal);
    const v = typeof answer === 'function' ? answer(q, opts) : answer;
    return v instanceof Error ? Promise.reject(v) : v;
  };
});
beforeEach(() => {
  searches = [];
  signals = [];
  answer = { events: [] };
  localStorage.clear();
  localStorage.setItem('mailflow:calendar:view', 'month');
  useStore.setState({ showCalendar: true, calendarFocus: null, calendarRailSlot: null });
});

let root = null;
afterEach(async () => {
  if (root) await React.act(async () => root.unmount());
  root = null;
  document.body.innerHTML = '<div id="root"></div>';
});

const wait = (ms) => React.act(async () => { await new Promise(r => setTimeout(r, ms)); });
async function mount() {
  root = createRoot(document.getElementById('root'));
  await React.act(async () => { root.render(React.createElement(CalendarPage)); });
  await wait(5);
  await wait(5);
}
const field = () => document.querySelector('input[aria-label="calendar.search.label"]');
const results = () => document.querySelector('[role="region"][aria-label="calendar.search.results"]');
async function type(value) {
  const input = field();
  await React.act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}
const key = (el, k) => React.act(async () => { el.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true })); });

describe('calendar search', () => {
  test('asks once the typing stops, and lists the results in place of the view', async () => {
    answer = { events: [
      occ({ id: 'a:', eventId: 'a', summary: 'Dentist', location: 'Rue de la Paix' }),
      occ({ id: 'b:2026-03-16T18:00:00Z', eventId: 'b', summary: 'Drawing class', start: local(NEXT - 2, 3, 16, 18), end: local(NEXT - 2, 3, 16, 19), upcoming: false, isRecurring: true }),
    ] };
    await mount();
    assert.ok(field(), 'a search field in the toolbar');
    await type('de');
    await type('den');
    await wait(100);
    assert.deepEqual(searches, [], 'nothing asked while typing');
    await wait(250);
    assert.deepEqual(searches, ['den']);
    const region = results();
    assert.ok(region);
    const text = region.textContent;
    assert.ok(text.includes('Dentist') && text.includes('Rue de la Paix, Personal'));
    assert.ok(text.includes('calendar.upcoming.title') && text.includes('calendar.search.past'));
    assert.ok(text.indexOf('Dentist') < text.indexOf('Drawing class'));
    assert.ok(text.includes(String(NEXT)), 'a date in another year shows its year');
    const dot = [...region.querySelectorAll('span[aria-hidden]')].find(s => /#4f8df7|rgb\(79, 141, 247\)/.test(s.style.background));
    assert.ok(dot, 'a dot in the calendar colour');
  });

  test('a search still running when the query changes is aborted, and its answer never shows', async () => {
    let release;
    answer = (q, { signal }) => (q === 'den'
      ? new Promise((resolve, reject) => {
        release = () => resolve({ events: [occ({ summary: 'Stale' })] });
        signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      })
      : { events: [occ({ summary: 'Dentist' })] });
    await mount();
    await type('den');
    await wait(300);
    assert.equal(signals.length, 1);
    assert.equal(signals[0].aborted, false);
    await type('dentist');
    assert.equal(signals[0].aborted, true, 'the older request is aborted as soon as the query changes');
    await wait(300);
    release();
    await wait(5);
    assert.deepEqual(searches, ['den', 'dentist']);
    assert.ok(results().textContent.includes('Dentist'));
    assert.ok(!results().textContent.includes('Stale'));
    assert.ok(!results().textContent.includes('aborted'));
  });

  test('a single character does not search', async () => {
    await mount();
    await type('d');
    await wait(300);
    assert.deepEqual(searches, []);
    assert.equal(results(), null);
  });

  test('says when nothing matches, and when the search fails', async () => {
    await mount();
    await type('zzz');
    await wait(300);
    assert.ok(results().textContent.includes('calendar.search.empty:{"query":"zzz"}'));
    answer = new Error('boom');
    await type('zzzz');
    await wait(300);
    assert.ok(results().textContent.includes('calendar.search.error:{"message":"boom"}'));
    answer = { events: [occ({ summary: 'Back' })] };
    const retry = [...results().querySelectorAll('button')].find(b => b.textContent === 'common.retry');
    await React.act(async () => { retry.click(); });
    await wait(300);
    assert.ok(results().textContent.includes('Back'));
  });

  test('Escape clears the search and gives the view back', async () => {
    answer = { events: [occ({ summary: 'Dentist' })] };
    await mount();
    await type('dentist');
    await wait(300);
    assert.ok(results());
    await key(field(), 'Escape');
    assert.equal(field().value, '');
    assert.equal(results(), null);
  });

  test('a result goes to its day and opens the event', async () => {
    answer = { events: [occ({ summary: 'Dentist' })] };
    await mount();
    await type('dentist');
    await wait(300);
    const row = [...results().querySelectorAll('button')].find(b => b.textContent.includes('Dentist'));
    await React.act(async () => { row.click(); });
    await wait(5);
    assert.equal(results(), null);
    assert.equal(field().value, '');
    const dialog = document.querySelector('[role="dialog"]');
    assert.ok(dialog && dialog.textContent.includes('Dentist'), 'the event detail is open');
    assert.ok(document.querySelector('h1').textContent.includes(String(NEXT)), 'the view moved to that month');
  });

  test('the search shortcut focuses the field while the calendar is shown', async () => {
    await mount();
    await React.act(async () => { shortcutBus.emit('focusSearch'); });
    assert.equal(document.activeElement, field());
  });
});
