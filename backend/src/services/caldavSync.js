// Pulls each connected CalDAV account into calendars and calendar_events. A calendar whose ctag has
// not moved is skipped; otherwise etags are compared and only changed events are fetched. Local rows
// are written by this sync and by routes/calendar.js at once, so a row touched after the sync began
// is left alone: the listing the sync works from may predate that write.

import { query } from './db.js';
import { decrypt } from './encryption.js';
import { getConnectionPolicy } from './connectionPolicy.js';
import { bindCredentials, calendarGone, discoverHome, listCalendars, requireCalendars, listEvents, fetchEvents, hrefKey } from './caldavClient.js';
import { resourceInfo, eventLoopYielder } from './icalEvents.js';

const TICK_MS = 60 * 1000;
// Due accounts sync a few at a time: a slow server holds up only its own slot, and this process,
// which also runs the mail engine, never has more than this many calendar syncs under way from here.
export const SYNC_CONCURRENCY = 3;
// Discovery takes up to a dozen requests and its answer seldom changes, so the calendar home it
// found is kept and later syncs list only that. It is found again on a manual sync, once a day, and
// as soon as the kept home stops answering or a calendar in it is gone.
export const REDISCOVER_MS = 24 * 60 * 60 * 1000;
const homes = new Map();
const syncing = new Set();
let ticking = false;
let timer = null;

export const isSyncing = accountId => syncing.has(accountId);
export const forgetDiscovery = accountId => homes.delete(accountId);

// The password goes to the origin of the account's server URL and nowhere else (caldavClient.js).
export async function credentialsFor(account) {
  const policy = await getConnectionPolicy();
  return bindCredentials(account.server_url, {
    username: account.username, password: decrypt(account.password), allowPrivate: policy.allowPrivateHosts,
  });
}

const gone = err => err.status === 404 || err.status === 410;

async function remoteCalendars(account, creds, discover) {
  const kept = homes.get(account.id);
  if (!discover && kept && kept.serverUrl === account.server_url && Date.now() - kept.at < REDISCOVER_MS) {
    try {
      const listed = await listCalendars(kept.home, creds);
      if (listed.calendars.length || listed.elsewhere.length) return listed;
    } catch (err) {
      if (!gone(err)) throw err;
    }
  }
  homes.delete(account.id);
  const { home, hint } = await discoverHome(account.server_url, creds);
  const listed = await listCalendars(home, creds);
  requireCalendars(listed, creds, hint);
  homes.set(account.id, { serverUrl: account.server_url, home: listed.home, at: Date.now() });
  return listed;
}

// Events the user removed from a calendar, by when. A sync that began before the removal may have
// listed or fetched the event already, and must not write it back: its row is gone, so the
// updated_at guard has nothing to compare with.
const TOMBSTONE_MS = 60 * 60 * 1000;
const removed = new Map();
const tombstoneKey = (calendarId, href) => `${calendarId} ${hrefKey(href)}`;
export function noteRemoved(calendarId, href) {
  const now = Date.now();
  for (const [key, at] of removed) if (now - at > TOMBSTONE_MS) removed.delete(key);
  removed.set(tombstoneKey(calendarId, href), now);
}
const removedSince = (calendarId, href, startedAt) => (removed.get(tombstoneKey(calendarId, href)) ?? -Infinity) >= new Date(startedAt).getTime();

// Nothing is written into a calendar ignored meanwhile: ignoring it deletes its events, and the
// share lock makes this insert either finish before that or see the calendar as ignored.
async function upsertEvent(calendar, ev, href, startedAt) {
  const info = resourceInfo(ev.ical);
  if (!info) return false;
  if (removedSince(calendar.id, href, startedAt)) return false;
  await query(
    `INSERT INTO calendar_events (calendar_id, user_id, href, etag, uid, ical, range_start, range_end)
     SELECT $1,$2,$3,$4,$5,$6,$7,$8 FROM calendars WHERE id = $1 AND NOT ignored FOR SHARE
     ON CONFLICT (calendar_id, href) DO UPDATE SET
       etag = EXCLUDED.etag, uid = EXCLUDED.uid, ical = EXCLUDED.ical,
       range_start = EXCLUDED.range_start, range_end = EXCLUDED.range_end, updated_at = NOW()
     WHERE calendar_events.updated_at < $9`,
    [calendar.id, calendar.user_id, href, ev.etag, info.uid, ev.ical, info.rangeStart, info.rangeEnd, startedAt],
  );
  return true;
}

async function syncCalendar(calendar, remote, creds, startedAt) {
  const local = await query('SELECT href, etag FROM calendar_events WHERE calendar_id = $1', [calendar.id]);
  const known = new Map(local.rows.map(r => [hrefKey(r.href), r.etag]));
  // A row keeps the spelling of its href, so another spelling from the server updates it.
  const spelled = new Map(local.rows.map(r => [hrefKey(r.href), r.href]));
  const listing = await listEvents(calendar.url, creds);
  const seen = new Set(listing.map(e => hrefKey(e.url)));
  const stale = local.rows.map(r => r.href).filter(href => !seen.has(hrefKey(href)));
  if (stale.length) {
    await query(
      'DELETE FROM calendar_events WHERE calendar_id = $1 AND href = ANY($2::text[]) AND updated_at < $3',
      [calendar.id, stale, startedAt],
    );
  }
  const changed = listing.filter(e => !e.etag || known.get(hrefKey(e.url)) !== e.etag);
  const pause = eventLoopYielder();
  let unreadable = 0;
  for (const ev of await fetchEvents(calendar.url, changed, creds)) {
    await pause();
    if (ev.error) {
      unreadable++;
      console.warn(`Calendar: skipped an event: ${ev.error}`);
      continue;
    }
    if (!ev.ical) continue;
    try {
      await upsertEvent(calendar, ev, spelled.get(hrefKey(ev.url)) || ev.url, startedAt);
    } catch (err) {
      if (err.code) throw err; // database error, not a bad event
      unreadable++;
      console.warn(`Calendar: skipped an unreadable event at ${ev.url}: ${err.message}`);
    }
  }
  if (unreadable) throw new Error(`${unreadable} event(s) in "${remote.name}" could not be read`);
  await query('UPDATE calendars SET ctag = $2 WHERE id = $1 AND NOT ignored', [calendar.id, remote.ctag]);
}

// Calendars the server no longer lists. A listing reached by another route (a new home, another
// spelling of its URL) leaves out calendars that still exist, and deleting a row loses the name,
// color and visibility the user gave it. So a row goes only when its own URL answers that it is gone.
async function dropGoneCalendars(account, existing, listedKeys, creds, errors) {
  const goneIds = [];
  for (const row of existing) {
    if (listedKeys.has(hrefKey(row.url))) continue;
    let answer;
    try {
      answer = await calendarGone(row.url, creds);
    } catch (err) {
      if (err.status === 401) throw err;
      answer = err;
    }
    if (answer === true) goneIds.push(row.id);
    else errors.push(`${row.display_name || row.name}: no longer listed by the server, but ${row.url} did not answer that it is gone${answer instanceof Error ? ` (${answer.message})` : ''}; it is kept`);
  }
  if (goneIds.length) await query('DELETE FROM calendars WHERE account_id = $1 AND id = ANY($2::uuid[])', [account.id, goneIds]);
}

// `discover` finds the calendar home again rather than listing the one kept from last time.
export async function syncAccount(accountId, { discover = false } = {}) {
  if (syncing.has(accountId)) return { ok: false, error: 'A sync is already in progress', busy: true };
  syncing.add(accountId);
  try {
    const r = await query('SELECT * FROM caldav_accounts WHERE id = $1', [accountId]);
    const account = r.rows[0];
    if (!account) return { ok: false, error: 'Account not found' };
    const startedAt = (await query('SELECT NOW() AS now')).rows[0].now;
    const errors = [];
    try {
      const creds = await credentialsFor(account);
      const listed = await remoteCalendars(account, creds, discover);
      const remotes = requireCalendars(listed, creds);
      for (const other of listed.elsewhere) {
        errors.push(`${other.name}: it is at ${other.url}, on another server, which this account's password is not sent to; add it as its own account`);
      }
      const existing = (await query('SELECT id, url, name, display_name FROM calendars WHERE account_id = $1', [account.id])).rows;
      const spelledAs = new Map(existing.map(row => [hrefKey(row.url), row.url]));
      for (const remote of remotes) {
        // A row keeps the spelling of its URL, so the same calendar spelled another way updates it.
        const url = spelledAs.get(hrefKey(remote.url)) || remote.url;
        const saved = await query(
          `INSERT INTO calendars (account_id, user_id, url, name, server_color, read_only)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (account_id, url) DO UPDATE SET
             name = EXCLUDED.name, server_color = EXCLUDED.server_color, read_only = EXCLUDED.read_only
           RETURNING *`,
          [account.id, account.user_id, url, remote.name, remote.color, remote.readOnly],
        );
        const calendar = saved.rows[0];
        if (calendar.ignored) continue;
        if (remote.ctag && calendar.ctag === remote.ctag) continue;
        try {
          await syncCalendar(calendar, remote, creds, startedAt);
        } catch (err) {
          if (err.status === 401) throw err;
          if (gone(err)) forgetDiscovery(account.id);
          errors.push(`${remote.name}: ${err.message}`);
        }
      }
      await dropGoneCalendars(account, existing, new Set(remotes.map(c => hrefKey(c.url))), creds, errors);
    } catch (err) {
      errors.push(err.message);
    }
    const error = errors.join('; ') || null;
    await query('UPDATE caldav_accounts SET last_sync_at = NOW(), last_error = $2 WHERE id = $1', [account.id, error]);
    if (error) console.warn(`Calendar: sync of account ${account.id} failed: ${error}`);
    return error ? { ok: false, error } : { ok: true };
  } finally {
    syncing.delete(accountId);
  }
}

export async function syncDueAccounts() {
  if (ticking) return;
  ticking = true;
  try {
    const due = await query(
      `SELECT id FROM caldav_accounts
       WHERE last_sync_at IS NULL OR last_sync_at < NOW() - make_interval(mins => interval_min)
       ORDER BY last_sync_at NULLS FIRST`,
    );
    const queue = due.rows.map(row => row.id);
    const worker = async () => {
      while (queue.length) {
        const id = queue.shift();
        await syncAccount(id).catch(err => console.warn(`Calendar: sync of account ${id} failed: ${err.message}`));
      }
    };
    await Promise.all(Array.from({ length: Math.min(SYNC_CONCURRENCY, queue.length) }, worker));
  } catch (err) {
    console.warn('Calendar: scheduler tick failed:', err.message);
  } finally {
    ticking = false;
  }
}

export function startCaldavScheduler() {
  if (timer) return;
  timer = setInterval(syncDueAccounts, TICK_MS);
  timer.unref?.();
}
