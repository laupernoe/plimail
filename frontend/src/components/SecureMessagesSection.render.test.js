// Render test for Settings → Mail → Protected messages. Pins that the list shows each message's
// state, opens and replies, that revoking and deleting go to the server (deleting only once
// confirmed), and that replies are decrypted here with the message's password, a wrong one
// saying so.
//
// Same loader hooks as WritingStyleSection.render.test.js.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('react-i18next/dist/es/index.js') || url.endsWith('/react-i18next')) {
      return { format: 'module', shortCircuit: true, source: [
        'export const useTranslation = () => ({ t: (k, o) => (o ? k + " " + JSON.stringify(o) : k), i18n: { language: "en", changeLanguage: () => {} } });',
        'export const initReactI18next = { type: "3rdParty", init: () => {} };',
        'export default { useTranslation, initReactI18next };',
      ].join('\n') };
    }
    const path = url.split('?')[0];
    if (path.endsWith('.jsx')) {
      const out = transform(readFileSync(new URL(path), 'utf8'), { transforms: ['jsx'], jsxRuntime: 'automatic', filePath: path });
      return { format: 'module', shortCircuit: true, source: out.code.replaceAll('import.meta.env', 'globalThis.__VITE_ENV__') };
    }
    if (url.startsWith('file:') && url.endsWith('.js')) {
      const code = readFileSync(new URL(url), 'utf8');
      if (code.includes('import.meta.env')) {
        return { format: 'module', shortCircuit: true, source: code.replaceAll('import.meta.env', 'globalThis.__VITE_ENV__') };
      }
    }
    return nextLoad(url, context);
  },
});

const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid/', pretendToBeVisual: true });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document,
  localStorage: dom.window.localStorage, sessionStorage: dom.window.sessionStorage,
  CustomEvent: dom.window.CustomEvent, Node: dom.window.Node, Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };

const { createElement, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: SecureMessagesSection, SECURE_REPLY_EVENT } = await import('./SecureMessagesSection.jsx');
const { sealMessage, sealReply, unlock, toBase64 } = await import('../utils/secureMessageCrypto.js');

const ID = '00000000-0000-4000-8000-000000000001';
const PASSWORD = 'quiet-harbour-7';
let server;
const calls = [];
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
globalThis.fetch = async (url, init = {}) => {
  const path = String(url);
  const method = init.method || 'GET';
  calls.push({ path, method });
  if (path === '/api/secure-messages' && method === 'GET') return json({ messages: server.messages });
  if (path === `/api/secure-messages/${ID}` && method === 'GET') return json(server.detail);
  if (path === `/api/secure-messages/${ID}/revoke`) { server.messages[0].status = 'revoked'; return json({ ok: true }); }
  if (path === `/api/secure-messages/${ID}/read`) { server.messages[0].unreadReplyCount = 0; return json({ ok: true }); }
  if (path === `/api/secure-messages/${ID}` && method === 'DELETE') { server.messages = []; return json({ ok: true }); }
  return json({ error: 'unexpected' }, 500);
};

let root, container;
beforeEach(async () => {
  calls.length = 0;
  const sealed = await sealMessage(PASSWORD, { text: 'x' }, { iterations: 1000 });
  const { encKey } = await unlock(PASSWORD, sealed);
  const reply = await sealReply(encKey, 'Received, thank you.');
  server = {
    messages: [{
      id: ID, status: 'active', recipients: ['bob@example.com'], createdAt: '2026-11-10T09:00:00.000Z',
      expiresAt: '2026-11-17T09:00:00.000Z', firstOpenedAt: '2026-11-10T10:00:00.000Z', openCount: 2,
      replyCount: 1, unreadReplyCount: 1,
    }],
    detail: {
      id: ID, salt: sealed.salt, iterations: sealed.iterations,
      replies: [{ id: 'r1', ciphertext: toBase64(reply.ciphertext), iv: reply.iv, createdAt: '2026-11-11T08:00:00.000Z', readAt: null }],
    },
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root.render(createElement(SecureMessagesSection)); });
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

const until = async (check, ms = 4000) => {
  const end = Date.now() + ms;
  for (;;) {
    await act(async () => { await new Promise(r => setTimeout(r, 15)); });
    if (check()) return;
    if (Date.now() > end) throw new Error(`timed out; shows: ${container.textContent}`);
  }
};
const text = () => container.textContent;
const buttonNamed = key => [...container.querySelectorAll('button')].find(b => b.textContent === key);
const click = el => act(async () => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
function type(input, value) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value').set;
  setter.call(input, value);
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
}
async function showReplies(pw) {
  await click(buttonNamed('admin.secureMessages.readReplies'));
  await act(async () => { type(container.querySelector('input[type="password"]'), pw); });
  await act(async () => { container.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); });
}

test('lists a message with its state, opens and new replies', async () => {
  await until(() => text().includes('bob@example.com'));
  assert.ok(text().includes('admin.secureMessages.statusActive'));
  assert.ok(text().includes('admin.secureMessages.opened'));
  assert.ok(text().includes('"n":2'));
  assert.ok(text().includes('admin.secureMessages.repliesNew'));
});

test('decrypts the replies with the right password and marks them read', async () => {
  await until(() => !!buttonNamed('admin.secureMessages.readReplies'));
  await showReplies(PASSWORD);
  await until(() => text().includes('Received, thank you.'));
  await until(() => calls.some(c => c.path.endsWith('/read')));
});

test('a wrong password shows nothing of the replies', async () => {
  await until(() => !!buttonNamed('admin.secureMessages.readReplies'));
  await showReplies('not the password');
  await until(() => text().includes('admin.secureMessages.wrongPassword'));
  assert.ok(!text().includes('Received'));
  assert.ok(!calls.some(c => c.path.endsWith('/read')));
});

test('revokes, and deletes only once confirmed', async () => {
  await until(() => !!buttonNamed('admin.secureMessages.revoke'));
  await click(buttonNamed('admin.secureMessages.revoke'));
  await until(() => text().includes('admin.secureMessages.statusRevoked'));
  await click(buttonNamed('admin.secureMessages.delete'));
  assert.ok(!calls.some(c => c.method === 'DELETE'));
  await click(buttonNamed('admin.secureMessages.confirmDelete'));
  await until(() => text().includes('admin.secureMessages.empty'));
});

test('reloads when a reply arrives over the WebSocket', async () => {
  await until(() => text().includes('bob@example.com'));
  const before = calls.filter(c => c.path === '/api/secure-messages').length;
  await act(async () => { window.dispatchEvent(new window.CustomEvent(SECURE_REPLY_EVENT)); });
  await until(() => calls.filter(c => c.path === '/api/secure-messages').length > before);
});
