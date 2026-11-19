import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { splitReactions, groupReactions, canReact, ownAddresses, myReactionEmoji } from './reactions.js';

const own = ownAddresses([{ email_address: 'Me@x.z', aliases: [{ email: 'alias@x.z' }] }]);
const msg = (id, extra = {}) => ({ id, account_id: 'a', message_id: `<${id}@x>`, from_email: 'ana@x.z', to_addresses: [{ email: 'me@x.z' }], cc_addresses: [], ...extra });
const reaction = (id, target, emoji, from, extra = {}) => msg(id, { in_reply_to: `<${target}@x>`, reaction_emoji: emoji, from_email: from, from_name: from.split('@')[0], ...extra });

describe('splitReactions', () => {
  test('takes reactions to a message in the conversation out of the stack', () => {
    const list = [msg('m1'), reaction('r1', 'm1', '👍', 'bob@x.z'), msg('m2')];
    const { cards, reactionsByTarget } = splitReactions(list);
    assert.deepEqual(cards.map(m => m.id), ['m1', 'm2']);
    assert.deepEqual(reactionsByTarget.get('m1').map(r => r.id), ['r1']);
  });

  test('keeps a reaction whose message is not there, and a candidate never confirmed, as cards', () => {
    const list = [msg('m1'), reaction('r1', 'gone', '👍', 'bob@x.z'), msg('r2', { in_reply_to: '<m1@x>', reaction_emoji: '' })];
    assert.deepEqual(splitReactions(list).cards.map(m => m.id), ['m1', 'r1', 'r2']);
  });

  test('puts a reaction on its own account\'s copy of a message delivered to two accounts', () => {
    const list = [msg('m1'), msg('m1b', { account_id: 'b', message_id: '<m1@x>' }), reaction('r1', 'm1', '👍', 'bob@x.z', { account_id: 'b' })];
    assert.deepEqual([...splitReactions(list).reactionsByTarget.keys()], ['m1b']);
  });
});

describe('groupReactions', () => {
  test('one chip per emoji, a person counted once, RFC 9078 emoji lists split', () => {
    const groups = groupReactions([
      reaction('r1', 'm1', '👍', 'bob@x.z', { date: '2026-01-01' }),
      reaction('r2', 'm1', '👍 🎉', 'me@x.z', { date: '2026-01-02' }),
      reaction('r3', 'm1', '👍', 'bob@x.z', { date: '2026-01-03' }),
    ], own);
    assert.deepEqual(groups.map(g => [g.emoji, g.count, g.mine]), [['👍', 2, true], ['🎉', 1, true]]);
    assert.deepEqual(myReactionEmoji([reaction('r2', 'm1', '👍 🎉', 'me@x.z')], own), new Set(['👍', '🎉']));
  });
});

describe('canReact', () => {
  test('follows the server\'s rules', () => {
    assert.equal(canReact(msg('m1'), own), true);
    assert.equal(canReact(msg('m1', { from_email: 'alias@x.z', to_addresses: [{ email: 'x@y.z' }] }), own), true, 'one\'s own message');
    assert.equal(canReact(msg('m1', { is_draft: true }), own), false);
    assert.equal(canReact(msg('m1', { list_unsubscribe: '<u>' }), own), false);
    assert.equal(canReact(msg('m1', { to_addresses: [{ email: 'x@y.z' }] }), own), false, 'Bcc\'d');
    assert.equal(canReact(reaction('r1', 'm0', '👍', 'bob@x.z'), own), false, 'not to a reaction');
    const many = Array.from({ length: 21 }, (_, i) => ({ email: `p${i}@y.z` }));
    assert.equal(canReact(msg('m1', { cc_addresses: many }), own), false);
    const mine = Array.from({ length: 20 }, (_, i) => reaction(`r${i}`, 'm1', String.fromCodePoint(0x1F600 + i), 'me@x.z'));
    assert.equal(canReact(msg('m1'), own, mine), false, 'twenty of one\'s own reactions');
  });
});
