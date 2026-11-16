import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { groupSearchResults, searchable } from './eventSearch.js';

const local = (y, m, d, h) => new Date(y, m - 1, d, h).toISOString();
const occ = (id, start, upcoming, over) => ({ id, start, end: start, allDay: false, upcoming, ...over });

describe('searchable', () => {
  test('trims, and leaves out what the server would refuse', () => {
    assert.equal(searchable('  ab '), 'ab');
    assert.equal(searchable(' a '), null);
    assert.equal(searchable(''), null);
    assert.equal(searchable(undefined), null);
    assert.equal(searchable('x'.repeat(201)), null);
    assert.equal(searchable('x'.repeat(200)), 'x'.repeat(200));
  });
});

describe('groupSearchResults', () => {
  test('keeps the server order, upcoming then past, one date per day', () => {
    const sections = groupSearchResults([
      occ('a', local(2026, 11, 20, 9), true),
      occ('b', local(2026, 11, 20, 15), true),
      { id: 'c', start: '2026-11-21', end: '2026-11-22', allDay: true, upcoming: true },
      occ('d', local(2026, 3, 16, 18), false),
      occ('e', local(2025, 6, 10, 8), false),
    ]);
    assert.deepEqual(sections.map(s => [s.kind, s.days.map(d => [d.day, d.items.map(i => i.id)])]), [
      ['upcoming', [['2026-11-20', ['a', 'b']], ['2026-11-21', ['c']]]],
      ['past', [['2026-03-16', ['d']], ['2025-06-10', ['e']]]],
    ]);
  });

  test('gives no section for no results', () => {
    assert.deepEqual(groupSearchResults([]), []);
  });
});
