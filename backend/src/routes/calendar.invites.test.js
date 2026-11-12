import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ event: null, stored: null, plan: null, mails: [], puts: [] }));
vi.mock('../services/db.js', () => ({
  query: vi.fn(async (sql) => {
    if (/FROM calendars c JOIN caldav_accounts/.test(sql)) {
      return { rows: [{ id: 'c1', account_id: 'a1', user_id: 'u1', url: 'https://dav.example.com/cal/', read_only: false, username: 'noe@example.com', password: 'x' }] };
    }
    if (/FROM calendar_events e\s+JOIN calendars c/.test(sql)) return { rows: state.event ? [state.event] : [] };
    if (/INSERT INTO calendar_events/.test(sql)) return { rows: [{ id: 'e-new' }] };
    return { rows: [], rowCount: 1 };
  }),
}));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _r, n) => { req.session = { userId: 'u1' }; n(); } }));
vi.mock('../services/caldavSync.js', () => ({ syncAccount: vi.fn(), credentialsFor: vi.fn(async () => ({})), isSyncing: vi.fn() }));
vi.mock('../services/caldavClient.js', () => ({
  discoverCalendars: vi.fn(), findCalDavServer: vi.fn(), deleteEvent: vi.fn(),
  putEvent: vi.fn(async (href, ical) => { state.puts.push(ical); state.stored = ical; return { url: href }; }),
  getEvent: vi.fn(async () => ({ etag: '"2"', ical: state.stored })),
}));
vi.mock('../services/calendarInvites.js', () => ({
  forgetScheduling: vi.fn(),
  knownAddresses: vi.fn(async () => ['noe@example.com']),
  mailLabels: () => ({}),
  planInvites: vi.fn(async () => state.plan),
  mailItip: vi.fn(async (m) => { state.mails.push(m); return { sent: m.to.length, rejected: [] }; }),
}));

const express = (await import('express')).default;
const router = (await import('./calendar.js')).default;

const MAIL_PLAN = { mode: 'mail', organizer: { email: 'noe@example.com', name: 'Noé' }, myEmails: ['noe@example.com'] };
const SERVER_PLAN = { ...MAIL_PLAN, mode: 'server' };
const EVENT_ID = '11111111-1111-4111-8111-111111111111';
const times = { start: '2027-03-10T09:00:00Z', end: '2027-03-10T10:00:00Z', allDay: false, timezone: 'Europe/Zurich' };
const vevent = (...lines) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//t//EN', 'BEGIN:VEVENT', 'UID:inv', 'DTSTAMP:20260101T000000Z',
  'DTSTART:20270310T090000Z', 'DTEND:20270310T100000Z', 'SUMMARY:Point', ...lines, 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
const stored = ical => ({ id: EVENT_ID, calendar_id: 'c1', user_id: 'u1', href: 'https://dav.example.com/cal/inv.ics', etag: '"1"', ical,
  read_only: false, account_id: 'a1', calendar_url: 'https://dav.example.com/cal/', username: 'noe@example.com', password: 'x' });
const MINE = vevent('ORGANIZER:mailto:noe@example.com', 'ATTENDEE;PARTSTAT=ACCEPTED:mailto:noe@example.com',
  'ATTENDEE;PARTSTAT=ACCEPTED:mailto:ana@example.com', 'ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:bob@example.com');
const THEIRS = vevent('ORGANIZER:mailto:boss@example.com', 'ATTENDEE;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:noe@example.com');

let server;
let base;
const call = async (method, path, body) => {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/c', router);
  await new Promise(r => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise(r => server.close(r)));
beforeEach(() => Object.assign(state, { event: null, stored: null, plan: MAIL_PLAN, mails: [], puts: [] }));

describe('invitations', () => {
  it('mails an invitation to each attendee when the server does not schedule', async () => {
    const r = await call('POST', '/c/events', { calendarId: '22222222-2222-4222-8222-222222222222', summary: 'Point', ...times,
      attendees: [{ email: 'Ana@Example.com', name: 'Ana' }, { email: 'ana@example.com' }] });
    expect(r.status).toBe(200);
    expect(r.body.invitesSent).toBe(1);
    expect(state.mails).toEqual([expect.objectContaining({ from: 'noe@example.com', to: ['ana@example.com'], method: 'REQUEST', kind: 'invite' })]);
    expect(state.puts[0]).toMatch(/ORGANIZER;CN=Noé:mailto:noe@example\.com/);
  });

  it('leaves delivery to a server that schedules', async () => {
    state.plan = SERVER_PLAN;
    const r = await call('POST', '/c/events', { calendarId: '22222222-2222-4222-8222-222222222222', summary: 'Point', ...times, attendees: [{ email: 'ana@example.com' }] });
    expect(r.status).toBe(200);
    expect(state.mails).toEqual([]);
    expect(state.puts[0]).toMatch(/mailto:ana@example\.com/);
  });

  it('refuses an invitation when no mail account can send it', async () => {
    state.plan = { ...MAIL_PLAN, organizer: null };
    const r = await call('POST', '/c/events', { calendarId: '22222222-2222-4222-8222-222222222222', summary: 'Point', ...times, attendees: [{ email: 'ana@example.com' }] });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('no_sender');
    expect(state.puts).toEqual([]);
  });

  it('rejects an address that is not one', async () => {
    const r = await call('POST', '/c/events', { calendarId: '22222222-2222-4222-8222-222222222222', summary: 'Point', ...times, attendees: [{ email: 'ana' }] });
    expect(r.status).toBe(400);
  });

  it('cancels for the people taken off and updates the others', async () => {
    state.event = stored(MINE);
    const r = await call('PATCH', `/c/events/${EVENT_ID}`, { attendees: [{ email: 'ana@example.com' }] });
    expect(r.status).toBe(200);
    expect(state.mails.map(m => [m.method, m.to])).toEqual([['CANCEL', ['bob@example.com']], ['REQUEST', ['ana@example.com']]]);
    expect(state.mails[0].only).toEqual(['bob@example.com']);
    expect(state.puts[0]).not.toMatch(/bob@/);
  });

  // What the form sends: every field, whether it changed or not.
  const formBody = extra => ({
    calendarId: 'c1', summary: 'Point', location: '', description: '', ...times, reminderMinutes: null, scope: 'all',
    attendees: [{ email: 'ana@example.com', name: null }, { email: 'bob@example.com', name: null }], lang: 'en', ...extra,
  });

  it('sends no update for a change of reminder only', async () => {
    state.event = stored(MINE);
    const r = await call('PATCH', `/c/events/${EVENT_ID}`, formBody({ reminderMinutes: 10 }));
    expect(r.status).toBe(200);
    expect(state.puts[0]).toMatch(/VALARM/);
    expect(state.mails).toEqual([]);
  });

  it('updates everyone when the title changes', async () => {
    state.event = stored(MINE);
    await call('PATCH', `/c/events/${EVENT_ID}`, formBody({ summary: 'Point (salle 2)' }));
    expect(state.mails.map(m => [m.method, m.kind, m.to])).toEqual([['REQUEST', 'update', ['ana@example.com', 'bob@example.com']]]);
  });

  it('keeps attendees out of the hands of someone who did not organize', async () => {
    state.event = stored(THEIRS);
    const r = await call('PATCH', `/c/events/${EVENT_ID}`, { attendees: [{ email: 'eve@example.com' }] });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('not_organizer');
    expect(state.puts).toEqual([]);
  });

  it('cancels for everyone when the organizer deletes the event', async () => {
    state.event = stored(MINE);
    const r = await call('DELETE', `/c/events/${EVENT_ID}`);
    expect(r.status).toBe(200);
    expect(state.mails.map(m => [m.method, m.to])).toEqual([['CANCEL', ['ana@example.com', 'bob@example.com']]]);
  });

  it('answers the organizer of an invitation', async () => {
    state.event = stored(THEIRS);
    const r = await call('POST', `/c/events/${EVENT_ID}/reply`, { status: 'ACCEPTED' });
    expect(r.status).toBe(200);
    expect(state.puts[0]).toMatch(/PARTSTAT=ACCEPTED:mailto:noe@example\.com/);
    expect(state.mails).toEqual([expect.objectContaining({ from: 'noe@example.com', to: ['boss@example.com'], method: 'REPLY', kind: 'accepted', only: ['noe@example.com'] })]);
  });

  it('marks who organizes in the event list', async () => {
    const { query } = await import('../services/db.js');
    query.mockImplementationOnce(async () => ({ rows: [{ id: 'x', calendar_id: 'c1', ical: THEIRS, read_only: false }, { id: 'y', calendar_id: 'c1', ical: MINE, read_only: false }] }));
    const r = await call('GET', '/c/events?from=2027-03-01T00:00:00Z&to=2027-04-01T00:00:00Z');
    expect(r.body.events.map(e => [e.eventId, e.organizerIsMe, e.myStatus])).toEqual([['x', false, 'NEEDS-ACTION'], ['y', true, null]]);
  });
});
