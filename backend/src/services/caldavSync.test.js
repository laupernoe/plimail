import { beforeEach, describe, expect, it, vi } from 'vitest';

const accounts = new Map();
let due = [];
let existingCalendars = [];
let localEvents = [];
vi.mock('./db.js', () => ({
  query: vi.fn(async (sql, params) => {
    if (sql.startsWith('SELECT * FROM caldav_accounts')) return { rows: accounts.has(params[0]) ? [accounts.get(params[0])] : [] };
    if (sql.startsWith('SELECT NOW()')) return { rows: [{ now: new Date() }] };
    if (sql.startsWith('SELECT id, url, name, display_name FROM calendars')) return { rows: existingCalendars };
    if (sql.startsWith('SELECT href, etag FROM calendar_events')) return { rows: localEvents };
    if (sql.includes('INSERT INTO calendars')) return { rows: [{ id: `cal-${params[2]}`, user_id: params[1], url: params[2], ctag: 'same', ignored: false }] };
    if (sql.includes('FROM caldav_accounts') && sql.includes('last_sync_at IS NULL')) return { rows: due.map(id => ({ id })) };
    return { rows: [], rowCount: 0 };
  }),
}));
vi.mock('./encryption.js', () => ({ decrypt: v => v }));
vi.mock('./connectionPolicy.js', () => ({ getConnectionPolicy: async () => ({ allowPrivateHosts: false }) }));
vi.mock('./caldavClient.js', async (importOriginal) => {
  const real = await importOriginal();
  return {
    bindCredentials: real.bindCredentials,
    requireCalendars: real.requireCalendars,
    hrefKey: real.hrefKey,
    calendarGone: vi.fn(async () => false),
    discoverHome: vi.fn(),
    listCalendars: vi.fn(),
    listEvents: vi.fn(async () => []),
    fetchEvents: vi.fn(async () => []),
  };
});

const client = await import('./caldavClient.js');
const { query } = await import('./db.js');
const { syncAccount, syncDueAccounts, credentialsFor, forgetDiscovery, noteRemoved, SYNC_CONCURRENCY } = await import('./caldavSync.js');
const callsTo = start => query.mock.calls.filter(([sql]) => sql.trimStart().startsWith(start));

const calendar = { url: 'https://dav.example.com/h/work/', name: 'Work', ctag: 'same', color: null, readOnly: false };
const account = id => ({ id, user_id: 'u1', server_url: 'https://dav.example.com/', username: 'u', password: 'p' });

beforeEach(() => {
  accounts.clear();
  due = [];
  existingCalendars = [];
  localEvents = [];
  vi.clearAllMocks();
  client.listEvents.mockResolvedValue([]);
  client.fetchEvents.mockResolvedValue([]);
  client.calendarGone.mockResolvedValue(false);
  client.discoverHome.mockResolvedValue({ home: 'https://dav.example.com/h/', hint: null });
  client.listCalendars.mockResolvedValue({ home: 'https://dav.example.com/h/', calendars: [calendar], elsewhere: [] });
});

describe('credentialsFor', () => {
  it('binds the password to the origin of the server URL', async () => {
    expect((await credentialsFor(account('a'))).origins).toEqual(['https://dav.example.com']);
  });
  it('refuses an account row without its server URL rather than sending the password anywhere', async () => {
    await expect(credentialsFor({ username: 'u', password: 'p' })).rejects.toThrow(/Invalid server URL/);
  });
});

describe('discovery', () => {
  it('runs once, then later syncs list the calendar home it found', async () => {
    accounts.set('a', account('a'));
    forgetDiscovery('a');
    expect(await syncAccount('a')).toEqual({ ok: true });
    expect(await syncAccount('a')).toEqual({ ok: true });
    expect(client.discoverHome).toHaveBeenCalledTimes(1);
    expect(client.listCalendars).toHaveBeenCalledTimes(2);
    expect(client.listCalendars).toHaveBeenLastCalledWith('https://dav.example.com/h/', expect.objectContaining({ origins: ['https://dav.example.com'] }));
  });

  it('runs again on a manual sync', async () => {
    accounts.set('b', account('b'));
    await syncAccount('b');
    await syncAccount('b', { discover: true });
    expect(client.discoverHome).toHaveBeenCalledTimes(2);
  });

  it('runs again when the kept home is gone', async () => {
    accounts.set('c', account('c'));
    await syncAccount('c');
    client.listCalendars.mockRejectedValueOnce(Object.assign(new Error('gone'), { status: 404 }));
    expect(await syncAccount('c')).toEqual({ ok: true });
    expect(client.discoverHome).toHaveBeenCalledTimes(2);
  });

  it('runs again once a day', async () => {
    accounts.set('d', account('d'));
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      await syncAccount('d');
      vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000);
      await syncAccount('d');
    } finally {
      vi.useRealTimers();
    }
    expect(client.discoverHome).toHaveBeenCalledTimes(2);
  });

  it('reports a calendar listed on another origin instead of syncing it', async () => {
    accounts.set('e', account('e'));
    client.listCalendars.mockResolvedValue({ calendars: [calendar], elsewhere: [{ ...calendar, name: 'Shared', url: 'https://other.example/h/s/' }] });
    const result = await syncAccount('e');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('https://other.example/h/s/');
  });
});

describe('an event over the size cap', () => {
  it('is reported while the other events of its calendar still sync', async () => {
    const { query } = await import('./db.js');
    accounts.set('f', account('f'));
    client.listCalendars.mockResolvedValue({ calendars: [{ ...calendar, ctag: 'moved' }], elsewhere: [] });
    client.listEvents.mockResolvedValue([
      { rawHref: '/h/work/big.ics', url: 'https://dav.example.com/h/work/big.ics', etag: '"1"' },
      { rawHref: '/h/work/ok.ics', url: 'https://dav.example.com/h/work/ok.ics', etag: '"1"' },
    ]);
    client.fetchEvents.mockResolvedValue([
      { rawHref: '/h/work/big.ics', url: 'https://dav.example.com/h/work/big.ics', etag: null, ical: null, error: 'The event at … is larger than 25 MB' },
      { rawHref: '/h/work/ok.ics', url: 'https://dav.example.com/h/work/ok.ics', etag: '"1"', ical: 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:ok\r\nDTSTART:20260101T100000Z\r\nEND:VEVENT\r\nEND:VCALENDAR' },
    ]);
    const result = await syncAccount('f');
    expect(result.error).toMatch(/1 event\(s\) in "Work" could not be read/);
    const inserts = query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO calendar_events'));
    expect(inserts.map(([, params]) => params[2])).toEqual(['https://dav.example.com/h/work/ok.ics']);
    expect(query.mock.calls.some(([sql]) => sql.startsWith('UPDATE calendars SET ctag'))).toBe(false);
  });
});

describe('the scheduler', () => {
  it('syncs due accounts a few at a time, not one after another', async () => {
    const ids = ['1', '2', '3', '4', '5', '6', '7'];
    for (const id of ids) accounts.set(id, account(id));
    due = ids;
    let running = 0;
    let peak = 0;
    client.listCalendars.mockImplementation(async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise(resolve => setTimeout(resolve, 20));
      running--;
      return { calendars: [calendar], elsewhere: [] };
    });
    client.discoverHome.mockResolvedValue({ home: 'https://dav.example.com/h/', hint: null });
    await syncDueAccounts();
    expect(peak).toBe(SYNC_CONCURRENCY);
    expect(SYNC_CONCURRENCY).toBeGreaterThan(1);
    expect(client.listCalendars).toHaveBeenCalledTimes(ids.length);
  });
});

describe('calendars the server no longer lists', () => {
  const row = (id, url, name) => ({ id, url, name, display_name: `${name} (mine)` });

  it('keeps a calendar whose own URL does not answer that it is gone, and says so', async () => {
    accounts.set('g', account('g'));
    existingCalendars = [row('c-old', 'https://dav.example.com/old-home/work/', 'Work')];
    client.calendarGone.mockResolvedValue(false);
    const result = await syncAccount('g');
    expect(client.calendarGone).toHaveBeenCalledWith('https://dav.example.com/old-home/work/', expect.anything());
    expect(callsTo('DELETE FROM calendars')).toEqual([]);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Work (mine): no longer listed');
  });

  it('keeps a calendar whose URL fails to answer at all', async () => {
    accounts.set('h', account('h'));
    existingCalendars = [row('c-old', 'https://dav.example.com/old-home/work/', 'Work')];
    client.calendarGone.mockRejectedValue(new Error('CalDAV request failed (500 Internal Server Error)'));
    const result = await syncAccount('h');
    expect(callsTo('DELETE FROM calendars')).toEqual([]);
    expect(result.error).toContain('500');
  });

  it('drops a calendar whose own URL answers 404', async () => {
    accounts.set('i', account('i'));
    existingCalendars = [row('c-gone', 'https://dav.example.com/h/gone/', 'Gone')];
    client.calendarGone.mockResolvedValue(true);
    expect(await syncAccount('i')).toEqual({ ok: true });
    const deletes = callsTo('DELETE FROM calendars');
    expect(deletes).toHaveLength(1);
    expect(deletes[0][1]).toEqual(['i', ['c-gone']]);
  });

  it('updates a calendar the server spells another way instead of replacing it', async () => {
    accounts.set('j', account('j'));
    existingCalendars = [row('c-work', 'https://dav.example.com/h/w%6Frk/', 'Work')];
    expect(await syncAccount('j')).toEqual({ ok: true });
    expect(client.calendarGone).not.toHaveBeenCalled();
    expect(callsTo('DELETE FROM calendars')).toEqual([]);
    expect(callsTo('INSERT INTO calendars')[0][1][2]).toBe('https://dav.example.com/h/w%6Frk/');
  });

  it('drops nothing when the listing fails', async () => {
    accounts.set('k', account('k'));
    existingCalendars = [row('c-work', calendar.url, 'Work')];
    client.listCalendars.mockRejectedValue(new Error('Could not reach the CalDAV server'));
    expect((await syncAccount('k')).ok).toBe(false);
    expect(client.calendarGone).not.toHaveBeenCalled();
    expect(callsTo('DELETE FROM calendars')).toEqual([]);
  });
});

describe('events the server no longer lists', () => {
  const moved = () => client.listCalendars.mockResolvedValue({ home: 'https://dav.example.com/h/', calendars: [{ ...calendar, ctag: 'moved' }], elsewhere: [] });
  const ev = name => ({ rawHref: `/h/work/${name}`, url: `https://dav.example.com/h/work/${name}`, etag: '"1"' });

  it('are deleted, but only if not written since the sync began', async () => {
    accounts.set('l', account('l'));
    moved();
    localEvents = [{ href: 'https://dav.example.com/h/work/a.ics', etag: '"1"' }, { href: 'https://dav.example.com/h/work/b.ics', etag: '"1"' }];
    client.listEvents.mockResolvedValue([ev('a.ics')]);
    expect(await syncAccount('l')).toEqual({ ok: true });
    const deletes = callsTo('DELETE FROM calendar_events');
    expect(deletes).toHaveLength(1);
    expect(deletes[0][0]).toContain('updated_at < $3');
    expect(deletes[0][1][1]).toEqual(['https://dav.example.com/h/work/b.ics']);
  });

  it('are not deleted when the server lists them under another spelling', async () => {
    accounts.set('m', account('m'));
    moved();
    localEvents = [{ href: 'https://dav.example.com/h/work/a%40b.ics', etag: '"1"' }];
    client.listEvents.mockResolvedValue([ev('a@b.ics')]);
    expect(await syncAccount('m')).toEqual({ ok: true });
    expect(callsTo('DELETE FROM calendar_events')).toEqual([]);
  });

  it('a listing that fails deletes nothing', async () => {
    accounts.set('n', account('n'));
    moved();
    localEvents = [{ href: 'https://dav.example.com/h/work/a.ics', etag: '"1"' }];
    client.listEvents.mockRejectedValue(new Error('CalDAV server returned a truncated response'));
    expect((await syncAccount('n')).ok).toBe(false);
    expect(callsTo('DELETE FROM calendar_events')).toEqual([]);
  });
});

describe('a sync running while the user changes things', () => {
  const ICS = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x\r\nDTSTART:20260101T100000Z\r\nEND:VEVENT\r\nEND:VCALENDAR';
  const setup = (id) => {
    accounts.set(id, account(id));
    client.listCalendars.mockResolvedValue({ home: 'https://dav.example.com/h/', calendars: [{ ...calendar, ctag: 'moved' }], elsewhere: [] });
    client.listEvents.mockResolvedValue([{ rawHref: '/h/work/x.ics', url: 'https://dav.example.com/h/work/x.ics', etag: '"2"' }]);
  };

  it('does not write back an event the user deleted after it began', async () => {
    setup('o');
    client.fetchEvents.mockImplementation(async () => {
      // The user deletes the event while the sync is fetching it.
      noteRemoved(`cal-${calendar.url}`, 'https://dav.example.com/h/work/x.ics');
      return [{ rawHref: '/h/work/x.ics', url: 'https://dav.example.com/h/work/x.ics', etag: '"2"', ical: ICS }];
    });
    expect(await syncAccount('o')).toEqual({ ok: true });
    expect(callsTo('INSERT INTO calendar_events')).toEqual([]);
  });

  it('writes an event only into a calendar that is not ignored, under a lock on the calendar row', async () => {
    setup('p');
    client.fetchEvents.mockResolvedValue([{ rawHref: '/h/work/x.ics', url: 'https://dav.example.com/h/work/x.ics', etag: '"2"', ical: ICS }]);
    expect(await syncAccount('p')).toEqual({ ok: true });
    const [insert] = callsTo('INSERT INTO calendar_events');
    expect(insert[0]).toMatch(/FROM calendars WHERE id = \$1 AND NOT ignored FOR SHARE/);
    expect(callsTo('UPDATE calendars SET ctag')[0][0]).toContain('NOT ignored');
  });
});
