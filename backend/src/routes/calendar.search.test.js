import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ rows: [] }));
vi.mock('../services/db.js', () => ({ query: vi.fn(async () => ({ rows: state.rows })) }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _r, n) => { req.session = { userId: 'u1' }; n(); } }));
vi.mock('../services/caldavSync.js', () => ({
  syncAccount: vi.fn(), credentialsFor: vi.fn(), isSyncing: vi.fn(), noteRemoved: vi.fn(), forgetDiscovery: vi.fn(),
}));
vi.mock('../services/caldavClient.js', () => ({
  discoverCalendars: vi.fn(), findCalDavServer: vi.fn(), getEvent: vi.fn(), putEvent: vi.fn(), deleteEvent: vi.fn(), moveEvent: vi.fn(),
}));
vi.mock('../services/calendarInvites.js', () => ({
  forgetScheduling: vi.fn(), knownAddresses: vi.fn(async () => ['me@example.com']), mailLabels: () => ({}), planInvites: vi.fn(), mailItip: vi.fn(),
}));

const express = (await import('express')).default;
const router = (await import('./calendar.js')).default;
const { query } = await import('../services/db.js');
const { resourceInfo } = await import('../services/icalEvents.js');

const NOW = Date.parse('2026-11-16T12:00:00Z');

const ics = (uid, lines) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//t//EN', 'BEGIN:VEVENT', `UID:${uid}`,
  'DTSTAMP:20260101T000000Z', ...lines, 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
const row = (id, ical) => {
  const info = resourceInfo(ical);
  return { id, calendar_id: 'c1', ical, range_start: info.rangeStart, range_end: info.rangeEnd, read_only: false };
};

const DINNER = row('e-dinner', ics('dinner', ['DTSTART:20261201T190000Z', 'DTEND:20261201T210000Z',
  'SUMMARY:Dîner au Café', 'LOCATION:Rue de la Paix\\, Paris']));
const STANDUP = row('e-standup', ics('standup', ['DTSTART:20260105T090000Z', 'DTEND:20260105T091500Z',
  'RRULE:FREQ=WEEKLY', 'SUMMARY:Standup', 'DESCRIPTION:Tour de table\\npuis bugs']));
const CLASS = row('e-class', ics('class', ['DTSTART:20260302T180000Z', 'DTEND:20260302T190000Z',
  'RRULE:FREQ=WEEKLY;COUNT=3', 'SUMMARY:Cours de dessin', 'ORGANIZER;CN=Élodie Martin:mailto:elodie@example.com']));
const OLD = row('e-old', ics('old', ['DTSTART:20250610T080000Z', 'DTEND:20250610T090000Z', 'SUMMARY:Dessin ancien']));
const FOLDED = row('e-folded', ics('folded', ['DTSTART:20261120T080000Z', 'DTEND:20261120T090000Z',
  'SUMMARY:Revue du budget tri', ' mestriel']));

const MOVED = row('e-moved', ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//t//EN',
  'BEGIN:VEVENT', 'UID:moved', 'DTSTAMP:20260101T000000Z', 'DTSTART:20260106T100000Z', 'DTEND:20260106T110000Z',
  'RRULE:FREQ=WEEKLY', 'SUMMARY:Atelier', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:moved', 'DTSTAMP:20260101T000000Z', 'RECURRENCE-ID:20261124T100000Z',
  'DTSTART:20261127T100000Z', 'DTEND:20261127T110000Z', 'SUMMARY:Atelier déplacé', 'END:VEVENT',
  'END:VCALENDAR', ''].join('\r\n'));

let server;
let base;
const search = async (params) => {
  const r = await fetch(`${base}/c/events/search?${new URLSearchParams(params)}`);
  return { status: r.status, body: await r.json() };
};
const lastSql = () => query.mock.calls.at(-1);

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  const app = express();
  app.use('/c', router);
  await new Promise(r => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => { vi.useRealTimers(); return new Promise(r => server.close(r)); });
beforeEach(() => {
  vi.clearAllMocks();
  state.rows = [DINNER, STANDUP, CLASS, OLD, FOLDED];
});

describe('GET /events/search', () => {
  it('matches the title, without regard to case or accents', async () => {
    const { status, body } = await search({ q: 'DINER au cafe' });
    expect(status).toBe(200);
    expect(body.events.map(e => e.eventId)).toEqual(['e-dinner']);
    expect(body.events[0]).toMatchObject({
      id: 'e-dinner:', calendarId: 'c1', summary: 'Dîner au Café', start: '2026-12-01T19:00:00.000Z',
      upcoming: true, readOnly: false, isRecurring: false,
    });
  });

  it('matches the location and the description as the event reads them, not as iCal escapes them', async () => {
    expect((await search({ q: 'paix, paris' })).body.events.map(e => e.eventId)).toEqual(['e-dinner']);
    expect((await search({ q: 'tour de table' })).body.events.map(e => e.eventId)).toEqual(['e-standup']);
    expect((await search({ q: 'bugs' })).body.events.map(e => e.eventId)).toEqual(['e-standup']);
  });

  it('matches a title folded over two lines', async () => {
    expect((await search({ q: 'trimestriel' })).body.events.map(e => e.eventId)).toEqual(['e-folded']);
  });

  it('matches the organizer by name or address', async () => {
    expect((await search({ q: 'elodie' })).body.events.map(e => e.eventId)).toEqual(['e-class']);
    expect((await search({ q: 'elodie@example' })).body.events.map(e => e.eventId)).toEqual(['e-class']);
  });

  it('ignores what SQL matched outside the searched properties', async () => {
    expect((await search({ q: 'vevent' })).body.events).toEqual([]);
    expect((await search({ q: 'standup@' })).body.events).toEqual([]);
  });

  it('gives a series once, at its next occurrence', async () => {
    const { body } = await search({ q: 'standup' });
    expect(body.events).toHaveLength(1);
    expect(body.events[0]).toMatchObject({ start: '2026-11-23T09:00:00.000Z', recurrenceId: '2026-11-23T09:00:00Z', upcoming: true });
    expect(body.events[0].id).toBe('e-standup:2026-11-23T09:00:00Z');
  });

  it('finds an exception by its own title, and keeps the series in date order around it', async () => {
    state.rows = [MOVED];
    expect((await search({ q: 'deplace' })).body.events.map(e => e.start)).toEqual(['2026-11-27T10:00:00.000Z']);
    expect((await search({ q: 'atelier' })).body.events.map(e => e.start)).toEqual(['2026-11-17T10:00:00.000Z']);
  });

  it('gives an ended series at its last occurrence, upcoming first and then the most recent past', async () => {
    const { body } = await search({ q: 'dessin' });
    expect(body.events.map(e => [e.eventId, e.start, e.upcoming])).toEqual([
      ['e-class', '2026-03-16T18:00:00.000Z', false],
      ['e-old', '2025-06-10T08:00:00.000Z', false],
    ]);
    state.rows = [OLD, DINNER, CLASS, STANDUP];
    const order = (await search({ q: 'de' })).body.events.map(e => e.eventId);
    expect(order).toEqual(['e-standup', 'e-dinner', 'e-class', 'e-old']);
  });

  it('asks SQL only for the user\'s events in calendars that are shown and not ignored', async () => {
    await search({ q: 'standup' });
    const [sql, params] = lastSql();
    expect(sql).toMatch(/e\.user_id = \$1/);
    expect(sql).toMatch(/c\.visible AND NOT c\.ignored/);
    expect(sql).toMatch(/ILIKE \$2 ESCAPE/);
    expect(sql).toMatch(/LIMIT 500/);
    expect(params[0]).toBe('u1');
    expect(params[1]).toBe('%standup%');
  });

  it('escapes LIKE wildcards in the search', async () => {
    await search({ q: '50%_off\\' });
    expect(lastSql()[1][1]).toBe('%50\\%\\_off\\\\%');
  });

  it('folds accents in the SQL pattern too', async () => {
    await search({ q: 'Café' });
    expect(lastSql()[1][1]).toBe('%cafe%');
  });

  it('refuses a search too short or too long', async () => {
    for (const q of [undefined, '', ' a ', 'x'.repeat(201)]) {
      const { status } = await search(q === undefined ? {} : { q });
      expect(status).toBe(400);
    }
    expect(query).not.toHaveBeenCalled();
    expect((await search({ q: `  ${'x'.repeat(200)}  ` })).status).toBe(200);
  });
});
