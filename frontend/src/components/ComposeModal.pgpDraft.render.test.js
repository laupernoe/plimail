import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { setImmediate } from 'node:timers';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';

registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith('react-i18next/dist/es/index.js') || url.endsWith('/react-i18next')) {
    return { format: 'module', shortCircuit: true, source: [
      'export const useTranslation = () => ({ t: (key) => key, i18n: { language: "en", changeLanguage: () => {} } });',
      'export const initReactI18next = { type: "3rdParty", init: () => {} };',
      'export const Trans = ({ children }) => children ?? null;',
      'export const I18nextProvider = ({ children }) => children ?? null;',
      'export default { useTranslation, initReactI18next };',
    ].join('\n') };
  }
  if (url.endsWith('.json')) return { format: 'module', shortCircuit: true,
    source: `export default ${readFileSync(new URL(url), 'utf8')}` };
  if (url.endsWith('.jsx')) {
    const code = transform(readFileSync(new URL(url), 'utf8'), {
      transforms: ['jsx'], jsxRuntime: 'automatic', filePath: url,
    }).code;
    return { format: 'module', shortCircuit: true, source: code.replaceAll('import.meta.env', 'globalThis.__VITE_ENV__') };
  }
  if (url.startsWith('file:') && url.endsWith('.js')) {
    const code = readFileSync(new URL(url), 'utf8');
    if (code.includes('import.meta.env')) return { format: 'module', shortCircuit: true,
      source: code.replaceAll('import.meta.env', 'globalThis.__VITE_ENV__') };
  }
  return nextLoad(url, context);
} });

const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid', pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document,
  localStorage: dom.window.localStorage,
  CustomEvent: dom.window.CustomEvent, Node: dom.window.Node, Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement, DOMParser: dom.window.DOMParser,
  MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IS_REACT_ACT_ENVIRONMENT: true, __VITE_ENV__: { MODE: 'test', PROD: true } });
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.matchMedia = dom.window.matchMedia;
globalThis.requestAnimationFrame = cb => setTimeout(() => cb(Date.now()), 0);
globalThis.cancelAnimationFrame = id => clearTimeout(id);

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const ComposeModal = (await import('./ComposeModal.jsx')).default;


const { generateKeyPair, decryptArmored, unlockPrivateKey } = await import('../utils/pgp.js');
const { setKeySecret, forgetKeySecret } = await import('../utils/pgpSecret.js');
const { loadOwnKeys } = await import('../utils/pgpOwnKeys.js');

// A message that goes encrypted is saved as a draft encrypted to the user's own key, and is
// scheduled as its ciphertext: before, its draft went to the server in the clear (stored on IMAP
// and in the database), and Send later refused it. Nothing goes in the clear in its place.

const SECRET = 'v1.secret-from-the-plimail-password';
const mine = await generateKeyPair({ email: 'on@example.test', passphrase: SECRET });
const bob = await generateKeyPair({ email: 'bob@example.net', passphrase: 'bob-pass-123' });
const OWN_KEY = { id: 'k1', fingerprint: mine.fingerprint, emails: ['on@example.test'], armoredPublic: mine.armoredPublic, armoredPrivate: mine.armoredPrivate, protection: 'login' };
let ownKeys = [OWN_KEY];
const BOB = { source: 'keyring', keys: [{ fingerprint: bob.fingerprint, armored: bob.armoredPublic, source: 'manual', verified: true }] };
// The Bcc recipient reads with Bob's key here: what matters is that every recipient has one.
const KNOWN = { 'bob@example.net': BOB, 'hidden@example.org': BOB };
const requests = [];
globalThis.fetch = async (url, init = {}) => {
  const path = String(url);
  requests.push({ path, body: init.body ? JSON.parse(init.body) : null });
  if (path === '/api/pgp/keys') return { ok: true, status: 200, json: async () => ({ keys: ownKeys }) };
  if (path === '/api/pgp/lookup') {
    const { emails } = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => ({ results: Object.fromEntries(emails.map(e => [e, KNOWN[e] || { source: null, keys: [] }])) }) };
  }
  if (path === '/api/mail/draft') return { ok: true, status: 200, json: async () => ({ uid: 4, folder: 'Drafts' }) };
  if (path === '/api/mail/scheduled') {
    const { sendAt } = JSON.parse(init.body);
    return { ok: true, status: 201, json: async () => ({ id: 's1', sendAt, status: 'scheduled' }) };
  }
  return { ok: true, status: 200, json: async () => ({}) };
};
const ACCOUNTS = [{ id: 'on', email_address: 'on@example.test', aliases: [], signature: '', signature_enabled: false }];
const click = el => React.act(async () => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
const settle = () => React.act(async () => { for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)); });
const lookedUp = async () => { await settle(); await React.act(() => new Promise(r => setTimeout(r, 450))); await settle(); };
const until = async (check, ms = 15000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await React.act(() => new Promise(r => setTimeout(r, 25)));
  }
};
const buttonText = text => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === text);
const request = path => requests.find(r => r.path === path)?.body;
async function mount(composeData) {
  await loadOwnKeys({ fresh: true });
  useStore.setState({ user: { id: 'u-draft' }, accounts: ACCOUNTS, plaintextEmail: true, composing: true, prepareComposeSwitch: null, composeData, composeSession: 1, pgpAutoEncrypt: true, notifications: [] });
  setKeySecret('u-draft', SECRET);
  const root = createRoot(document.getElementById('root'));
  await React.act(async () => root.render(React.createElement(ComposeModal)));
  await lookedUp();
  return root;
}
const unmount = async root => { await React.act(async () => root.unmount()); forgetKeySecret(); ownKeys = [OWN_KEY]; };
const ownDecrypt = async armored => new TextDecoder().decode((await decryptArmored(armored, { decryptionKey: await unlockPrivateKey(mine.armoredPrivate, SECRET) })).data);

test('a draft of a message that goes encrypted is saved encrypted to the user\'s own key', async () => {
  const root = await mount({ accountId: 'on', to: ['bob@example.net'], bcc: ['hidden@example.org'], subject: 'Plans', body: 'the secret plan' });
  try {
    await until(() => buttonText('compose.sendEncryptedShort'));
    requests.length = 0;
    await click(buttonText('compose.saveDraft'));
    await until(() => request('/api/mail/draft'));
    const sent = request('/api/mail/draft');
    assert.ok(!JSON.stringify(sent).includes('secret plan'), 'nothing of the text in the clear');
    assert.equal(sent.body, undefined);
    assert.equal(sent.subject, 'Plans');
    assert.deepEqual(sent.bcc, ['hidden@example.org']);
    assert.match(sent.pgp.encrypted, /^-----BEGIN PGP MESSAGE-----/);
    const inside = await ownDecrypt(sent.pgp.encrypted);
    assert.ok(inside.includes('the secret plan'));
    assert.match(inside, /X-Plimail-Encryption: auto/);
    const bobKey = await unlockPrivateKey(bob.armoredPrivate, 'bob-pass-123');
    await assert.rejects(decryptArmored(sent.pgp.encrypted, { decryptionKey: bobKey }), 'for the user only');
  } finally { await unmount(root); }
});

test('a plain message\'s draft stays as it was', async () => {
  const root = await mount({ accountId: 'on', to: ['nokey@example.org'], subject: 'Plans', body: 'ordinary text' });
  try {
    requests.length = 0;
    await click(buttonText('compose.saveDraft'));
    await until(() => request('/api/mail/draft'));
    assert.equal(request('/api/mail/draft').body, 'ordinary text');
    assert.equal(request('/api/mail/draft').pgp, undefined);
  } finally { await unmount(root); }
});

test('encryption required with no key of the user\'s own: the draft is not saved, and the composer says so', async () => {
  ownKeys = [];
  const root = await mount({ accountId: 'on', to: ['bob@example.net'], subject: 'Plans', body: 'the secret plan', restored: true, protection: { mode: 'pgp', sign: true } });
  try {
    requests.length = 0;
    await click(buttonText('compose.saveDraft'));
    await until(() => document.body.textContent.includes('pgp.draft.notSavedNoKey'));
    assert.equal(requests.filter(r => r.path === '/api/mail/draft').length, 0, 'nothing saved, in the clear or otherwise');
  } finally { await unmount(root); }
});

test('Send later of an encrypted message stores its ciphertext, and nothing of the text', async () => {
  const root = await mount({ accountId: 'on', to: ['bob@example.net'], bcc: ['hidden@example.org'], subject: 'Plans', body: 'the secret plan' });
  try {
    await until(() => buttonText('compose.sendEncryptedShort'));
    requests.length = 0;
    await click(document.querySelector('[data-send-later]'));
    await click(document.querySelector('[role="menu"] [data-preset="tomorrowMorning"]'));
    await until(() => request('/api/mail/scheduled'));
    const sent = request('/api/mail/scheduled');
    assert.ok(!JSON.stringify(sent).includes('secret plan'), 'nothing of the text in the clear');
    assert.equal(sent.body, '');
    assert.deepEqual(sent.bcc, ['hidden@example.org']);
    assert.match(sent.pgp.encrypted, /^-----BEGIN PGP MESSAGE-----/);
    assert.ok((await ownDecrypt(sent.pgp.encrypted)).includes('the secret plan'), 'the Sent copy stays readable');
    const bobKey = await unlockPrivateKey(bob.armoredPrivate, 'bob-pass-123');
    assert.ok(new TextDecoder().decode((await decryptArmored(sent.pgp.encrypted, { decryptionKey: bobKey })).data).includes('the secret plan'));
  } finally { await unmount(root); }
});
