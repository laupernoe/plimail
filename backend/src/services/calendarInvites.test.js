import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ accounts: [] }));
vi.mock('./db.js', () => ({
  query: vi.fn(async (sql, params) => {
    if (/FROM email_accounts m WHERE/.test(sql)) return { rows: [{ account_id: 'm1', email: 'noe@example.com', name: 'Noé', alias_id: null }] };
    if (/^UPDATE caldav_accounts SET calendar_addresses/.test(sql)) {
      const a = db.accounts.find(x => x.id === params[0]);
      a.calendar_addresses = params[1];
      return { rowCount: 1, rows: [] };
    }
    if (/FROM caldav_accounts WHERE user_id/.test(sql)) return { rows: db.accounts.map(a => ({ username: a.username.toLowerCase(), calendar_addresses: a.calendar_addresses })) };
    return { rows: [] };
  }),
}));
vi.mock('./caldavClient.js', () => ({
  schedulingInfo: vi.fn(async () => ({ serverSchedules: false, addresses: ['Noe.Work@example.org'] })),
}));

const { forgetScheduling, knownAddresses, planInvites } = await import('./calendarInvites.js');

beforeEach(() => {
  db.accounts = [
    { id: 'a1', username: 'noe', calendar_addresses: [] },
    { id: 'a2', username: 'Noe@Other.example', calendar_addresses: [] },
  ];
  forgetScheduling('a1');
});

describe('the user\'s own addresses', () => {
  it('are the same for the event list and for invitations', async () => {
    const plan = await planInvites({ userId: 'u1', accountId: 'a1', calendarUrl: 'https://dav.example.com/cal/', username: 'noe', creds: {} });
    expect([...plan.myEmails].sort()).toEqual([...await knownAddresses('u1')].sort());
    expect(plan.myEmails).toEqual(expect.arrayContaining(['noe@example.com', 'noe@other.example', 'noe.work@example.org']));
  });

  it('keep what the server listed once the process forgot it', async () => {
    await planInvites({ userId: 'u1', accountId: 'a1', calendarUrl: 'https://dav.example.com/cal/', username: 'noe', creds: {} });
    forgetScheduling('a1');
    expect(await knownAddresses('u1')).toContain('noe.work@example.org');
  });
});
