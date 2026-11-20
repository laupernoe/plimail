import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  isComposeWindowPath, composeWindowUrl, openComposeWindow, composeInNewWindow,
  announceComposeChange, listenForComposeChanges, popOutCompose, takeHandoff,
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

describe('pop-out hand-off', () => {
  const memory = () => { const m = new Map(); return { m, setItem: (k, v) => m.set(k, v), getItem: k => m.get(k) ?? null, removeItem: k => m.delete(k) }; };
  const bus = () => {
    const all = new Set();
    return class { constructor() { all.add(this); } postMessage(d) { for (const c of all) if (c !== this && c.onmessage) c.onmessage({ data: d }); } close() { all.delete(this); } };
  };
  const run = (extra = {}) => {
    const result = { taken: 0, failed: null };
    const storage = memory();
    const Channel = bus();
    const win = fakeWin({ close() { result.closed = true; } });
    popOutCompose({ data: { subject: 's' }, id: 'k1', waitMs: 20, storage, Channel, win, onTaken: () => { result.taken++; }, onFailed: r => { result.failed = r; }, ...extra });
    return { result, storage, Channel, win };
  };

  test('opens the window on the hand-off and keeps the composer until it is taken', async () => {
    const { result, storage, Channel, win } = run({ waitMs: 1000 });
    assert.equal(win.calls[0][0], '/compose?handoff=k1');
    assert.deepEqual(JSON.parse(storage.getItem('mailflow_compose_handoff_k1')), { subject: 's' });
    assert.equal(result.taken, 0);
    announceComposeChange(Channel);
    assert.equal(result.taken, 0);
    new Channel().postMessage({ type: 'handoff-taken', id: 'other' });
    assert.equal(result.taken, 0);
    new Channel().postMessage({ type: 'handoff-taken', id: 'k1' });
    assert.equal(result.taken, 1);
  });

  test('storage that refuses, or a blocked popup, fails with nothing left behind', () => {
    const full = { ...memory(), setItem() { throw new Error('quota'); } };
    assert.equal(run({ storage: full }).result.failed, 'storage');
    const blocked = run({ win: { open: () => null, screen: {} } });
    assert.equal(blocked.result.failed, 'blocked');
    assert.equal(blocked.storage.m.size, 0);
  });

  test('a window that never answers is closed, the hand-off dropped and the failure reported', async () => {
    const { result, storage } = run();
    await new Promise(r => setTimeout(r, 60));
    assert.equal(result.failed, 'timeout');
    assert.equal(result.closed, true);
    assert.equal(result.taken, 0);
    assert.equal(storage.m.size, 0);
  });

  test('the popup takes the hand-off out of storage once', () => {
    const storage = memory();
    storage.setItem('mailflow_compose_handoff_z', '{"a":1}');
    assert.deepEqual(takeHandoff('z', storage), { a: 1 });
    assert.equal(takeHandoff('z', storage), null);
    assert.equal(takeHandoff(null, storage), null);
    storage.setItem('mailflow_compose_handoff_bad', '{');
    assert.equal(takeHandoff('bad', storage), null);
  });
});
