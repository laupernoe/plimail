import test from 'node:test';
import assert from 'node:assert/strict';
import { groupCalendarsByAccount } from './calendarGroups.js';

test('groups calendars by account in the accounts order and drops empty or orphan ones', () => {
  const accounts = [{ id: 'b' }, { id: 'a' }, { id: 'empty' }];
  const calendars = [
    { id: 1, accountId: 'a' }, { id: 2, accountId: 'b' }, { id: 3, accountId: 'a' }, { id: 4, accountId: 'gone' },
  ];
  const groups = groupCalendarsByAccount(accounts, calendars);
  assert.deepEqual(groups.map(g => [g.account.id, g.calendars.map(c => c.id)]), [['b', [2]], ['a', [1, 3]]]);
});

test('copes with missing lists', () => {
  assert.deepEqual(groupCalendarsByAccount(null, null), []);
});
