import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildUpcoming, upcomingRange } from './upcoming.js';

// Local wall-clock times, so the test holds in any time zone.
const NOW = new Date(2026, 10, 9, 10, 30);
const at = (dayOffset, h, m = 0) => new Date(2026, 10, 9 + dayOffset, h, m).toISOString();
const dayStr = (offset) => {
  const d = new Date(2026, 10, 9 + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
let n = 0;
const ev = (over) => ({ id: `e${++n}:`, calendarId: 'c1', summary: 'x', allDay: false, status: 'CONFIRMED', start: at(0, 12), end: at(0, 13), ...over });
const build = (events, extra = {}) => buildUpcoming({ events, calendars: [{ id: 'c1', visible: true }, { id: 'c2', visible: false }], now: NOW, ...extra });
const titles = (r) => r.groups.flatMap(g => g.items.map(i => i.occ.summary));

describe('buildUpcoming', () => {
  test('drops finished events, keeps in-progress ones and marks them now', () => {
    const r = build([
      ev({ summary: 'done', start: at(0, 8), end: at(0, 9) }),
      ev({ summary: 'running', start: at(0, 10), end: at(0, 11) }),
      ev({ summary: 'later', start: at(0, 15), end: at(0, 16) }),
    ]);
    assert.deepEqual(titles(r), ['running', 'later']);
    assert.deepEqual(r.groups[0].items.map(i => i.now), [true, false]);
  });

  test('hides events of hidden calendars and cancelled ones', () => {
    const r = build([ev({ summary: 'mine' }), ev({ summary: 'hidden', calendarId: 'c2' }), ev({ summary: 'gone', status: 'CANCELLED' })]);
    assert.deepEqual(titles(r), ['mine']);
  });

  test('groups by day, all-day first, and keeps today\'s all-day event', () => {
    const r = build([
      ev({ summary: 'tomorrow talk', start: at(1, 9), end: at(1, 10) }),
      ev({ summary: 'holiday', allDay: true, start: dayStr(0), end: dayStr(1) }),
      ev({ summary: 'lunch', start: at(0, 12), end: at(0, 13) }),
    ]);
    assert.deepEqual(r.groups.map(g => g.day), [dayStr(0), dayStr(1)]);
    assert.deepEqual(r.groups[0].items.map(i => i.occ.summary), ['holiday', 'lunch']);
    assert.equal(r.groups[0].items[0].allDay, true);
    assert.equal(r.groups[0].items[0].now, false);
  });

  test('leaves out events beyond the week and yesterday\'s all-day events', () => {
    const r = build([
      ev({ summary: 'far', start: at(9, 9), end: at(9, 10) }),
      ev({ summary: 'yesterday', allDay: true, start: dayStr(-1), end: dayStr(0) }),
      ev({ summary: 'in a week', start: at(6, 9), end: at(6, 10) }),
    ]);
    assert.deepEqual(titles(r), ['in a week']);
  });

  test('a multi-day event shows on each day and is continued after the first', () => {
    const r = build([ev({ summary: 'trip', start: at(-1, 20), end: at(1, 8) })]);
    assert.deepEqual(r.groups.map(g => g.day), [dayStr(0), dayStr(1)]);
    assert.equal(r.groups[0].items[0].continued, true);
    assert.equal(r.groups[0].items[0].now, true);
  });

  test('caps the rows and counts what is left', () => {
    const many = Array.from({ length: 9 }, (_, i) => ev({ summary: `m${i}`, start: at(0, 11 + (i % 3), i * 5), end: at(0, 14) }));
    const r = build(many);
    assert.equal(titles(r).length, 6);
    assert.equal(r.total, 9);
    assert.equal(r.hidden, 3);
  });

  test('is empty without events and tolerates junk', () => {
    assert.deepEqual(build([]), { groups: [], total: 0, hidden: 0 });
    assert.deepEqual(build(null), { groups: [], total: 0, hidden: 0 });
    assert.deepEqual(titles(build([null, ev({ summary: 'bad', start: 'nope', end: 'nope' })])), []);
  });
});

describe('upcomingRange', () => {
  test('starts at local midnight today and covers the next seven days', () => {
    const r = upcomingRange(NOW);
    assert.equal(r.first, dayStr(0));
    assert.equal(r.endDay, dayStr(8));
    assert.equal(r.from, new Date(2026, 10, 9).toISOString());
    assert.equal(r.to, new Date(2026, 10, 17).toISOString());
  });
});
