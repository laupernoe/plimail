// Render test for emoji reactions in a conversation (utils/reactions.js): a reaction is a chip
// under the message it reacts to, not a card of its own, and the picker sends the emoji for the
// message it was opened on. Same loader hooks as ConversationPane.render.test.js.

import { test, describe, before, after } from 'node:test';
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
  window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
  CustomEvent: dom.window.CustomEvent, Node: dom.window.Node, Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement, getComputedStyle: dom.window.getComputedStyle,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
dom.window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.requestAnimationFrame ??= cb => setTimeout(() => cb(Date.now()), 0);
globalThis.cancelAnimationFrame ??= id => clearTimeout(id);
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };


const me = 'me@x.z';
const THREAD = [
  { id: 'm1', account_id: 'acct', folder: 'INBOX', message_id: '<1@x>', subject: 'Plans', from_email: 'ana@x.z', from_name: 'Ana', to_addresses: [{ email: me }], cc_addresses: [], date: '2026-01-01T10:00:00Z', is_read: true, snippet: 'first' },
  { id: 'm3', account_id: 'acct', folder: 'INBOX', message_id: '<3@x>', subject: 'Re: Plans', from_email: 'ana@x.z', from_name: 'Ana', to_addresses: [{ email: me }], cc_addresses: [], date: '2026-01-03T10:00:00Z', is_read: true, snippet: 'newest message' },
  // Newer than everything: still not the card the conversation opens on.
  { id: 'r1', account_id: 'acct', folder: 'INBOX', message_id: '<r1@x>', in_reply_to: '<1@x>', reaction_emoji: '👍', subject: 'Re: Plans', from_email: 'bob@x.z', from_name: 'Bob', date: '2026-01-04T10:00:00Z', is_read: false, snippet: '👍' },
  { id: 'r2', account_id: 'acct', folder: 'Sent', message_id: '<r2@x>', in_reply_to: '<1@x>', reaction_emoji: '👍', subject: 'Re: Plans', from_email: me, from_name: 'Me', date: '2026-01-04T11:00:00Z', is_read: true, snippet: '👍' },
  // A reaction to a message that is not in the conversation stays an ordinary card.
  { id: 'r3', account_id: 'acct', folder: 'INBOX', message_id: '<r3@x>', in_reply_to: '<gone@x>', reaction_emoji: '😮', subject: 'Re: Plans', from_email: 'kim@x.z', from_name: 'Kim', date: '2026-01-02T10:00:00Z', is_read: true, snippet: '😮' },
];
const reactionPosts = [];
const bulkReads = [];
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes('/mail/thread?')) return { ok: true, status: 200, json: async () => ({ messages: THREAD }) };
  if (u.includes('/mail/send/reaction')) {
    reactionPosts.push({ method: opts.method, headers: opts.headers, body: JSON.parse(opts.body) });
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  }
  if (u.includes('/mail/messages/bulk-read')) {
    bulkReads.push(JSON.parse(opts.body));
    return { ok: true, status: 200, json: async () => ({}) };
  }
  const id = /\/messages\/([^/]+)\/body/.exec(u)?.[1];
  if (id) return { ok: true, status: 200, json: async () => ({ html: '', text: `body of ${id}`, attachments: [] }) };
  return { ok: true, status: 200, json: async () => ({}) };
};

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const ConversationPane = (await import('./ConversationPane.jsx')).default;
const { useStore } = await import('../store/index.js');

let root;
before(() => { root = createRoot(document.getElementById('root')); });
after(async () => { await React.act(async () => root.unmount()); });
const settle = () => React.act(async () => { await new Promise(r => setTimeout(r, 50)); });

const card = id => document.querySelector(`[data-message-id="${id}"]`);
const chips = id => [...card(id).querySelectorAll('[role="group"][aria-label="reactions.label"] button')];

describe('reactions in a conversation', () => {
  before(async () => {
    useStore.setState({ darkEmailBodies: false, markReadBehavior: 'immediate', accounts: [{ id: 'acct', email_address: me, name: 'Me', sender_name: 'Me' }] });
    await React.act(async () => {
      root.render(React.createElement(ConversationPane, { threadId: '<1@x>', folder: 'INBOX' }));
    });
    await settle();
  });

  test('shows a reaction as a chip under its message, not as a card', () => {
    const ids = [...document.querySelectorAll('[data-message-id]')].map(el => el.dataset.messageId);
    assert.deepEqual(ids, ['m1', 'r3', 'm3'], 'reactions to a message on screen have no card; one to a missing message keeps its card');
    const [thumbs] = chips('m1');
    assert.ok(thumbs, 'the reacted-to message carries a chip');
    assert.match(thumbs.textContent, /👍\s*2/, 'one chip per emoji, with how many sent it');
    assert.equal(thumbs.getAttribute('title'), 'Bob, reactions.you', 'the tooltip says who reacted');
    assert.equal(thumbs.getAttribute('aria-pressed'), 'true', 'the reader\'s own reaction shows pressed');
  });

  test('opens on the newest message, not on a newer reaction, and reads the reactions it shows', async () => {
    const open = [...document.querySelectorAll('[data-message-id] > button[aria-expanded="true"]')].map(b => b.parentElement.dataset.messageId);
    assert.deepEqual(open, ['m3']);
    // Opening m1 reads Bob's reaction with it: it has no card of its own to open.
    await React.act(async () => { card('m1').querySelector('button[aria-expanded]').click(); });
    await settle();
    assert.ok(bulkReads.some(b => JSON.stringify(b).includes('"r1"')), 'the reaction is marked read');
  });

  test('the picker sends the chosen emoji for the message it was opened on', async () => {
    const reactBtn = card('m3').querySelector('button[aria-label="reactions.react"]');
    assert.ok(reactBtn, 'an opened message has a React button');
    assert.equal(reactBtn.getAttribute('aria-haspopup'), 'menu');
    await React.act(async () => { reactBtn.click(); });
    const menu = card('m3').querySelector('[role="menu"]');
    assert.ok(menu, 'the picker opens');
    const items = [...menu.querySelectorAll('[role="menuitem"]')];
    assert.equal(items.length, 7, 'six quick emoji and More');
    assert.equal(document.activeElement, items[0], 'focus moves into the picker');
    // Keyboard: Arrow Right to the next emoji.
    await React.act(async () => { items[0].dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); });
    assert.equal(document.activeElement, items[1]);
    // QUICK_REACTIONS[3] is 🎉.
    await React.act(async () => { items[3].click(); });
    await settle();
    assert.equal(reactionPosts.length, 1);
    assert.equal(reactionPosts[0].method, 'POST');
    assert.deepEqual(reactionPosts[0].body, { messageId: 'm3', emoji: '🎉' });
    assert.ok(reactionPosts[0].headers['X-Requested-With'], 'a browser request carries the CSRF header');
    assert.equal(card('m3').querySelector('[role="menu"]'), null, 'the picker closes');
    const [mine] = chips('m3');
    assert.match(mine?.textContent || '', /🎉\s*1/, 'the reaction shows at once');
  });

  test('a chip of someone else\'s emoji adds the reader\'s own', async () => {
    reactionPosts.length = 0;
    // Bob reacted 👍 to m1 too, but the reader already did: that chip sends nothing.
    await React.act(async () => { chips('m1')[0].click(); });
    assert.equal(reactionPosts.length, 0);
    assert.equal(chips('m1')[0].getAttribute('aria-disabled'), 'true');
  });
});
