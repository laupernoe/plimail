import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ event: null, server: null }));
vi.mock('../services/db.js', () => ({
  query: vi.fn(async (sql) => {
    if (/FROM calendars c JOIN caldav_accounts/.test(sql)) {
      return { rows: [{ id: 't1', account_id: 'a1', user_id: 'u1', url: 'https://dav.example.com/cal/home/', read_only: false, username: 'u', password: 'x' }] };
    }
    if (/FROM calendar_events e\s+JOIN calendars c/.test(sql)) return { rows: state.event ? [state.event] : [] };
    if (/INSERT INTO calendar_events/.test(sql)) return { rows: [{ id: 'e-new' }] };
    return { rows: [], rowCount: 1 };
  }),
}));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _r, n) => { req.session = { userId: 'u1' }; n(); } }));
vi.mock('../services/caldavSync.js', () => ({
  syncAccount: vi.fn(async () => ({ ok: true })), credentialsFor: vi.fn(async () => ({ origins: ['https://dav.example.com'] })),
  isSyncing: vi.fn(), noteRemoved: vi.fn(), forgetDiscovery: vi.fn(),
}));
vi.mock('../services/caldavClient.js', () => ({
  discoverCalendars: vi.fn(), findCalDavServer: vi.fn(),
  getEvent: vi.fn(async () => state.server),
  putEvent: vi.fn(async (href, ical) => { state.server = { etag: '"9"', ical }; return { url: href, etag: '"9"' }; }),
  deleteEvent: vi.fn(async () => {}),
  moveEvent: vi.fn(async (url, destination) => ({ url: destination })),
}));
vi.mock('../services/calendarInvites.js', () => ({
  forgetScheduling: vi.fn(), knownAddresses: vi.fn(async () => []), mailLabels: () => ({}), planInvites: vi.fn(), mailItip: vi.fn(),
}));

const express = (await import('express')).default;
const router = (await import('./calendar.js')).default;
const client = await import('../services/caldavClient.js');
const { noteRemoved } = await import('../services/caldavSync.js');

const EVENT_ID = '11111111-1111-4111-8111-111111111111';
const TARGET_ID = '22222222-2222-4222-8222-222222222222';
const ICS = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//t//EN', 'BEGIN:VEVENT', 'UID:e', 'DTSTAMP:20260101T000000Z',
  'DTSTART:20270310T090000Z', 'DTEND:20270310T100000Z', 'SUMMARY:Point', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
const row = (etag = '"1"') => ({ id: EVENT_ID, calendar_id: 'c1', user_id: 'u1', href: 'https://dav.example.com/cal/work/e.ics', etag, ical: ICS,
  read_only: false, account_id: 'a1', calendar_url: 'https://dav.example.com/cal/work/', server_url: 'https://dav.example.com/', username: 'u', password: 'x' });

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
beforeEach(() => {
  vi.clearAllMocks();
  state.event = row();
  state.server = { etag: '"1"', ical: ICS };
});

describe('moving an event to another calendar', () => {
  it('is one MOVE guarded by its version, then the edit at its new place', async () => {
    const r = await call('PATCH', `/c/events/${EVENT_ID}`, { calendarId: TARGET_ID, summary: 'Moved' });
    expect(r.status).toBe(200);
    expect(client.moveEvent).toHaveBeenCalledWith('https://dav.example.com/cal/work/e.ics', 'https://dav.example.com/cal/home/e.ics', expect.anything(), { etag: '"1"' });
    expect(client.deleteEvent).not.toHaveBeenCalled();
    expect(client.putEvent.mock.calls.every(([, , , opts]) => !opts.create)).toBe(true);
    expect(client.putEvent.mock.calls[0][0]).toBe('https://dav.example.com/cal/home/e.ics');
    expect(client.putEvent.mock.calls[0][2]).not.toBeNull();
    expect(client.putEvent.mock.calls[0][3]).toEqual({ etag: '"1"' });
    expect(noteRemoved).toHaveBeenCalledWith('c1', 'https://dav.example.com/cal/work/e.ics');
  });

  it('copies then deletes the original by its version on a server that will not move', async () => {
    client.moveEvent.mockRejectedValueOnce(Object.assign(new Error('no'), { unsupported: true }));
    const r = await call('PATCH', `/c/events/${EVENT_ID}`, { calendarId: TARGET_ID, summary: 'Moved' });
    expect(r.status).toBe(200);
    expect(client.putEvent.mock.calls[0][3]).toEqual({ create: true });
    expect(client.deleteEvent).toHaveBeenCalledWith('https://dav.example.com/cal/work/e.ics', expect.anything(), { etag: '"1"' });
  });

  it('leaves both calendars alone when the event changed on the server', async () => {
    client.moveEvent.mockRejectedValueOnce(Object.assign(new Error('Event changed on the server'), { conflict: true }));
    const r = await call('PATCH', `/c/events/${EVENT_ID}`, { calendarId: TARGET_ID, summary: 'Moved' });
    expect(r.status).toBe(409);
    expect(client.putEvent).not.toHaveBeenCalled();
    expect(client.deleteEvent).not.toHaveBeenCalled();
  });
});

describe('an event stored without its version', () => {
  it('is read again, and the version the server gives is the one the write names', async () => {
    state.event = row(null);
    state.server = { etag: '"5"', ical: ICS.replace(/\r\n/g, '\n') };
    const r = await call('DELETE', `/c/events/${EVENT_ID}`);
    expect(r.status).toBe(200);
    expect(client.deleteEvent).toHaveBeenCalledWith('https://dav.example.com/cal/work/e.ics', expect.anything(), { etag: '"5"' });
  });

  it('is a conflict, not an overwrite, when the server holds something else', async () => {
    state.event = row(null);
    state.server = { etag: '"5"', ical: ICS.replace('SUMMARY:Point', 'SUMMARY:Changed elsewhere') };
    expect((await call('DELETE', `/c/events/${EVENT_ID}`)).status).toBe(409);
    expect((await call('PATCH', `/c/events/${EVENT_ID}`, { summary: 'Mine' })).status).toBe(409);
    expect(client.deleteEvent).not.toHaveBeenCalled();
    expect(client.putEvent).not.toHaveBeenCalled();
  });
});

describe('deleting an event', () => {
  it('marks it removed, so a sync already under way does not bring it back', async () => {
    expect((await call('DELETE', `/c/events/${EVENT_ID}`)).status).toBe(200);
    expect(noteRemoved).toHaveBeenCalledWith('c1', 'https://dav.example.com/cal/work/e.ics');
  });
});
