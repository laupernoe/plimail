import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { chipEmail, formatRecipient, addSuggestionChips, mergeGroupSuggestions, suggestionKey } from './groupRecipients.js';

const group = (members, name = 'Team') => ({ group: true, groupId: 'g1', name, members });
const ann = { name: 'Ann', email: 'ann@example.com' };
const bob = { name: 'Bob', email: 'bob@example.com' };
const noName = { name: null, email: 'cy@example.com' };

describe('chipEmail', () => {
  test('reads the address out of "Name <addr>" and a bare address, in lower case', () => {
    assert.equal(chipEmail('Ann <Ann@Example.com>'), 'ann@example.com');
    assert.equal(chipEmail(' bob@example.com '), 'bob@example.com');
  });
});

describe('addSuggestionChips', () => {
  test('a plain contact is added as one chip, as before', () => {
    assert.deepEqual(addSuggestionChips(['x@example.com'], ann), ['x@example.com', 'Ann <ann@example.com>']);
  });

  test('a group adds each member as its own, separate chip', () => {
    assert.deepEqual(
      addSuggestionChips([], group([ann, bob, noName])),
      ['Ann <ann@example.com>', 'Bob <bob@example.com>', 'cy@example.com'],
    );
  });

  test('a member already among the recipients is not added again, whatever its form or case', () => {
    const chips = ['ANN@example.com', 'Someone <x@example.com>'];
    assert.deepEqual(
      addSuggestionChips(chips, group([ann, bob])),
      ['ANN@example.com', 'Someone <x@example.com>', 'Bob <bob@example.com>'],
    );
  });

  test('an address listed twice in the group is added once', () => {
    assert.deepEqual(
      addSuggestionChips([], group([ann, { name: 'Annie', email: 'Ann@example.com' }])),
      ['Ann <ann@example.com>'],
    );
  });

  test('members without an address are skipped', () => {
    assert.deepEqual(addSuggestionChips([], group([{ name: 'Ghost', email: null }, bob])), ['Bob <bob@example.com>']);
  });

  test('the chips given are not changed', () => {
    const chips = ['x@example.com'];
    addSuggestionChips(chips, group([ann]));
    assert.deepEqual(chips, ['x@example.com']);
  });
});

describe('mergeGroupSuggestions', () => {
  test('puts matching groups first and marks them', () => {
    const merged = mergeGroupSuggestions([ann], [{ id: 'g1', name: 'Team', members: [bob] }]);
    assert.equal(merged.length, 2);
    assert.equal(merged[0].group, true);
    assert.equal(merged[0].groupId, 'g1');
    assert.deepEqual(merged[1], ann);
  });

  test('drops a group with no member that has an address', () => {
    assert.deepEqual(mergeGroupSuggestions([ann], [{ id: 'g2', name: 'Empty', members: [] }]), [ann]);
  });

  test('keys never collide between a group and a contact', () => {
    const [g, c] = mergeGroupSuggestions([ann], [{ id: 'g1', name: 'Team', members: [bob] }]);
    assert.notEqual(suggestionKey(g), suggestionKey(c));
  });
});

describe('formatRecipient', () => {
  test('uses the name when there is one', () => {
    assert.equal(formatRecipient(ann), 'Ann <ann@example.com>');
    assert.equal(formatRecipient(noName), 'cy@example.com');
  });
});
