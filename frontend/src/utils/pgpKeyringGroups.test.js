import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupKeyring } from './pgpKeyringGroups.js';

const row = (patch = {}) => ({ email: 'a@example.org', fingerprint: 'f1', armored: 'K', source: 'manual', verified: false, firstSeen: 't', auto: false, ...patch });

test('a key collected automatically from an Autocrypt header is listed as such', () => {
  const [g] = groupKeyring([row({ source: 'autocrypt', auto: true })]);
  assert.deepEqual(g.sources, ['autocryptAuto']);
});

test('a key the user took from an Autocrypt offer stays plain Autocrypt', () => {
  const [g] = groupKeyring([row({ source: 'autocrypt', auto: false })]);
  assert.deepEqual(g.sources, ['autocrypt']);
});

test('other sources are listed as they are, whatever the flag', () => {
  assert.deepEqual(groupKeyring([row({ source: 'wkd', auto: true })])[0].sources, ['wkd']);
  assert.deepEqual(groupKeyring([row({ source: 'manual' })])[0].sources, ['manual']);
});

test('rows of one key are one entry with all its addresses, verified only if every row is', () => {
  const groups = groupKeyring([row(), row({ email: 'b@example.org', verified: true })]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].emails, ['a@example.org', 'b@example.org']);
  assert.equal(groups[0].verified, false);
});
