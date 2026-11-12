import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ sql: [], row: null }));
vi.mock('../services/db.js', () => ({
  query: vi.fn(async (sql, params) => {
    state.sql.push({ sql, params });
    if (/^SELECT ignored FROM calendars/.test(sql)) return { rows: [{ ignored: state.row.ignored }], rowCount: 1 };
    if (/^\s*UPDATE calendars/.test(sql)) {
      const [, , , , setName, name, ignored] = params;
      if (setName) state.row.display_name = name || null;
      if (ignored !== null) state.row.ignored = ignored;
      return { rows: [{ account_id: 'a1' }], rowCount: 1 };
    }
    if (/FROM calendars c JOIN caldav_accounts a/.test(sql)) return { rows: [state.row] };
    return { rows: [], rowCount: 1 };
  }),
}));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _r, n) => { req.session = { userId: 'u1' }; n(); } }));
vi.mock('../services/caldavSync.js', () => ({ syncAccount: vi.fn(async () => ({ ok: true })), credentialsFor: vi.fn(), isSyncing: vi.fn() }));
vi.mock('../services/caldavClient.js', () => ({}));
vi.mock('../services/calendarInvites.js', () => ({ forgetScheduling: vi.fn(), knownAddresses: vi.fn(async () => []), mailLabels: () => ({}) }));

const express = (await import('express')).default;
const router = (await import('./calendar.js')).default;
const { syncAccount } = await import('../services/caldavSync.js');
const { forgetScheduling } = await import('../services/calendarInvites.js');

let server;
let base;
const call = async (method, path, body) => {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const ID = '33333333-3333-4333-8333-333333333333';

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/c', router);
  await new Promise(r => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise(r => server.close(r)));
beforeEach(() => {
  state.sql = [];
  state.row = { id: ID, account_id: 'a1', account_name: 'Yety', name: '[allan@x.ch] - Calendar', display_name: null, ignored: false, visible: true, read_only: false };
  syncAccount.mockClear();
});

describe('calendar settings', () => {
  it('leaves an account that is not the user\'s alone when asked to sync it', async () => {
    forgetScheduling.mockClear();
    expect((await call('POST', `/c/accounts/${ID}/sync`)).status).toBe(404);
    expect(forgetScheduling).not.toHaveBeenCalled();
    expect(syncAccount).not.toHaveBeenCalled();
  });

  it('shows the name the user gave over the server name, and clears it with an empty one', async () => {
    let r = await call('PATCH', `/c/calendars/${ID}`, { displayName: '  Allan\n' });
    expect(r.body).toMatchObject({ name: 'Allan', serverName: '[allan@x.ch] - Calendar', displayName: 'Allan' });
    r = await call('PATCH', `/c/calendars/${ID}`, { displayName: '' });
    expect(r.body).toMatchObject({ name: '[allan@x.ch] - Calendar', displayName: null });
  });

  it('rejects a name that is not a string', async () => {
    expect((await call('PATCH', `/c/calendars/${ID}`, { displayName: 5 })).status).toBe(400);
    expect((await call('PATCH', `/c/calendars/${ID}`, { ignored: 'yes' })).status).toBe(400);
  });

  it('drops the events of an ignored calendar and syncs it again when taken back', async () => {
    let r = await call('PATCH', `/c/calendars/${ID}`, { ignored: true });
    expect(r.body.ignored).toBe(true);
    expect(state.sql.some(q => /DELETE FROM calendar_events WHERE calendar_id/.test(q.sql))).toBe(true);
    expect(syncAccount).not.toHaveBeenCalled();
    state.sql = [];
    r = await call('PATCH', `/c/calendars/${ID}`, { ignored: false });
    expect(r.body.ignored).toBe(false);
    expect(state.sql.some(q => /DELETE FROM calendar_events/.test(q.sql))).toBe(false);
    expect(syncAccount).toHaveBeenCalledWith('a1');
  });

  it('leaves ignored calendars out of the list unless all are asked for', async () => {
    await call('GET', '/c/calendars');
    expect(state.sql.at(-1).sql).toMatch(/AND NOT c\.ignored/);
    await call('GET', '/c/calendars?all=1');
    expect(state.sql.at(-1).sql).not.toMatch(/AND NOT c\.ignored/);
  });

  it('leaves events of ignored calendars out of the range', async () => {
    await call('GET', '/c/events?from=2027-01-01T00:00:00Z&to=2027-02-01T00:00:00Z');
    expect(state.sql.find(q => /FROM calendar_events e JOIN calendars c/.test(q.sql)).sql).toMatch(/NOT c\.ignored/);
  });
});
