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

// A protected message put back in the composer (undone send, failed held send, the screen lock)
// must reopen protected. It reopened plain, and Send then delivered it in the clear. Automatic
// encryption counts: a message going encrypted because every recipient had a key reopens
// encrypted too, and one the user said not to encrypt stays so.

const bob = await generateKeyPair({ email: 'bob@example.net', passphrase: 'bob-pass-123' });
const OWN_KEY = { id: 'k1', fingerprint: 'ab'.repeat(20), emails: ['on@example.test'], armoredPublic: 'x', armoredPrivate: 'y', protection: 'login' };
let ownKeys = [OWN_KEY];
const KNOWN = { 'bob@example.net': { source: 'keyring', keys: [{ fingerprint: bob.fingerprint, armored: bob.armoredPublic, source: 'manual', verified: true }] } };
const requests = [];
globalThis.fetch = async (url, init = {}) => {
  const path = String(url);
  requests.push({ path, body: init.body ? JSON.parse(init.body) : null });
  if (path === '/api/pgp/keys') return { ok: true, status: 200, json: async () => ({ keys: ownKeys }) };
  if (path === '/api/pgp/lookup') {
    const { emails } = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => ({ results: Object.fromEntries(emails.map(e => [e, KNOWN[e] || { source: null, keys: [] }])) }) };
  }
  return { ok: true, status: 200, json: async () => ({}) };
};
const ACCOUNTS = [{ id: 'on', email_address: 'on@example.test', aliases: [], signature: '', signature_enabled: false }];
const click = el => React.act(async () => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
const settle = () => React.act(async () => { for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)); });
// The recipients' lookup waits 400 ms for typing to stop.
const lookedUp = async () => { await settle(); await React.act(() => new Promise(r => setTimeout(r, 450))); await settle(); };
const line = () => document.querySelector('[data-encryption-line]');
// Under load the lookup and the key checks take longer than the debounce: wait for what is due.
const until = async (check, ms = 15000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await React.act(() => new Promise(r => setTimeout(r, 25)));
  }
};
const buttonText = text => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === text);
const keep = async () => {
  await React.act(async () => { window.dispatchEvent(new window.CustomEvent('mailflow:will-lock')); });
  return useStore.getState().composeData;
};
async function mount(composeData, { auto = true } = {}) {
  useStore.setState({ accounts: ACCOUNTS, plaintextEmail: true, composing: true, prepareComposeSwitch: null, composeData, composeSession: 1, pgpAutoEncrypt: auto });
  const root = createRoot(document.getElementById('root'));
  await React.act(async () => root.render(React.createElement(ComposeModal)));
  await lookedUp();
  return root;
}
const unmount = root => React.act(async () => root.unmount());

test('a message to a recipient with a key goes encrypted with no step, and says so', async () => {
  const root = await mount({ accountId: 'on', to: ['bob@example.net'], subject: 's', body: 'hi' });
  try {
    await until(() => line());
    assert.equal(line()?.dataset.encryptionLine, 'on');
    assert.ok(line().textContent.includes('pgp.compose.willEncrypt'));
    assert.ok(buttonText('compose.sendEncryptedShort'), 'Send says it encrypts');
    assert.deepEqual((await keep()).protection, { mode: 'pgp', sign: true, auto: true });
  } finally { await unmount(root); }
});

test('a recipient without a key: plain Send, no line, nothing kept as protection', async () => {
  const root = await mount({ accountId: 'on', to: ['bob@example.net', 'nokey@example.org'], subject: 's', body: 'hi' });
  try {
    assert.equal(line(), null);
    assert.ok(buttonText('compose.send'));
    assert.equal((await keep()).protection, null);
  } finally { await unmount(root); }
});

test('automatic encryption turned off in Settings: plain', async () => {
  const root = await mount({ accountId: 'on', to: ['bob@example.net'], subject: 's', body: 'hi' }, { auto: false });
  try {
    assert.equal(line(), null);
    assert.ok(buttonText('compose.send'));
    assert.equal((await keep()).protection, null);
  } finally { await unmount(root); }
});

test('"Don\'t encrypt" turns it off for this message, and a restore keeps it off', async () => {
  const root = await mount({ accountId: 'on', to: ['bob@example.net'], subject: 's', body: 'hi' });
  try {
    await until(() => buttonText('pgp.compose.dontEncrypt'));
    await click(buttonText('pgp.compose.dontEncrypt'));
    assert.equal(line()?.dataset.encryptionLine, 'off');
    assert.ok(buttonText('compose.send'));
    assert.deepEqual((await keep()).protection, { mode: 'plain' });
  } finally { await unmount(root); }
  const again = await mount({ accountId: 'on', to: ['bob@example.net'], subject: 's', body: 'hi', restored: true, protection: { mode: 'plain' } });
  try {
    await until(() => line());
    assert.equal(line()?.dataset.encryptionLine, 'off');
    assert.ok(buttonText('compose.send'));
  } finally { await unmount(again); }
});

test('a restored encrypted message stays encrypted when a recipient has no key now: it never goes plain', async () => {
  const root = await mount({ accountId: 'on', to: ['nokey@example.org'], subject: 's', body: 'hi', restored: true, protection: { mode: 'pgp', sign: false, auto: true } });
  try {
    assert.equal(line()?.dataset.encryptionLine, 'on');
    assert.ok(buttonText('compose.sendEncryptedShort'));
    requests.length = 0;
    await click(buttonText('compose.sendEncryptedShort'));
    await settle();
    assert.equal(requests.filter(r => r.path === '/api/mail/send').length, 0, 'nothing sent');
    assert.ok(document.querySelector('section[aria-label="compose.sendEncrypted"]'), 'the panel says who has no key');
    assert.ok(buttonText('pgp.compose.sendPlain'), 'sending it plain is the user\'s choice');
    assert.deepEqual((await keep()).protection, { mode: 'pgp', sign: false, auto: true });
  } finally { await unmount(root); }
});

test('a restored password-protected message reopens in that mode, asking for the password again', async () => {
  const root = await mount({ accountId: 'on', to: ['bob@example.net'], subject: 's', body: 'hi', restored: true, protection: { mode: 'password', expiresInDays: 30 } });
  try {
    assert.ok(document.querySelector('section[aria-label="compose.sendWithPassword"]'));
    const passwords = [...document.querySelectorAll('input[type="password"]')];
    assert.ok(passwords.length >= 2);
    assert.ok(passwords.every(i => i.value === ''));
    assert.equal(line(), null, 'a password link is not PGP');
    assert.deepEqual((await keep()).protection, { mode: 'password', expiresInDays: 30 });
  } finally { await unmount(root); }
});

test('"Send with a password" from the menu opens the password panel; Cancel makes it ordinary mail', async () => {
  const root = await mount({ accountId: 'on', to: ['nokey@example.org'], subject: 's', body: 'hi' });
  try {
    await click(document.querySelector('button[aria-label="compose.sendOptions"]'));
    await click(document.querySelector('[data-preset="sendWithPassword"]'));
    assert.ok(document.querySelector('section[aria-label="compose.sendWithPassword"]'));
    assert.ok(buttonText('compose.sendWithPasswordShort'));
    await click(buttonText('pgp.compose.cancelProtection'));
    assert.equal(document.querySelector('section[aria-label="compose.sendWithPassword"]'), null);
    assert.equal((await keep()).protection, null);
  } finally { await unmount(root); }
});

test('the screen lock never keeps a passphrase', async () => {
  const root = await mount({ accountId: 'on', to: ['bob@example.net'], subject: 's', body: 'hi', restored: true, protection: { mode: 'pgp', sign: true } });
  try {
    const kept = await keep();
    assert.deepEqual(kept.protection, { mode: 'pgp', sign: true });
    assert.ok(!JSON.stringify(kept).includes('passphrase'));
  } finally { await unmount(root); }
});

test('Send with every recipient keyed goes encrypted and signed, unlocked by the sign-in secret, with no question', async () => {
  const SECRET = 'v1.secret-from-the-plimail-password';
  const mine = await generateKeyPair({ email: 'on@example.test', passphrase: SECRET });
  ownKeys = [{ ...OWN_KEY, fingerprint: mine.fingerprint, armoredPublic: mine.armoredPublic, armoredPrivate: mine.armoredPrivate }];
  const { loadOwnKeys } = await import('../utils/pgpOwnKeys.js');
  await loadOwnKeys({ fresh: true });
  useStore.setState({ user: { id: 'u-send' } });
  setKeySecret('u-send', SECRET);
  const root = await mount({ accountId: 'on', to: ['bob@example.net'], subject: 's', body: 'the plaintext' });
  try {
    await until(() => buttonText('compose.sendEncryptedShort'));
    requests.length = 0;
    await click(buttonText('compose.sendEncryptedShort'));
    for (let i = 0; i < 40 && !requests.some(r => r.path === '/api/mail/send'); i++) await React.act(() => new Promise(r => setTimeout(r, 50)));
    const sent = requests.find(r => r.path === '/api/mail/send')?.body;
    assert.ok(sent, `sent (${[...document.querySelectorAll('span')].map(e => e.textContent).filter(x => /pgp|error/i.test(x)).join(' | ')}) ${requests.map(r => r.path).join(',')}`);
    assert.equal(sent.body, '');
    assert.ok(!JSON.stringify(sent).includes('the plaintext'));
    assert.match(sent.pgp.encrypted, /^-----BEGIN PGP MESSAGE-----/);
    const decryptionKey = await unlockPrivateKey(bob.armoredPrivate, 'bob-pass-123');
    const { data, signature } = await decryptArmored(sent.pgp.encrypted, { decryptionKey, verificationArmored: [mine.armoredPublic] });
    assert.ok(new TextDecoder().decode(data).includes('the plaintext'));
    assert.equal(signature.state, 'good');
    assert.equal(document.querySelector('[role="dialog"][aria-modal="true"]'), null, 'no prompt');
  } finally {
    await unmount(root);
    forgetKeySecret();
    ownKeys = [OWN_KEY];
    await loadOwnKeys({ fresh: true });
  }
});

// Shared by the tests below: a real key of the user's own, unlocked by the sign-in secret.
async function withOwnKey(run) {
  const SECRET = 'v1.secret-from-the-plimail-password';
  const mine = await generateKeyPair({ email: 'on@example.test', passphrase: SECRET });
  ownKeys = [{ ...OWN_KEY, fingerprint: mine.fingerprint, armoredPublic: mine.armoredPublic, armoredPrivate: mine.armoredPrivate }];
  const { loadOwnKeys } = await import('../utils/pgpOwnKeys.js');
  await loadOwnKeys({ fresh: true });
  useStore.setState({ user: { id: 'u-send' } });
  setKeySecret('u-send', SECRET);
  try { await run(mine); } finally {
    forgetKeySecret();
    ownKeys = [OWN_KEY];
    await loadOwnKeys({ fresh: true });
  }
}
const sentBody = async () => {
  for (let i = 0; i < 200 && !requests.some(r => r.path === '/api/mail/send'); i++) await React.act(() => new Promise(r => setTimeout(r, 25)));
  return requests.find(r => r.path === '/api/mail/send')?.body;
};

test('a recipient whose address is not looked up while typing (no dot, an IDN) is never shown as encrypted, and Send goes', async () => {
  const root = await mount({ accountId: 'on', to: ['bob@example.net', 'dave@intranet'], subject: 's', body: 'hi' });
  try {
    await lookedUp();
    assert.equal(line(), null, 'not every recipient has a key');
    requests.length = 0;
    await click(buttonText('compose.send'));
    const sent = await sentBody();
    assert.ok(sent, 'sent, not stuck "checking" keys');
    assert.equal(sent.pgp, undefined);
    assert.equal(sent.body.includes('hi'), true);
  } finally { await unmount(root); }
});

test('"Send encrypted" chosen while the password panel is open sends encrypted, not a password link', async () => {
  await withOwnKey(async () => {
    const root = await mount({ accountId: 'on', to: ['bob@example.net'], subject: 's', body: 'secret text' });
    try {
      await click(document.querySelector('button[aria-label="compose.sendOptions"]'));
      await click(document.querySelector('[data-preset="sendWithPassword"]'));
      assert.ok(document.querySelector('section[aria-label="compose.sendWithPassword"]'));
      requests.length = 0;
      await click(document.querySelector('button[aria-label="compose.sendOptions"]'));
      await click(document.querySelector('[data-preset="sendEncrypted"]'));
      const sent = await sentBody();
      assert.ok(sent, `sent (${document.body.textContent.slice(0, 200)})`);
      assert.match(sent.pgp?.encrypted || '', /BEGIN PGP MESSAGE/);
      assert.ok(!requests.some(r => r.path.startsWith('/api/secure')), 'no password link');
    } finally { await unmount(root); }
  });
});

test('a From address whose only key is stale says so loudly, and does not encrypt with it', async () => {
  ownKeys = [{ ...OWN_KEY, stale: true }];
  const { loadOwnKeys } = await import('../utils/pgpOwnKeys.js');
  await loadOwnKeys({ fresh: true });
  const root = await mount({ accountId: 'on', to: ['bob@example.net'], subject: 's', body: 'hi' });
  try {
    await until(() => document.querySelector('[data-stale-key]'));
    assert.ok(buttonText('pgp.stale.recover'));
    assert.ok(buttonText('pgp.stale.newKey'));
    await lookedUp();
    assert.equal(line(), null, 'nothing goes encrypted with a key the user cannot open');
  } finally {
    await unmount(root);
    ownKeys = [OWN_KEY];
    await loadOwnKeys({ fresh: true });
  }
});
