// Render test for the invitations inbox: the count on the calendar toolbar's button, the list it
// opens, answering from it (once per click, out of the list, into the answered), and the bar above
// the mail an invitation came in, which answers the same invitation.

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

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../../store/index.js');
const { api } = await import('../../utils/api.js');
const CalendarToolbar = (await import('./CalendarToolbar.jsx')).default;
const InvitationsPanel = (await import('./InvitationsPanel.jsx')).default;
const MailInviteBar = (await import('./MailInviteBar.jsx')).default;
const { afterAnswer, pendingCount } = await import('./invitations.js');

const inv = (over) => ({
  uid: 'u1', recurrenceId: null, sequence: 0, source: 'mail', status: 'NEEDS-ACTION', summary: 'Budget review', location: 'Room 4',
  allDay: false, start: '2037-03-10T09:00:00.000Z', end: '2037-03-10T10:00:00.000Z', isRecurring: false,
  organizer: { name: 'The Boss', email: 'boss@example.com' }, invitedAs: 'noe@example.com', accountName: 'Work',
  messageId: 'm1', messageIds: ['m1'], eventId: null, conflicts: [], ...over,
});

let replies;
let replyAnswer;
before(() => {
  api.calendar.replyInvitation = (i, status, meta) => {
    replies.push([i.uid, status, meta?.lang]);
    return replyAnswer instanceof Error ? Promise.reject(replyAnswer) : new Promise(r => setTimeout(() => r(replyAnswer), 10));
  };
  api.calendar.invitations = async () => useStore.getState().invitations;
});
beforeEach(() => {
  replies = [];
  replyAnswer = { ok: true, invitesSent: 1 };
  useStore.setState({
    invitations: { invitations: [inv(), inv({ uid: 'u2', summary: 'Offsite', messageId: null, messageIds: [], conflicts: [{ summary: 'Dentist' }] })], answered: [] },
    invitationsError: null, showCalendar: false, calendarFocus: null,
  });
});

const settle = () => React.act(async () => { await new Promise(r => setTimeout(r, 30)); });
const click = (el) => React.act(async () => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
const buttons = (text) => [...document.querySelectorAll('button')].filter(b => b.textContent === text);

let root = null;
async function mount(element) {
  root = createRoot(document.getElementById('root'));
  await React.act(async () => { root.render(element); });
  await settle();
}
afterEach(async () => {
  if (root) await React.act(async () => root.unmount());
  root = null;
  document.body.innerHTML = '<div id="root"></div>';
});

function Panel() {
  const data = useStore(s => s.invitations);
  return React.createElement(InvitationsPanel, { rect: { right: 600, bottom: 50 }, isMobile: false, onClose: () => {}, data, locale: 'en', meta: { lang: 'en' }, onOpenMail: () => {}, onShow: () => {} });
}

describe('the invitations inbox', () => {
  test('the toolbar button carries the count of invitations waiting', async () => {
    let toggled = null;
    await mount(React.createElement(CalendarToolbar, {
      title: 'March', view: 'week', onView() {}, onToday() {}, onPrev() {}, onNext() {}, isMobile: false,
      invitations: { count: pendingCount(useStore.getState().invitations), open: false, onToggle: (r) => { toggled = r; } },
    }));
    const button = document.querySelector('[data-invitations-button] button');
    assert.ok(button.getAttribute('aria-label').includes('calendar.invitations.button'));
    assert.ok(button.getAttribute('aria-label').includes('"count":2'));
    assert.equal(document.querySelector('[data-invitations-button] span[aria-hidden]').textContent, '2');
    await click(button);
    assert.ok(toggled, 'opens with the button\'s place');
  });

  test('no count shows when nothing waits', async () => {
    await mount(React.createElement(CalendarToolbar, {
      title: 'March', view: 'week', onView() {}, onToday() {}, onPrev() {}, onNext() {}, isMobile: false,
      invitations: { count: 0, open: false, onToggle() {} },
    }));
    assert.equal(document.querySelector('[data-invitations-button] span[aria-hidden]'), null);
  });

  test('lists each invitation with its organizer, place, conflicts and answers', async () => {
    await mount(React.createElement(Panel));
    const items = document.querySelectorAll('ul[aria-label="calendar.invitations.title"] > li');
    assert.equal(items.length, 2);
    const first = items[0].textContent;
    assert.ok(first.includes('Budget review') && first.includes('Room 4'));
    assert.ok(first.includes('calendar.invitations.from') && first.includes('The Boss'));
    assert.ok(items[1].textContent.includes('calendar.invitations.conflict') && items[1].textContent.includes('Dentist'));
    assert.equal(items[0].querySelectorAll('button[aria-pressed]').length, 3);
    assert.ok(items[0].querySelector('button[aria-label="calendar.invitations.openMail"]'), 'a link to the mail it came in');
    assert.equal(items[1].querySelector('button[aria-label="calendar.invitations.openMail"]'), null, 'none without a mail');
  });

  test('accepting sends one answer, takes the invitation out of the list and counts it answered', async () => {
    await mount(React.createElement(Panel));
    const yes = buttons('calendar.reply.yes')[0];
    await React.act(async () => {
      yes.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      yes.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    await settle();
    assert.deepEqual(replies, [['u1', 'ACCEPTED', 'en']]);
    const state = useStore.getState().invitations;
    assert.deepEqual(state.invitations.map(i => i.uid), ['u2']);
    assert.equal(state.answered[0].uid, 'u1');
    assert.equal(state.answered[0].status, 'ACCEPTED');
    assert.equal(document.querySelectorAll('ul[aria-label="calendar.invitations.title"] > li').length, 1);
    assert.ok(document.body.textContent.includes('calendar.invitations.answered'));
  });

  test('an answer that fails stays in the list and says why', async () => {
    replyAnswer = Object.assign(new Error('SMTP said no'), { status: 502 });
    await mount(React.createElement(Panel));
    await click(buttons('calendar.reply.no')[0]);
    await settle();
    assert.equal(useStore.getState().invitations.invitations.length, 2);
    const alert = document.querySelector('[role="alert"]');
    assert.ok(alert && alert.textContent.includes('calendar.invitations.failed') && alert.textContent.includes('SMTP said no'));
  });

  test('the bar above the mail answers the same invitation, and then shows the answer', async () => {
    await mount(React.createElement(MailInviteBar, { messageId: 'm1' }));
    assert.ok(document.querySelector('[aria-label="calendar.invitations.mailLabel"]'));
    await click(buttons('calendar.reply.maybe')[0]);
    await settle();
    assert.deepEqual(replies.map(r => r.slice(0, 2)), [['u1', 'TENTATIVE']]);
    assert.equal(pendingCount(useStore.getState().invitations), 1);
    assert.ok(document.body.textContent.includes('calendar.invitations.yourAnswer'));
    assert.equal(buttons('calendar.reply.maybe')[0].getAttribute('aria-pressed'), 'true');
  });

  test('no bar on mail that carries no invitation', async () => {
    await mount(React.createElement(MailInviteBar, { messageId: 'other' }));
    assert.equal(document.querySelector('[aria-label="calendar.invitations.mailLabel"]'), null);
  });
});

describe('afterAnswer', () => {
  test('moves the invitation from waiting to answered, for one occurrence only', () => {
    const data = { invitations: [inv(), inv({ recurrenceId: '2037-03-17T09:00:00.000Z' })], answered: [] };
    const out = afterAnswer(data, data.invitations[1], 'DECLINED', new Date('2037-01-01T00:00:00Z'));
    assert.equal(out.invitations.length, 1);
    assert.equal(out.invitations[0].recurrenceId, null);
    assert.deepEqual([out.answered[0].status, out.answered[0].answeredAt], ['DECLINED', '2037-01-01T00:00:00.000Z']);
  });
});
