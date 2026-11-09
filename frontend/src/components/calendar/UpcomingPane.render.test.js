// Render test for the mail sidebar's Upcoming section: what it lists, the collapsed state, the rows
// and links that open the calendar, and that it stays out of the way without an account or on an error.

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
const UpcomingPane = (await import('./UpcomingPane.jsx')).default;

const at = (h, m = 0, dayOffset = 0) => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + dayOffset, h, m).toISOString();
};
const ACCOUNT = { id: 'a1', name: 'Fastmail' };
const CALS = [
  { id: 'c1', name: 'Personal', color: '#4f8df7', visible: true },
  { id: 'c2', name: 'Holidays', color: '#e5548c', visible: false },
];
const occ = (over) => ({ id: 'e:', eventId: 'e', calendarId: 'c1', summary: 'x', allDay: false, status: 'CONFIRMED', start: at(12), end: at(13), ...over });

let calls;
let answers;
before(() => {
  for (const name of ['accounts', 'calendars', 'events']) {
    api.calendar[name] = (...a) => {
      calls.push([name, ...a]);
      const r = answers[name];
      const v = typeof r === 'function' ? r(...a) : r;
      return v instanceof Error ? Promise.reject(v) : Promise.resolve(v);
    };
  }
});
beforeEach(() => {
  calls = [];
  localStorage.clear();
  answers = { accounts: [ACCOUNT], calendars: CALS, events: { events: [] } };
  useStore.setState({ showCalendar: false, showContacts: false, calendarFocus: null, mobileSidebarOpen: true });
});

const settle = () => React.act(async () => { await new Promise(r => setTimeout(r, 5)); });
const click = (el) => React.act(async () => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
const section = () => document.querySelector('[data-upcoming]');
const rows = () => [...document.querySelectorAll('[data-upcoming] button[title]')].filter(b => b.getAttribute('aria-label') === null);

let root = null;
async function mount(props = {}) {
  root = createRoot(document.getElementById('root'));
  await React.act(async () => { root.render(React.createElement(UpcomingPane, props)); });
  await settle();
  await settle();
}
afterEach(async () => {
  if (root) await React.act(async () => root.unmount());
  root = null;
  document.body.innerHTML = '<div id="root"></div>';
});

describe('the Upcoming section', () => {
  test('lists what is still ahead under day labels, with a calendar dot and no stripe', async () => {
    answers.events = { events: [
      occ({ id: 'a:', summary: 'Over', start: at(0, 1), end: at(0, 2) }),
      occ({ id: 'b:', summary: 'Standup', start: at(23, 0), end: at(23, 30) }),
      occ({ id: 'c:', summary: 'Hidden one', calendarId: 'c2', start: at(23, 10), end: at(23, 20) }),
      occ({ id: 'd:', summary: 'Dentist', start: at(9, 0, 1), end: at(10, 0, 1) }),
    ] };
    await mount();
    const text = section().textContent;
    assert.ok(text.includes('calendar.upcoming.title'));
    assert.ok(text.includes('Standup') && text.includes('Dentist'));
    assert.ok(!text.includes('Over') && !text.includes('Hidden one'));
    assert.ok(text.includes('calendar.today') && text.includes('calendar.upcoming.tomorrow'));
    const dot = [...section().querySelectorAll('span[aria-hidden]')].find(s => s.style.background.includes('#4f8df7') || s.style.background.includes('rgb(79, 141, 247)'));
    assert.ok(dot, 'a dot in the calendar colour');
    assert.ok(![...section().querySelectorAll('*')].some(el => el.style.boxShadow.includes('inset') || el.style.borderLeft.includes('solid')), 'no coloured stripe');
    assert.equal(callsTo('events').length, 1);
  });

  test('marks an event in progress', async () => {
    const d = new Date();
    answers.events = { events: [occ({ summary: 'Running', start: new Date(d.getTime() - 600000).toISOString(), end: new Date(d.getTime() + 600000).toISOString() })] };
    await mount();
    assert.ok(section().textContent.includes('calendar.upcoming.now'));
  });

  test('says so when there is nothing', async () => {
    await mount();
    assert.ok(section().textContent.includes('calendar.upcoming.empty'));
  });

  test('shows six rows at most, then a link that opens the calendar', async () => {
    answers.events = { events: Array.from({ length: 9 }, (_, i) => occ({ id: `m${i}:`, summary: `Meeting ${i}`, start: at(23, i), end: at(23, 59) })) };
    await mount({ isMobile: true });
    assert.equal(rows().length, 6);
    const more = [...section().querySelectorAll('button')].find(b => b.textContent.startsWith('calendar.more'));
    assert.ok(more.textContent.includes('"count":3'));
    await click(more);
    assert.equal(useStore.getState().showCalendar, true);
    assert.equal(useStore.getState().mobileSidebarOpen, false, 'the drawer closes on a phone');
  });

  test('a row opens the calendar on that event', async () => {
    answers.events = { events: [occ({ id: 'd:', summary: 'Dentist', start: at(9, 0, 2), end: at(10, 0, 2) })] };
    await mount();
    await click(rows()[0]);
    const { showCalendar, calendarFocus } = useStore.getState();
    assert.equal(showCalendar, true);
    assert.equal(calendarFocus.occ.summary, 'Dentist');
    assert.match(calendarFocus.day, /^\d{4}-\d{2}-\d{2}$/);
  });

  test('is absent without an account and while the calendar is open', async () => {
    answers.accounts = [];
    await mount();
    assert.equal(section(), null);
    assert.equal(callsTo('events').length, 0);
  });

  test('is absent in calendar mode and fetches nothing', async () => {
    useStore.setState({ showCalendar: true });
    await mount();
    assert.equal(section(), null);
    assert.equal(calls.length, 0);
  });

  test('collapses, remembers it, and does not fetch events while collapsed', async () => {
    await mount();
    assert.equal(callsTo('events').length, 1);
    await click(section().querySelector('button[aria-expanded]'));
    assert.equal(localStorage.getItem('mailflow:calendar:upcomingOpen'), '0');
    assert.ok(!section().textContent.includes('calendar.upcoming.empty'));
    await React.act(async () => { root.unmount(); });
    root = null;
    calls.length = 0;
    await mount();
    assert.equal(section().querySelector('button[aria-expanded]').getAttribute('aria-expanded'), 'false');
    assert.equal(callsTo('events').length, 0);
  });

  test('hides itself instead of throwing when the calendar API fails', async () => {
    answers.events = new Error('boom');
    await mount();
    assert.equal(section(), null);
    answers = { accounts: new Error('down') };
    await React.act(async () => { root.unmount(); });
    root = null;
    await mount();
    assert.equal(section(), null);
  });
});

function callsTo(name) { return calls.filter(c => c[0] === name); }
