import { test } from 'node:test';
import assert from 'node:assert/strict';
import { passkeyBlocker, signInWithPasskey, isPasskeyCancel } from './passkeys.js';

const here = (hostname, extra = {}) => ({ hostname, secure: true, webauthn: true, ...extra });
const ok = { available: true, rpId: 'mail.kxn.ch' };

test('passkeys work at the server\'s own host and below it', () => {
  assert.equal(passkeyBlocker(ok, here('mail.kxn.ch')), null);
  assert.equal(passkeyBlocker(ok, here('MAIL.KXN.CH')), null);
  assert.equal(passkeyBlocker(ok, here('eu.mail.kxn.ch')), null);
});

test('an IP address, on the server or in the address bar, is said as such', () => {
  assert.equal(passkeyBlocker({ available: false, reason: 'ip' }, here('192.168.1.20')), 'ip');
  assert.equal(passkeyBlocker(ok, here('192.168.1.20')), 'ip');
  assert.equal(passkeyBlocker(ok, here('[fd00::1]')), 'ip');
});

test('another host, an insecure page or a browser without WebAuthn is refused before the browser is asked', () => {
  assert.equal(passkeyBlocker(ok, here('evilmail.kxn.ch.example')), 'otherHost');
  assert.equal(passkeyBlocker(ok, here('kxn.ch')), 'otherHost');
  assert.equal(passkeyBlocker(ok, here('mail.kxn.ch', { secure: false })), 'browser');
  assert.equal(passkeyBlocker(ok, here('mail.kxn.ch', { webauthn: false })), 'browser');
  assert.equal(passkeyBlocker({ available: false, reason: 'noAppUrl' }, here('mail.kxn.ch')), 'server');
  assert.equal(passkeyBlocker(null, here('mail.kxn.ch')), 'server');
});

test('a sign-in asks for options, has the browser answer them and returns the server\'s user', async () => {
  const calls = [];
  const client = {
    loginOptions: async () => { calls.push('options'); return { options: { challenge: 'c' } }; },
    loginVerify: async (response) => { calls.push(['verify', response]); return { user: { id: 'u1' } }; },
  };
  const start = async ({ optionsJSON, useBrowserAutofill }) => { calls.push(['start', optionsJSON.challenge, useBrowserAutofill]); return { id: 'cred' }; };
  assert.deepEqual(await signInWithPasskey({ client, start, autofill: true }), { id: 'u1' });
  assert.deepEqual(calls, ['options', ['start', 'c', true], ['verify', { id: 'cred' }]]);
});

test('an autofill sign-in overtaken by the button gives up before the browser is involved', async () => {
  let started = false;
  const client = { loginOptions: async () => ({ options: { challenge: 'c' } }), loginVerify: async () => assert.fail('no verify') };
  await assert.rejects(
    signInWithPasskey({ client, start: async () => { started = true; }, autofill: true, proceed: () => false }),
    err => isPasskeyCancel(err),
  );
  assert.equal(started, false);
});
