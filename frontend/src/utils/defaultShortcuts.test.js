// Run with: node --test src/utils/defaultShortcuts.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildKeyMap, buildModKeyMap, getShortcutConflicts, resolveShortcutAction, shortcutBindingFromEvent } from './defaultShortcuts.js';

const keyEvent = (key, modifiers = {}) => ({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...modifiers });

describe('general shortcut resolution', () => {
  it('registers message and mailbox actions without default collisions', (t) => {
    const warn = t.mock.method(console, 'warn', () => {});
    const plain = buildKeyMap();
    const modified = buildModKeyMap();
    for (const [key, action] of Object.entries({ u: 'markUnread', i: 'loadRemoteImages', f: 'forward', '?': 'showHelp', '#': 'delete' })) assert.equal(plain[key], action);
    for (const [key, action] of Object.entries({ 'shift+u': 'unsubscribe', enter: 'replyAllFromSelection', '\\': 'toggleLeftSidebar', l: 'openLabelPicker' })) assert.equal(modified[key], action);
    for (let n = 1; n <= 9; n++) assert.equal(modified[String(n)], `goVisibleMailbox${n}`);
    assert.equal(warn.mock.callCount(), 0);
  });

  it('matches exact modifiers and shifted punctuation', () => {
    assert.equal(resolveShortcutAction(keyEvent('U', { ctrlKey: true, shiftKey: true })), 'unsubscribe');
    assert.equal(resolveShortcutAction(keyEvent('Enter', { ctrlKey: true })), 'replyAllFromSelection');
    assert.equal(resolveShortcutAction(keyEvent('\\', { ctrlKey: true })), 'toggleLeftSidebar');
    assert.equal(resolveShortcutAction(keyEvent('?', { shiftKey: true })), 'showHelp');
    assert.equal(resolveShortcutAction(keyEvent('#', { shiftKey: true })), 'delete');
    assert.equal(resolveShortcutAction(keyEvent('e', { ctrlKey: true })), null);
    assert.equal(resolveShortcutAction(keyEvent('Enter', { ctrlKey: true, shiftKey: true })), null);
    assert.equal(resolveShortcutAction(keyEvent('r', { shiftKey: true })), null);
    assert.equal(resolveShortcutAction(keyEvent('f', { altKey: true })), null);
    assert.equal(resolveShortcutAction(keyEvent('f', { metaKey: true })), null);
  });

  it('keeps user overrides and deterministic last-writer wins', () => {
    assert.equal(resolveShortcutAction(keyEvent('z'), { forward: 'z' }), 'forward');
    assert.equal(resolveShortcutAction(keyEvent('f'), { forward: 'z' }), null);
    assert.equal(resolveShortcutAction(keyEvent('p', { ctrlKey: true, shiftKey: true }), { forward: 'ctrl+shift+p' }), 'forward');
    assert.equal(resolveShortcutAction(keyEvent('u'), { archive: 'u', delete: 'u' }), 'delete');
  });
});

describe('buildKeyMap', () => {
  it('does not warn when no overrides are given (defaults have no collisions)', (t) => {
    const warn = t.mock.method(console, 'warn', () => {});
    buildKeyMap();
    assert.equal(warn.mock.callCount(), 0);
  });

  it('warns and keeps last-writer-wins when an override collides with a default key', (t) => {
    const warn = t.mock.method(console, 'warn', () => {});
    // 'archive' defaults to 'e'; override 'delete' (default '#') to the same key.
    const map = buildKeyMap({ delete: 'e' });
    assert.equal(warn.mock.callCount(), 1);
    const [message] = warn.mock.calls[0].arguments;
    assert.match(message, /"e"/);
    assert.match(message, /"archive"/);
    assert.match(message, /"delete"/);
    assert.equal(map.e, 'delete', 'later action (delete) should win');
  });
});

describe('buildModKeyMap', () => {
  it('does not warn when no overrides are given (defaults have no collisions)', (t) => {
    const warn = t.mock.method(console, 'warn', () => {});
    const map = buildModKeyMap();
    assert.equal(warn.mock.callCount(), 0);
    assert.equal(map.z, 'undoAction');
  });

  it('warns and keeps last-writer-wins when an override collides on a modifier+key', (t) => {
    const warn = t.mock.method(console, 'warn', () => {});
    // 'printMessage' defaults to 'ctrl+p'; override 'toggleStar' (default 's') to the same combo.
    const map = buildModKeyMap({ toggleStar: 'ctrl+p' });
    assert.equal(warn.mock.callCount(), 1);
    const [message] = warn.mock.calls[0].arguments;
    assert.match(message, /"ctrl\+p"/);
    assert.match(message, /"toggleStar"/);
    assert.match(message, /"printMessage"/);
    assert.equal(map.p, 'printMessage', 'later action (printMessage) should win');
  });
});

describe('modifier shortcuts', () => {
  it('resolves a Shift binding without claiming its Ctrl+Shift form', () => {
    const overrides = { toggleStar: 'shift+e' };
    assert.equal(resolveShortcutAction({ key: 'E', ctrlKey: true, shiftKey: true }, overrides), null);
    assert.equal(resolveShortcutAction({ key: 'e', ctrlKey: true, shiftKey: false }, overrides), null);
    assert.equal(resolveShortcutAction({ key: 'E', ctrlKey: false, shiftKey: true }, overrides), 'toggleStar');
    assert.equal(resolveShortcutAction(keyEvent('E', { ctrlKey: true, shiftKey: true }), { toggleStar: 'ctrl+shift+e' }), 'toggleStar');
  });

  it('reports the final winner of a full modifier collision before dispatch', (t) => {
    const warn = t.mock.method(console, 'warn', () => {});
    const overrides = { toggleStar: 'ctrl+p' };
    assert.deepEqual(getShortcutConflicts(overrides), [{ key: 'ctrl+p', loser: 'toggleStar', winner: 'printMessage' }]);
    buildKeyMap(overrides);
    assert.equal(warn.mock.callCount(), 1);
    const action = resolveShortcutAction(keyEvent('p', { ctrlKey: true }), overrides);
    assert.equal(action, 'printMessage');
    assert.equal(warn.mock.callCount(), 1);
    assert.match(warn.mock.calls[0].arguments[0], /toggleStar.*printMessage/);
  });

  it('keeps Ctrl+P and Ctrl+Shift+P separate and records the full modifier set', (t) => {
    const warn = t.mock.method(console, 'warn', () => {});
    const overrides = { toggleStar: 'ctrl+shift+p' };
    assert.deepEqual(getShortcutConflicts(overrides), []);
    buildModKeyMap(overrides);
    assert.equal(warn.mock.callCount(), 0);
    assert.equal(resolveShortcutAction(keyEvent('p', { ctrlKey: true }), overrides), 'printMessage');
    assert.equal(resolveShortcutAction(keyEvent('P', { ctrlKey: true, shiftKey: true }), overrides), 'toggleStar');
    assert.equal(shortcutBindingFromEvent(keyEvent('E', { ctrlKey: true, shiftKey: true })), 'ctrl+shift+e');
  });

  it('treats modifier order and case as the same binding', () => {
    assert.deepEqual(getShortcutConflicts({ toggleStar: 'shift+ctrl+U' }), [
      { key: 'ctrl+shift+u', loser: 'unsubscribe', winner: 'toggleStar' },
    ]);
  });
});
