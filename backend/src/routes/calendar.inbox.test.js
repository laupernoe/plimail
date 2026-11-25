import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The invitations inbox: listing what waits for an answer, and answering it. No mail is sent and
// no server is called: SMTP and CalDAV are mocks that record what they were asked.
const state = vi.hoisted(() => ({ mail: [], events: [], replies: [], mails: [], puts: [], smtpFails: false, smtpGate: null, plan: null }));

vi.mock('../services/db.js', () => ({
  query: vi.fn(async (sql, params) => {
    if (/FROM calendar_events e JOIN calendars c ON c.id = e.calendar_id\s+WHERE e.user_id = \$1 AND NOT c.ignored/.test(sql)) {
      return { rows: state.events.map(e => ({ id: e.id, calendar_id: e.calendar_id, uid: e.uid, ical: e.ical, read_only: false })) };
    }
    if (/FROM calendar_invite_replies/.test(sql)) return { rows: state.replies };
    if (/INSERT INTO calendar_invite_replies/.test(sql)) {
      const [, uid, rid, sequence, partstat] = params;
      state.replies = state.replies.filter(r => !(r.uid === uid && r.recurrence_id === rid));
      state.replies.push({ uid, recurrence_id: rid, sequence, partstat, answered_at: new Date().toISOString() });
      return { rows: [], rowCount: 1 };
    }
    if (/FROM calendars c JOIN caldav_accounts a ON a.id = c.account_id\s+WHERE c.user_id = \$1 AND NOT c.ignored AND NOT c.read_only/.test(sql)) {
      return { rows: [{ id: 'cal1', account_id: 'a1', user_id: 'u1', url: 'https://dav.example.com/cal/', read_only: false }] };
    }
    if (/FROM calendar_events e\s+JOIN calendars c/.test(sql)) {
      const e = state.events.find(x => x.id === params[0]);
      return { rows: e ? [{ ...e, user_id: 'u1', etag: '"1"', read_only: false, account_id: 'a1', calendar_url: 'https://dav.example.com/cal/' }] : [] };
    }
    if (/INSERT INTO calendar_events/.test(sql)) {
      const [calendarId, , href, , uid, ical] = params;
      state.events = state.events.filter(e => e.href !== href);
      state.events.push({ id: '33333333-3333-4333-8333-333333333333', calendar_id: calendarId, href, uid, ical });
      return { rows: [{ id: '33333333-3333-4333-8333-333333333333' }] };
    }
    if (/SELECT e.uid, e.ical FROM calendar_events/.test(sql)) return { rows: [] };
    return { rows: [], rowCount: 0 };
  }),
}));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _r, n) => { req.session = { userId: 'u1' }; n(); } }));
vi.mock('../services/caldavSync.js', () => ({ syncAccount: vi.fn(async () => {}), credentialsFor: vi.fn(async () => ({})), isSyncing: vi.fn(), noteRemoved: vi.fn(), forgetDiscovery: vi.fn() }));
vi.mock('../services/caldavClient.js', () => ({
  discoverCalendars: vi.fn(), findCalDavServer: vi.fn(), deleteEvent: vi.fn(), moveEvent: vi.fn(),
  putEvent: vi.fn(async (href, ical, _creds, opts) => { state.puts.push({ href, ical, opts }); return { url: href, etag: '"2"' }; }),
  getEvent: vi.fn(async () => null),
}));
vi.mock('../services/mailInvites.js', () => ({
  readPendingObjects: vi.fn(async () => {}),
  invitationMail: vi.fn(async () => state.mail),
}));
vi.mock('../services/calendarInvites.js', () => ({
  forgetScheduling: vi.fn(),
  knownAddresses: vi.fn(async () => ['noe@example.com']),
  ownAddresses: vi.fn(async () => [{ account_id: 'acc1', email: 'noe@example.com', name: 'Noé' }]),
  mailLabels: () => ({}),
  planInvites: vi.fn(async () => state.plan),
  mailItip: vi.fn(async (m) => {
    if (state.smtpGate) await state.smtpGate;
    if (state.smtpFails) throw new Error('SMTP said no');
    state.mails.push(m);
    return { sent: m.to.length, rejected: [] };
  }),
}));

const express = (await import('express')).default;
const router = (await import('./calendar.js')).default;

const ICS = ({ method = 'REQUEST', seq = 0, partstat = 'NEEDS-ACTION' } = {}) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//t//EN',
  ...(method ? [`METHOD:${method}`] : []), 'BEGIN:VEVENT', 'UID:meet-1', 'DTSTAMP:20260101T000000Z', `SEQUENCE:${seq}`,
  'DTSTART:20370310T090000Z', 'DTEND:20370310T100000Z', 'SUMMARY:Budget review', 'ORGANIZER;CN=Boss:mailto:boss@example.com',
  `ATTENDEE;PARTSTAT=${partstat};RSVP=TRUE:mailto:noe@example.com`, 'ATTENDEE;PARTSTAT=ACCEPTED:mailto:ana@example.com',
  'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT10M', 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
const MAIL_ROW = ical => ({ message_id: '44444444-4444-4444-8444-444444444444', ical, account_id: 'acc1', account_email: 'noe@example.com',
  account_name: 'Work', folder: 'INBOX', special_use: null, date: new Date().toISOString() });

let server;
let base;
const call = async (method, path, body) => {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const answer = (status, extra) => call('POST', '/c/invitations/reply', { uid: 'meet-1', recurrenceId: null, status, ...extra });

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/c', router);
  await new Promise(r => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise(r => server.close(r)));
beforeEach(() => Object.assign(state, {
  mail: [MAIL_ROW(ICS())], events: [], replies: [], mails: [], puts: [], smtpFails: false, smtpGate: null,
  plan: { mode: 'mail', organizer: { email: 'noe@example.com' }, myEmails: ['noe@example.com'] },
}));

describe('the invitations inbox', () => {
  it('lists the invitation a message brought, without its iCalendar text', async () => {
    const r = await call('GET', '/c/invitations');
    expect(r.status).toBe(200);
    expect(r.body.invitations).toHaveLength(1);
    expect(r.body.invitations[0]).toMatchObject({ uid: 'meet-1', status: 'NEEDS-ACTION', source: 'mail', messageId: MAIL_ROW('').message_id, conflicts: [] });
    expect(r.body.invitations[0].ical).toBeUndefined();
  });

  it('accepting mails one REPLY to the organizer and puts the event in the calendar', async () => {
    const r = await answer('ACCEPTED');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, invitesSent: 1, calendarId: 'cal1' });
    expect(state.mails).toHaveLength(1);
    expect(state.mails[0]).toMatchObject({ from: 'noe@example.com', to: ['boss@example.com'], method: 'REPLY', kind: 'accepted' });
    expect(state.mails[0].ics).toMatch(/ATTENDEE;PARTSTAT=ACCEPTED[^\r\n]*:mailto:noe@example\.com/);
    expect(state.mails[0].ics).not.toMatch(/ana@example\.com/);
    expect(state.puts).toHaveLength(1);
    expect(state.puts[0].opts).toMatchObject({ create: true, scheduleReply: false });
    expect(state.puts[0].ical).not.toMatch(/METHOD:/);
    expect(state.puts[0].ical).toMatch(/PARTSTAT=ACCEPTED[^\r\n]*:mailto:noe@example\.com/);
    // Answered: it leaves the list.
    expect((await call('GET', '/c/invitations')).body.invitations).toEqual([]);
  });

  it('declining answers without adding the event, and is remembered', async () => {
    const r = await answer('DECLINED');
    expect(r.status).toBe(200);
    expect(state.mails.map(m => m.kind)).toEqual(['declined']);
    expect(state.puts).toEqual([]);
    expect(state.replies).toEqual([expect.objectContaining({ uid: 'meet-1', partstat: 'DECLINED', sequence: 0 })]);
    const list = (await call('GET', '/c/invitations')).body;
    expect(list.invitations).toEqual([]);
    expect(list.answered).toEqual([expect.objectContaining({ uid: 'meet-1', status: 'DECLINED' })]);
  });

  it('sends one answer for a double click', async () => {
    let open;
    state.smtpGate = new Promise(r => { open = r; });
    const first = answer('ACCEPTED');
    await new Promise(r => setTimeout(r, 50));
    const second = await answer('ACCEPTED');
    open();
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('busy');
    expect((await first).status).toBe(200);
    const again = await answer('ACCEPTED');
    expect(again.body).toEqual({ ok: true, unchanged: true });
    expect(state.mails).toHaveLength(1);
    expect(state.puts).toHaveLength(1);
  });

  it('does not send the same answer to the same revision twice', async () => {
    state.replies = [{ uid: 'meet-1', recurrence_id: '', sequence: 0, partstat: 'DECLINED', answered_at: new Date().toISOString() }];
    const r = await answer('DECLINED');
    expect(r.body).toEqual({ ok: true, unchanged: true });
    expect(state.mails).toEqual([]);
  });

  it('records nothing and writes nothing when the answer cannot be sent', async () => {
    state.smtpFails = true;
    const r = await answer('ACCEPTED');
    expect(r.status).toBe(502);
    expect(r.body.error).toBe('SMTP said no');
    expect(state.replies).toEqual([]);
    expect(state.puts).toEqual([]);
    expect((await call('GET', '/c/invitations')).body.invitations).toHaveLength(1);
  });

  it('answers a calendar copy through the calendar, which delivers it on a scheduling server', async () => {
    state.mail = [];
    state.plan = { ...state.plan, mode: 'server' };
    state.events = [{ id: '55555555-5555-4555-8555-555555555555', calendar_id: 'cal1', href: 'https://dav.example.com/cal/meet-1.ics', uid: 'meet-1', ical: ICS({ method: null }) }];
    const r = await answer('TENTATIVE');
    expect(r.status).toBe(200);
    expect(state.mails).toEqual([]);
    expect(state.puts).toHaveLength(1);
    expect(state.puts[0].opts).toEqual({ etag: '"1"' });
    expect(state.puts[0].ical).toMatch(/PARTSTAT=TENTATIVE[^\r\n]*:mailto:noe@example\.com/);
  });

  it('brings the calendar copy up to a newer mailed revision when answering it', async () => {
    state.mail = [MAIL_ROW(ICS({ seq: 2 }).replace('SUMMARY:Budget review', 'SUMMARY:Budget review (moved)'))];
    state.events = [{ id: '55555555-5555-4555-8555-555555555555', calendar_id: 'cal1', href: 'https://dav.example.com/cal/meet-1.ics', uid: 'meet-1', ical: ICS({ method: null, partstat: 'ACCEPTED' }) }];
    const r = await answer('ACCEPTED');
    expect(r.status).toBe(200);
    expect(state.mails).toHaveLength(1);
    expect(state.puts).toHaveLength(1);
    expect(state.puts[0].href).toBe('https://dav.example.com/cal/meet-1.ics');
    expect(state.puts[0].opts).toMatchObject({ etag: '"1"', scheduleReply: false });
    expect(state.puts[0].ical).toMatch(/SUMMARY:Budget review \(moved\)/);
    expect(state.puts[0].ical).toMatch(/SEQUENCE:2/);
  });

  it('refuses an invitation that is no longer open', async () => {
    state.mail = [];
    expect((await answer('ACCEPTED')).status).toBe(404);
    expect((await answer('MAYBE')).status).toBe(400);
  });
});
