import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ accounts: [], sent: [] }));
vi.mock('./ownership.js', () => ({ findOwnedAccount: vi.fn(async () => ({ id: 'm1' })) }));
vi.mock('./smtpTransport.js', () => ({
  createAccountSmtpTransport: vi.fn(async () => ({ transport: { sendMail: vi.fn(async (m) => { db.sent.push(m); return { rejected: [] }; }) } })),
}));
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

const { forgetScheduling, knownAddresses, mailItip, mailLabels, planInvites } = await import('./calendarInvites.js');
const { occurrenceOnly } = await import('./icalEvents.js');

beforeEach(() => {
  db.accounts = [
    { id: 'a1', username: 'noe', calendar_addresses: [] },
    { id: 'a2', username: 'Noe@Other.example', calendar_addresses: [] },
  ];
  forgetScheduling('a1');
  db.sent = [];
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

describe('mailItip', () => {
  const SERIES = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//t//EN', 'BEGIN:VEVENT', 'UID:s', 'DTSTAMP:20260101T000000Z',
    'DTSTART:20270310T090000Z', 'DTEND:20270310T100000Z', 'RRULE:FREQ=WEEKLY;COUNT=4', 'SUMMARY:Point',
    'ORGANIZER:mailto:noe@example.com', 'ATTENDEE:mailto:ana@example.com', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  const send = (ics, extra) => mailItip({ userId: 'u1', from: 'noe@example.com', to: ['ana@example.com'], method: 'REQUEST', ics, kind: 'invite',
    labels: mailLabels(), lang: 'en', timeZone: 'Europe/Zurich', ...extra });

  it('mails a timed invitation with its time', async () => {
    await send(SERIES);
    expect(db.sent[0].subject).toBe('Invitation: Point');
    expect(db.sent[0].text).toMatch(/When: Wednesday, March 10, 2027 at 10:00 AM – 11:00 AM GMT\+1/);
  });

  it('names the occurrence a cancellation is for, and when it was', async () => {
    await send(occurrenceOnly(SERIES, '2027-03-17T09:00:00Z'), { method: 'CANCEL', kind: 'cancel' });
    expect(db.sent[0].subject).toBe('Cancelled: Point');
    expect(db.sent[0].text).toMatch(/When: Wednesday, March 17, 2027 at 10:00 AM/);
  });
});
