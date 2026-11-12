import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as hotkeys from './messageHotkeys.js';

const selectedMessage = hotkeys.selectedMessage ?? (() => null);
const markMessageUnread = hotkeys.markMessageUnread ?? (() => false);

describe('selected message hotkeys', () => {
  const inbox = { id: 'inbox', account_id: 'acct', is_read: true, category: 'primary' };
  const found = { id: 'found', account_id: 'acct', is_read: true };

  it('resolves normal, search, and thread selections; no selection is a no-op', () => {
    assert.equal(selectedMessage({ selectedMessageId: 'inbox', messages: [inbox], searchResults: [], searchQuery: '', threadMessages: {} }), inbox);
    assert.equal(selectedMessage({ selectedMessageId: 'found', messages: [inbox], searchResults: [], searchQuery: '', threadMessages: { t1: [found] } }), found);
    assert.equal(selectedMessage({ selectedMessageId: 'found', messages: [], searchResults: [found], searchQuery: 'q', threadMessages: {} }), found);
    assert.equal(selectedMessage({ selectedMessageId: null, messages: [inbox] }), null);
  });

  it('uses the frontmost open message window when the main list has no selection', () => {
    const behind = { id: 'behind', account_id: 'acct' };
    const front = { id: 'front', account_id: 'acct' };
    const state = {
      selectedMessageId: null, messages: [behind, front],
      messageWindows: [
        { messageId: 'behind', z: 3, minimized: false },
        { messageId: 'front', z: 5, minimized: false },
      ],
    };
    assert.equal(selectedMessage(state), front);
    assert.equal(selectedMessage({ ...state, messageWindows: state.messageWindows.map(w => ({ ...w, minimized: true })) }), null);
  });

  it('explicit unread cancels a pending auto-read, even if row is still unread', async () => {
    const calls = [];
    const cancel = () => calls.push('cancel');
    const patch = async (ids, read) => calls.push(['patch', ids, read]);
    assert.equal(markMessageUnread({ ...inbox, is_read: false }, { cancel, patch }), true);
    assert.deepEqual(calls, ['cancel']);
    assert.equal(markMessageUnread(inbox, {
      cancel,
      update: (id, data) => calls.push(['update', id, data]),
      incrementUnread: () => calls.push('increment'),
      adjustCategoryCount: () => calls.push('category'),
      patch,
    }), true);
    await Promise.resolve();
    assert.deepEqual(calls.slice(1), ['cancel', ['update', 'inbox', { is_read: false }], 'increment', 'category', ['patch', ['inbox'], false]]);
  });
});
