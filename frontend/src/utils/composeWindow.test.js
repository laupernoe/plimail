import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  isComposeWindowPath, composeWindowUrl, openComposeWindow, composeInNewWindow,
  announceComposeChange, listenForComposeChanges,
} from './composeWindow.js';

const fakeWin = (result = {}) => {
  const calls = [];
  return { calls, screen: { availWidth: 1920, availHeight: 1080 }, open: (...args) => { calls.push(args); return result; } };
};

describe('composer window', () => {
  test('only /compose is the composer window', () => {
    assert.equal(isComposeWindowPath('/compose'), true);
    assert.equal(isComposeWindowPath('/compose/'), true);
    assert.equal(isComposeWindowPath('/'), false);
    assert.equal(isComposeWindowPath('/composer'), false);
  });

  test('the account is carried in the URL', () => {
    assert.equal(composeWindowUrl(), '/compose');
    assert.equal(composeWindowUrl({ accountId: 'a b' }), '/compose?account=a%20b');
  });

  test('opens a sized popup, with a name of its own each time so several can be open', () => {
    const win = fakeWin();
    assert.ok(openComposeWindow({ win }));
    assert.ok(openComposeWindow({ win }));
    const [url, name, features] = win.calls[0];
    assert.equal(url, '/compose');
    assert.match(features, /popup=yes/);
    assert.match(features, /width=820/);
    assert.notEqual(name, win.calls[1][1]);
  });

  test('a blocked popup (null) or a throw is reported as null', () => {
    assert.equal(openComposeWindow({ win: { open: () => null } }), null);
    assert.equal(openComposeWindow({ win: { open: () => { throw new Error('blocked'); } } }), null);
  });

  test('falls back to the in-app composer when the popup is blocked, and not otherwise', () => {
    let opened = 0;
    assert.equal(composeInNewWindow({ openCompose: () => { opened++; }, win: { open: () => null } }), false);
    assert.equal(opened, 1);
    assert.equal(composeInNewWindow({ openCompose: () => { opened++; }, win: fakeWin() }), true);
    assert.equal(opened, 1);
  });

  test('a change in the popup reaches the listener, and nothing breaks without BroadcastChannel', () => {
    const channels = new Set();
    class Fake {
      constructor() { channels.add(this); }
      postMessage(data) { for (const c of channels) if (c !== this && c.onmessage) c.onmessage({ data }); }
      close() { channels.delete(this); }
    }
    let heard = 0;
    const stop = listenForComposeChanges(() => { heard++; }, Fake);
    announceComposeChange(Fake);
    assert.equal(heard, 1);
    stop();
    announceComposeChange(Fake);
    assert.equal(heard, 1);
    assert.doesNotThrow(() => { announceComposeChange(null); listenForComposeChanges(() => {}, null)(); });
  });
});
