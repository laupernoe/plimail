// Render test for deleting several messages at once from the list: the selection toolbar's
// labelled Delete button, the confirmation before mail already in Trash is expunged, batches no
// larger than the server takes, and an error that says why mail was kept.
//
// The harness is MessageList.render.test.js's: the loader hook transforms .jsx with sucrase,
// react-i18next is stubbed to return the key, and fetch serves the list and records requests.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('react-i18next/dist/es/index.js') || url.endsWith('/react-i18next')) {
      return { format: 'module', shortCircuit: true, source: [
        'export const useTranslation = () => ({ t: (k, d) => (typeof d === "string" ? d : d?.defaultValue ?? k), i18n: { language: "en", changeLanguage: () => {} } });',
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
      const code = readFileSync(new URL(url), 'utf8');
      const out = transform(code, { transforms: ['jsx'], jsxRuntime: 'automatic', filePath: url });
      return { format: 'module', shortCircuit: true, source: shimViteEnv(out.code) };
    }
    if (url.startsWith('file:') && url.endsWith('.js')) {
      const code = readFileSync(new URL(url), 'utf8');
      if (code.includes('import.meta.env')) {
        return { format: 'module', shortCircuit: true, source: shimViteEnv(code) };
      }
    }
    return nextLoad(url, context);
  },
});

const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid', pretendToBeVisual: true });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document,
  localStorage: dom.window.localStorage, CustomEvent: dom.window.CustomEvent,
  Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
  getComputedStyle: dom.window.getComputedStyle,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IS_REACT_ACT_ENVIRONMENT: true,
});
// useMobile() reads window.innerWidth first, then subscribes to matchMedia. jsdom defaults
// innerWidth to 1024, which is the desktop case the bug report is about.
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
dom.window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.matchMedia = dom.window.matchMedia;
dom.window.Element.prototype.scrollIntoView = () => {};
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };
// MessageList loads its own messages on mount and overwrites anything seeded in the store,
// so the fetch stub has to serve the row rather than the store. Only the messages endpoint
// needs a real shape; everything else can be an empty object, unless a test serves a path
// through ROUTES as [status, body].
let SERVED = [];
let ROUTES = {};
// Every request, with its JSON body, for tests that assert what reached the server.
let CALLS = [];
globalThis.fetch = async (url, opts = {}) => {
  const path = String(url);
  let sent = null;
  try { sent = typeof opts.body === 'string' ? JSON.parse(opts.body) : null; } catch { /* not JSON */ }
  CALLS.push({ path, method: opts.method || 'GET', body: sent });
  // A route may carry response headers as a third element.
  const [status, body, headers = {}] = Object.entries(ROUTES).find(([p]) => path.endsWith(p))?.[1]
    ?? [200, path.includes('/mail/messages?') ? { messages: SERVED, total: SERVED.length } : {}];
  return { ok: status < 400, status, headers: { get: name => headers[name] ?? (/content-type/i.test(name) ? 'application/json' : null) }, json: async () => body, text: async () => JSON.stringify(body) };
};

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const MessageList = (await import('./MessageList.jsx')).default;

const ACCOUNT = { id: 'acct-1', email_address: 'a@example.com', name: 'A', color: '#6366f1', include_in_unified_inbox: true };
const FOLDERS = { 'acct-1': [{ path: 'INBOX', name: 'INBOX' }, { path: 'Trash', name: 'Trash', special_use: '\\Trash' }] };
const row = (n, folder = 'INBOX') => ({
  id: `msg-${n}`, account_id: 'acct-1', folder, uid: n,
  subject: `Subject ${n}`, snippet: '', message_id: `<m${n}@example.com>`,
  from_name: 'Sender', from_address: 's@example.com', date: new Date(Date.now() - n * 60_000).toISOString(),
  is_read: true, is_starred: false, is_deleted: false, has_attachments: false,
});

let container, root;
const doc = dom.window.document;
const settle = () => React.act(async () => { await new Promise(r => setTimeout(r, 30)); });

async function mount(rows, folder = 'INBOX') {
  SERVED = rows;
  if (root) await React.act(async () => root.unmount());
  container = doc.getElementById('root');
  useStore.setState({
    accounts: [ACCOUNT], accountsReady: true,
    selectedAccountId: 'acct-1', selectedFolder: folder, selectedMessageId: null,
    messages: rows, messagesTotal: rows.length, hasMoreMessages: false, loadingMessages: false,
    searchQuery: '', threadedView: false, folders: FOLDERS, notifications: [],
  });
  await React.act(async () => {
    root = createRoot(container);
    root.render(React.createElement(MessageList));
  });
  await settle();
  CALLS = [];
}

const click = async (el) => {
  assert.ok(el, 'expected the element to click');
  await React.act(async () => { el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })); });
  await settle();
};
const button = label => container.querySelector(`button[aria-label="${label}"]`);
async function selectAll() {
  await click(button('messageList.selectMessages'));
  await click(container.querySelector('input[aria-label="messageList.selectAll"]'));
}
// Unmounting sends a pending delete at once instead of after the undo window.
async function flush() {
  await React.act(async () => root.unmount());
  root = null;
  useStore.setState({ notifications: [] });
  await settle();
  return CALLS.filter(c => c.path.endsWith('/mail/messages/bulk-delete')).map(c => c.body.ids);
}

describe('MessageList — deleting a selection', () => {
  test('the toolbar shows a labelled Delete that sends exactly the selected messages', async () => {
    ROUTES = {};
    await mount([row(1), row(2), row(3)]);
    await selectAll();
    const del = button('messageList.deleteSelected');
    assert.ok(del, 'expected a Delete button in the selection toolbar');
    assert.equal(del.textContent, 'contextMenu.delete');
    await click(del);
    assert.equal(container.querySelectorAll('[data-msgid]').length, 0, 'the rows leave the list at once');
    const sent = await flush();
    assert.deepEqual(sent.flat().sort(), ['msg-1', 'msg-2', 'msg-3']);
  });

  test('a selection larger than the server takes goes out in batches of 500', async () => {
    ROUTES = {};
    await mount(Array.from({ length: 520 }, (_, i) => row(i + 1)));
    await selectAll();
    await click(button('messageList.deleteSelected'));
    const sent = await flush();
    assert.deepEqual(sent.map(ids => ids.length), [500, 20]);
    assert.equal(new Set(sent.flat()).size, 520);
  });

  test('in Trash it asks first, and Cancel deletes nothing', async () => {
    ROUTES = {};
    await mount([row(1, 'Trash'), row(2, 'Trash')], 'Trash');
    await selectAll();
    const del = button('messageList.deleteForever');
    assert.ok(del, 'expected Delete forever in Trash');
    await click(del);
    assert.ok(doc.querySelector('[role="alertdialog"]'), 'expected a confirmation');
    assert.equal(container.querySelectorAll('[data-msgid]').length, 2, 'nothing leaves the list before a yes');
    await click([...doc.querySelectorAll('[role="alertdialog"] button')].find(b => b.textContent === 'common.cancel'));
    assert.equal(doc.querySelector('[role="alertdialog"]'), null);
    assert.equal(container.querySelectorAll('[data-msgid]').length, 2);
    assert.deepEqual(await flush(), []);
  });

  test('in Trash, confirming sends the selection', async () => {
    ROUTES = {};
    await mount([row(1, 'Trash'), row(2, 'Trash')], 'Trash');
    await selectAll();
    await click(button('messageList.deleteForever'));
    await click(doc.querySelector('[data-confirm-permanent-delete]'));
    assert.equal(doc.querySelector('[role="alertdialog"]'), null);
    assert.deepEqual((await flush()).flat().sort(), ['msg-1', 'msg-2']);
  });

  test('mail the server kept comes back with the reason it gives', async () => {
    ROUTES = { '/mail/messages/bulk-delete': [200, { ok: true, deleted: ['msg-1'], failed: [{ id: 'msg-2', reason: 'no_trash' }] }] };
    await mount([row(1), row(2)]);
    await selectAll();
    await click(button('messageList.deleteSelected'));
    // The request goes out when the undo window closes.
    await React.act(async () => { await new Promise(r => setTimeout(r, 5200)); });
    const ids = [...container.querySelectorAll('[data-msgid]')].map(el => el.getAttribute('data-msgid'));
    assert.deepEqual(ids, ['msg-2']);
    const error = useStore.getState().notifications.find(n => n.type === 'error');
    assert.ok(error, 'expected an error notification');
    assert.equal(error.body, 'messageList.bulkDeleted.noTrash');
    await flush();
    ROUTES = {};
  });
});

describe('MessageList — dragging a selection to a folder', () => {
  const dragEvent = (type, dropEffect) => {
    const ev = new dom.window.Event(type, { bubbles: true, cancelable: true });
    const data = {};
    ev.dataTransfer = { dropEffect, effectAllowed: 'all', setData: (k, v) => { data[k] = v; }, getData: k => data[k] };
    return ev;
  };
  const draggedRow = () => container.querySelector('[data-msgid] [draggable="true"], [data-msgid][draggable="true"]');

  test('a drop ends selection mode at once', async () => {
    ROUTES = {};
    await mount([row(1), row(2)]);
    await selectAll();
    assert.ok(button('messageList.deleteSelected'), 'selection mode is on');
    const src = draggedRow();
    assert.ok(src, 'expected a draggable row');
    await React.act(async () => { src.dispatchEvent(dragEvent('dragstart', 'none')); });
    await React.act(async () => { src.dispatchEvent(dragEvent('dragend', 'move')); });
    await settle();
    assert.equal(button('messageList.deleteSelected'), null, 'selection mode is off');
    assert.equal(container.querySelectorAll('input[type="checkbox"]:checked').length, 0, 'nothing stays checked');
    await flush();
  });

  test('a cancelled drag keeps the selection', async () => {
    ROUTES = {};
    await mount([row(1), row(2)]);
    await selectAll();
    const src = draggedRow();
    await React.act(async () => { src.dispatchEvent(dragEvent('dragstart', 'none')); });
    await React.act(async () => { src.dispatchEvent(dragEvent('dragend', 'none')); });
    await settle();
    assert.ok(button('messageList.deleteSelected'), 'selection mode stays on');
    await flush();
  });
});
