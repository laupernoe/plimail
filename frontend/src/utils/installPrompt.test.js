import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { captureInstallPrompt, installState, promptInstall, subscribeInstallState, resetInstallPromptForTest } from './installPrompt.js';

function fakeWindow({ standalone = false } = {}) {
  const listeners = {};
  return {
    listeners,
    addEventListener: (type, fn) => { listeners[type] = fn; },
    matchMedia: q => ({ matches: standalone && q === '(display-mode: standalone)' }),
    navigator: {},
    fire(type, event = {}) { listeners[type](event); },
  };
}

function installEvent(outcome) {
  const calls = [];
  return {
    calls,
    preventDefault: () => calls.push('preventDefault'),
    prompt: async () => { calls.push('prompt'); },
    userChoice: Promise.resolve({ outcome }),
  };
}

beforeEach(() => resetInstallPromptForTest());

test('nothing to offer until the browser says the app is installable', () => {
  captureInstallPrompt(fakeWindow());
  assert.equal(installState(), 'unavailable');
});

test('the captured event keeps the mini-infobar away and lets Settings prompt once', async () => {
  const w = fakeWindow();
  captureInstallPrompt(w);
  let changes = 0;
  subscribeInstallState(() => { changes++; });
  const event = installEvent('accepted');
  w.fire('beforeinstallprompt', event);
  assert.equal(installState(), 'available');
  assert.equal(await promptInstall(), 'accepted');
  assert.deepEqual(event.calls, ['preventDefault', 'prompt']);
  assert.equal(installState(), 'unavailable', 'an event prompts only once');
  assert.equal(await promptInstall(), 'unavailable');
  assert.ok(changes >= 2);
});

test('the button goes away once installed, and inside the installed app', () => {
  const w = fakeWindow();
  captureInstallPrompt(w);
  w.fire('beforeinstallprompt', installEvent('accepted'));
  w.fire('appinstalled');
  assert.equal(installState(), 'installed');

  resetInstallPromptForTest();
  captureInstallPrompt(fakeWindow({ standalone: true }));
  assert.equal(installState(), 'installed');
});
