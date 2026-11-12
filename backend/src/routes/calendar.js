// CalDAV calendars: the accounts, their calendars, and events expanded for display. Edits go to the
// remote server first, guarded by the stored etag, and reach the local row only once it accepted them.

import crypto from 'node:crypto';
import { Router } from 'express';
import { query } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import { decrypt, encrypt } from '../services/encryption.js';
import { findOwnedAccount } from '../services/ownership.js';
import { validateHost } from '../services/hostValidation.js';
import { getConnectionPolicy } from '../services/connectionPolicy.js';
import { discoverCalendars, findCalDavServer, getEvent, putEvent, deleteEvent, moveEvent } from '../services/caldavClient.js';
import { syncAccount, credentialsFor, isSyncing, forgetDiscovery, noteRemoved } from '../services/caldavSync.js';
import { applyEdit, buildEvent, eventLoopYielder, expandResourceAsync, inviteInfo, removeOccurrence, resourceInfo, seriesMarkers, setReply } from '../services/icalEvents.js';
import { forgetScheduling, knownAddresses, mailItip, mailLabels, planInvites } from '../services/calendarInvites.js';

const router = Router();
router.use(requireAuth);

const MAX_WINDOW_MS = 400 * 86400000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const RID_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}Z?)?$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const FREQS = ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'];
const EMAIL_RE = /^[^\s@<>",;:]+@[^\s@<>",;:]+\.[^\s@<>",;:]+$/;
const MAX_ATTENDEES = 200;
const MAX_NAME = 200;
const PARTSTATS = ['ACCEPTED', 'DECLINED', 'TENTATIVE'];
const clampInterval = v => Math.max(5, Math.min(1440, parseInt(v) || 15));
const badRequest = (res, error) => res.status(400).json({ error });

for (const param of ['id', 'eventId']) {
  router.param(param, (req, res, next, value) => (UUID_RE.test(value) ? next() : res.status(404).json({ error: 'Not found' })));
}

const ACCOUNT_SELECT = `
  SELECT a.*,
    (SELECT COUNT(*)::int FROM calendars c WHERE c.account_id = a.id) AS calendar_count,
    (SELECT COUNT(*)::int FROM calendar_events e JOIN calendars c ON c.id = e.calendar_id WHERE c.account_id = a.id) AS event_count
  FROM caldav_accounts a`;

function publicAccount(a) {
  return {
    id: a.id, name: a.name, serverUrl: a.server_url, username: a.username, intervalMin: a.interval_min,
    lastSyncAt: a.last_sync_at, lastError: a.last_error,
    calendarCount: a.calendar_count ?? 0, eventCount: a.event_count ?? 0,
  };
}

async function loadAccount(userId, id) {
  const r = await query(`${ACCOUNT_SELECT} WHERE a.id = $1 AND a.user_id = $2`, [id, userId]);
  return r.rows[0] || null;
}

const FALLBACK_COLOR = '#6366f1';
function publicCalendar(c) {
  return {
    id: c.id, accountId: c.account_id, accountName: c.account_name, name: c.display_name || c.name,
    serverName: c.name, displayName: c.display_name || null, ignored: Boolean(c.ignored),
    color: c.color || c.server_color || FALLBACK_COLOR, visible: c.visible, readOnly: c.read_only,
  };
}

// Plaintext HTTP only for a genuinely private address the admin has allowed. Checked here for a clear
// message; caldavClient enforces it again on every connection, redirects included.
async function serverUrlError(serverUrl, policy) {
  let parsed;
  try { parsed = new URL(serverUrl); } catch { return 'Invalid server URL'; }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return 'Server URL must be http(s).';
  if (parsed.protocol === 'http:') {
    if (!policy.allowPrivateHosts) return 'Server URL must use HTTPS.';
    if (!(await validateHost(parsed.hostname, { allowPrivate: false }))) {
      return 'HTTPS is required for a public host; plaintext HTTP is only allowed for a private/local address.';
    }
  }
  return validateHost(parsed.hostname, { allowPrivate: policy.allowPrivateHosts });
}

async function saveAccount(userId, { name, serverUrl, username, password, intervalMin }) {
  const r = await query(
    `INSERT INTO caldav_accounts (user_id, name, server_url, username, password, interval_min)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (user_id, server_url, username) DO UPDATE SET password = EXCLUDED.password, name = EXCLUDED.name, last_error = NULL
     RETURNING *`,
    [userId, name, serverUrl, username, encrypt(password), clampInterval(intervalMin)],
  );
  syncAccount(r.rows[0].id).catch(err => console.warn(`Calendar: first sync failed: ${err.message}`));
  return publicAccount(r.rows[0]);
}

router.get('/accounts', async (req, res) => {
  const r = await query(`${ACCOUNT_SELECT} WHERE a.user_id = $1 ORDER BY a.created_at`, [req.session.userId]);
  res.json(r.rows.map(publicAccount));
});

router.post('/accounts', async (req, res) => {
  const { name, serverUrl, username, password, intervalMin } = req.body || {};
  if (![serverUrl, username, password].every(v => typeof v === 'string' && v)) {
    return badRequest(res, 'Server URL, username, and password are required');
  }
  if (name != null && typeof name !== 'string') return badRequest(res, 'Invalid name');
  const policy = await getConnectionPolicy();
  const urlErr = await serverUrlError(serverUrl, policy);
  if (urlErr) return badRequest(res, urlErr);
  try {
    await discoverCalendars({ serverUrl, username, password, allowPrivate: policy.allowPrivateHosts });
  } catch (err) {
    return badRequest(res, err.message);
  }
  const label = name?.trim().slice(0, 100) || new URL(serverUrl).hostname;
  res.json(await saveAccount(req.session.userId, { name: label, serverUrl, username, password, intervalMin }));
});

// Mail accounts whose password may also open a calendar on the same server.
router.get('/mail-accounts', async (req, res) => {
  const r = await query(
    `SELECT m.id, m.email_address, m.imap_host,
       EXISTS (SELECT 1 FROM caldav_accounts c
               WHERE c.user_id = m.user_id AND c.username = m.auth_user AND c.server_url IN ('https://' || m.imap_host || '/', 'https://' || m.smtp_host || '/')) AS connected
     FROM email_accounts m
     WHERE m.user_id = $1 AND m.enabled AND m.protocol = 'imap' AND m.auth_pass IS NOT NULL AND m.oauth_provider IS NULL
     ORDER BY m.sort_order, m.email_address`,
    [req.session.userId],
  );
  res.json(r.rows.map(m => ({ id: m.id, email: m.email_address, host: m.imap_host, connected: m.connected })));
});

router.post('/accounts/from-mail', async (req, res) => {
  const { accountId } = req.body || {};
  if (!UUID_RE.test(accountId || '')) return res.status(404).json({ error: 'Not found' });
  const mail = await findOwnedAccount(req.session.userId, accountId, {
    columns: 'email_address, imap_host, smtp_host, auth_user, auth_pass, oauth_provider',
  });
  if (!mail) return res.status(404).json({ error: 'Not found' });
  if (mail.oauth_provider || !mail.auth_pass) return badRequest(res, 'This mail account has no password to connect with');
  const username = mail.auth_user;
  const password = decrypt(mail.auth_pass);
  const policy = await getConnectionPolicy();
  let found;
  try {
    found = await findCalDavServer([mail.imap_host, mail.smtp_host], { username, password, allowPrivate: policy.allowPrivateHosts });
  } catch (err) {
    return res.status(400).json({ error: err.message, code: 'no_caldav' });
  }
  res.json(await saveAccount(req.session.userId, { name: mail.email_address, serverUrl: found.serverUrl, username, password }));
});

router.patch('/accounts/:id', async (req, res) => {
  const { name, intervalMin, password } = req.body || {};
  const r = await query(
    `UPDATE caldav_accounts SET
       name = COALESCE($3, name), interval_min = COALESCE($4, interval_min), password = COALESCE($5, password)
     WHERE id = $1 AND user_id = $2 RETURNING id`,
    [req.params.id, req.session.userId,
      typeof name === 'string' && name.trim() ? name.trim().slice(0, 100) : null,
      intervalMin != null ? clampInterval(intervalMin) : null,
      typeof password === 'string' && password ? encrypt(password) : null],
  );
  if (!r.rowCount) return res.status(404).json({ error: 'Not found' });
  res.json(publicAccount(await loadAccount(req.session.userId, req.params.id)));
});

router.post('/accounts/:id/sync', async (req, res) => {
  forgetScheduling(req.params.id);
  const account = await loadAccount(req.session.userId, req.params.id);
  if (!account) return res.status(404).json({ error: 'Not found' });
  if (isSyncing(account.id)) return res.status(409).json({ error: 'A sync is already in progress' });
  const result = await syncAccount(account.id, { discover: true });
  res.json({ ok: result.ok, error: result.error, account: publicAccount(await loadAccount(req.session.userId, account.id)) });
});

router.delete('/accounts/:id', async (req, res) => {
  const r = await query('DELETE FROM caldav_accounts WHERE id = $1 AND user_id = $2', [req.params.id, req.session.userId]);
  if (!r.rowCount) return res.status(404).json({ error: 'Not found' });
  forgetScheduling(req.params.id);
  forgetDiscovery(req.params.id);
  res.json({ ok: true });
});

const CALENDAR_SELECT = `
  SELECT c.*, a.name AS account_name FROM calendars c JOIN caldav_accounts a ON a.id = c.account_id`;

// Ignored calendars are left out unless asked for, as only the account settings list them.
router.get('/calendars', async (req, res) => {
  const all = req.query.all === '1';
  const r = await query(
    `${CALENDAR_SELECT} WHERE c.user_id = $1 ${all ? '' : 'AND NOT c.ignored'} ORDER BY a.created_at, COALESCE(c.display_name, c.name)`,
    [req.session.userId],
  );
  res.json(r.rows.map(publicCalendar));
});

router.patch('/calendars/:id', async (req, res) => {
  const { visible, color, displayName, ignored } = req.body || {};
  if (color !== undefined && !COLOR_RE.test(color)) return badRequest(res, 'Invalid color');
  if (displayName !== undefined && displayName !== null && (typeof displayName !== 'string' || displayName.length > MAX_NAME)) {
    return badRequest(res, 'Invalid name');
  }
  if (ignored !== undefined && typeof ignored !== 'boolean') return badRequest(res, 'Invalid value');
  const name = typeof displayName === 'string' ? displayName.replace(/[\r\n]+/g, ' ').trim() : displayName;
  const before = await query('SELECT ignored FROM calendars WHERE id = $1 AND user_id = $2', [req.params.id, req.session.userId]);
  if (!before.rowCount) return res.status(404).json({ error: 'Not found' });
  const r = await query(
    `UPDATE calendars SET visible = COALESCE($3, visible), color = COALESCE($4, color),
       display_name = CASE WHEN $5 THEN NULLIF($6, '') ELSE display_name END,
       ignored = COALESCE($7, ignored),
       ctag = CASE WHEN $7 IS NOT NULL AND $7 <> ignored THEN NULL ELSE ctag END
     WHERE id = $1 AND user_id = $2 RETURNING account_id`,
    [req.params.id, req.session.userId, typeof visible === 'boolean' ? visible : null, color ?? null,
      displayName !== undefined, name ?? null, ignored ?? null],
  );
  if (!r.rowCount) return res.status(404).json({ error: 'Not found' });
  const wasIgnored = before.rows[0].ignored;
  // Ignoring drops the calendar's events; taking it back fetches them again.
  if (ignored === true && !wasIgnored) await query('DELETE FROM calendar_events WHERE calendar_id = $1', [req.params.id]);
  if (ignored === false && wasIgnored) {
    const accountId = r.rows[0].account_id;
    syncAccount(accountId).catch(err => console.warn(`Calendar: sync of account ${accountId} failed: ${err.message}`));
  }
  const c = await query(`${CALENDAR_SELECT} WHERE c.id = $1`, [req.params.id]);
  res.json(publicCalendar(c.rows[0]));
});

// Whether the user organizes an event, and their own answer when someone else does.
function roleOf(occ, mine) {
  const organizer = occ.organizer?.email?.toLowerCase() || null;
  const organizerIsMe = Boolean(organizer && mine.has(organizer));
  const me = organizerIsMe ? null : (occ.attendees || []).find(a => a.email && mine.has(a.email.toLowerCase()));
  return { organizerIsMe, myStatus: me ? (me.status || 'NEEDS-ACTION') : null };
}

router.get('/events', async (req, res) => {
  const fromMs = Date.parse(req.query.from);
  const toMs = Date.parse(req.query.to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return badRequest(res, 'Invalid date range');
  if (toMs - fromMs > MAX_WINDOW_MS) return badRequest(res, 'Date range too large');
  const floatingTz = typeof req.query.tz === 'string' && req.query.tz.length < 100 ? req.query.tz : null;
  const r = await query(
    `SELECT e.id, e.calendar_id, e.ical, c.read_only
     FROM calendar_events e JOIN calendars c ON c.id = e.calendar_id
     WHERE e.user_id = $1 AND c.visible AND NOT c.ignored AND e.range_start < $3 AND (e.range_end IS NULL OR e.range_end > $2)`,
    [req.session.userId, new Date(fromMs), new Date(toMs)],
  );
  const mine = new Set(await knownAddresses(req.session.userId));
  const events = [];
  // This process also runs the mail engine: a large calendar or a long series must not hold it up.
  const pause = eventLoopYielder();
  for (const row of r.rows) {
    await pause();
    try {
      for (const occ of await expandResourceAsync(row.ical, fromMs, toMs, { floatingTz }, pause)) {
        events.push({
          ...occ, id: `${row.id}:${occ.recurrenceId || ''}`, eventId: row.id,
          calendarId: row.calendar_id, readOnly: row.read_only, ...roleOf(occ, mine),
        });
      }
    } catch (err) {
      console.warn(`Calendar: could not expand event ${row.id}: ${err.message}`);
    }
  }
  res.json({ events });
});

function dateValueError(input) {
  const { allDay, start, end } = input;
  if (allDay) {
    if (!DATE_RE.test(start) || !DATE_RE.test(end) || !Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end))) return 'Invalid dates';
    if (end <= start) return 'The end must be after the start';
  } else {
    const s = Date.parse(start);
    const e = Date.parse(end);
    if (!Number.isFinite(s) || !Number.isFinite(e)) return 'Invalid dates';
    if (e < s) return 'The end must be after the start';
  }
  return null;
}

function eventInput(body, { requireDates }) {
  const b = body || {};
  const input = {};
  if (b.summary !== undefined) {
    if (typeof b.summary !== 'string' || b.summary.length > 1000) return { error: 'Invalid title' };
    input.summary = b.summary.trim();
  }
  for (const key of ['location', 'description']) {
    if (b[key] === undefined) continue;
    if (b[key] !== null && (typeof b[key] !== 'string' || b[key].length > 100000)) return { error: `Invalid ${key}` };
    input[key] = b[key];
  }
  if (b.start !== undefined || b.end !== undefined || requireDates) {
    input.allDay = b.allDay === true;
    input.start = b.start;
    input.end = b.end;
    if (typeof b.start !== 'string' || typeof b.end !== 'string') return { error: 'Invalid dates' };
    const err = dateValueError(input);
    if (err) return { error: err };
  }
  if (typeof b.timezone === 'string' && b.timezone.length < 100) input.timezone = b.timezone;
  if (b.recurrence !== undefined) {
    if (b.recurrence === null) input.recurrence = null;
    else {
      const { freq, interval, until, count } = b.recurrence;
      if (!FREQS.includes(freq)) return { error: 'Invalid recurrence' };
      if (until != null && !DATE_RE.test(until)) return { error: 'Invalid recurrence' };
      if (count != null && (!Number.isInteger(count) || count < 1 || count > 10000)) return { error: 'Invalid recurrence' };
      if (interval != null && (!Number.isInteger(interval) || interval < 1 || interval > 1000)) return { error: 'Invalid recurrence' };
      input.recurrence = { freq, interval: interval || 1, until: until || null, count: count || null };
    }
  }
  if (b.attendees !== undefined) {
    if (!Array.isArray(b.attendees) || b.attendees.length > MAX_ATTENDEES) return { error: 'Invalid attendees' };
    const seen = new Set();
    input.attendees = [];
    for (const a of b.attendees) {
      const email = typeof a?.email === 'string' ? a.email.trim().toLowerCase() : '';
      if (!EMAIL_RE.test(email) || email.length > 320) return { error: 'Invalid attendee address', code: 'bad_attendee' };
      if (a.name != null && (typeof a.name !== 'string' || a.name.length > 200)) return { error: 'Invalid attendees' };
      if (seen.has(email)) continue;
      seen.add(email);
      input.attendees.push({ email, name: a.name?.trim().replace(/[\r\n]/g, ' ') || null });
    }
  }
  if (b.reminderMinutes !== undefined) {
    if (b.reminderMinutes !== null && (!Number.isInteger(b.reminderMinutes) || b.reminderMinutes < 0 || b.reminderMinutes > 100000)) {
      return { error: 'Invalid reminder' };
    }
    input.reminderMinutes = b.reminderMinutes;
  }
  return { input };
}

async function loadCalendar(userId, calendarId) {
  if (!UUID_RE.test(calendarId || '')) return null;
  const r = await query(
    `SELECT c.*, a.server_url, a.username, a.password
     FROM calendars c JOIN caldav_accounts a ON a.id = c.account_id
     WHERE c.id = $1 AND c.user_id = $2 AND NOT c.ignored`,
    [calendarId, userId],
  );
  return r.rows[0] || null;
}

async function loadEvent(userId, eventId) {
  const r = await query(
    `SELECT e.*, c.read_only, c.account_id, c.url AS calendar_url, a.server_url, a.username, a.password
     FROM calendar_events e
     JOIN calendars c ON c.id = e.calendar_id
     JOIN caldav_accounts a ON a.id = c.account_id
     WHERE e.id = $1 AND e.user_id = $2`,
    [eventId, userId],
  );
  return r.rows[0] || null;
}

// Stores what the server now holds, not what was sent: servers may rewrite the object. `sentEtag` is
// the one the server gave for what was sent, kept when the object cannot be read back.
async function storeFromServer(calendarId, userId, href, ical, creds, sentEtag = null) {
  let etag = sentEtag;
  let stored = ical;
  try {
    const read = await getEvent(href, creds);
    if (read) { etag = read.etag || (read.ical === ical ? sentEtag : null); stored = read.ical; }
  } catch (err) {
    console.warn(`Calendar: could not re-read ${href}: ${err.message}`);
  }
  const info = resourceInfo(stored);
  const r = await query(
    `INSERT INTO calendar_events (calendar_id, user_id, href, etag, uid, ical, range_start, range_end)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (calendar_id, href) DO UPDATE SET
       etag = EXCLUDED.etag, uid = EXCLUDED.uid, ical = EXCLUDED.ical,
       range_start = EXCLUDED.range_start, range_end = EXCLUDED.range_end, updated_at = NOW()
     RETURNING id`,
    [calendarId, userId, href, etag, info.uid, stored, info.rangeStart, info.rangeEnd],
  );
  return r.rows[0].id;
}

const sameObject = (a, b) => a.replace(/\r\n/g, '\n').trim() === b.replace(/\r\n/g, '\n').trim();

// The version an edit is made against. A row stored without one, as when reading it back failed, is
// read again, and the version is used only if the server still holds what the row holds: anything
// else could be a change made elsewhere, so it is a conflict, which syncs the server's version in.
async function versionOf(event, creds) {
  if (event.etag) return event.etag;
  const current = await getEvent(event.href, creds);
  if (!current) throw Object.assign(new Error('Event not found on the server'), { notFound: true });
  if (!current.etag || !sameObject(current.ical, event.ical)) throw Object.assign(new Error('Event changed on the server'), { conflict: true });
  await query('UPDATE calendar_events SET etag = $2 WHERE id = $1 AND etag IS NULL', [event.id, current.etag]);
  return current.etag;
}

// A row the user removed: a sync that listed the event before the removal must not bring it back.
async function dropLocal(event) {
  noteRemoved(event.calendar_id, event.href);
  await query('DELETE FROM calendar_events WHERE id = $1', [event.id]);
}

// One MOVE on the server, so the event is never in both calendars or in neither, then the edit at
// its new place. A server that will not move between these calendars gets a copy, then a deletion
// of the original guarded by its version, which at worst leaves both.
async function moveToCalendar(event, target, ical, creds, etag) {
  const base = target.url.endsWith('/') ? target.url : `${target.url}/`;
  let moved;
  try {
    const name = new URL(event.href).pathname.split('/').filter(Boolean).pop();
    moved = (await moveEvent(event.href, new URL(name, base).href, creds, { etag })).url;
  } catch (err) {
    if (!err.unsupported) throw err;
    const href = new URL(`${crypto.randomUUID()}.ics`, base).href;
    const { url, etag: sentEtag } = await putEvent(href, ical, creds, { create: true });
    await storeFromServer(target.id, target.user_id, url, ical, creds, sentEtag);
    await deleteEvent(event.href, creds, { etag });
    await dropLocal(event);
    return;
  }
  await dropLocal(event);
  let edited = false;
  try {
    const now = await getEvent(moved, creds);
    if (!now) throw Object.assign(new Error('Event not found on the server'), { notFound: true });
    await putKeepingMarkers(moved, ical, creds, now.etag);
    edited = true;
  } finally {
    await storeFromServer(target.id, target.user_id, moved, edited ? ical : event.ical, creds);
  }
}

const readOnlyError = res => res.status(403).json({ error: 'This calendar is read-only', code: 'read_only' });

// MDaemon, like Outlook, drops a series' exceptions and exclusions when its start changes, which
// brings deleted occurrences back. The series now has its new start, so sending it again keeps them.
export async function putKeepingMarkers(href, ical, creds, etag) {
  await putEvent(href, ical, creds, { etag });
  const sent = seriesMarkers(ical);
  if (!sent) return;
  const stored = await getEvent(href, creds);
  if (!stored || seriesMarkers(stored.ical) >= sent) return;
  await putEvent(href, ical, creds, { etag: stored.etag });
  const again = await getEvent(href, creds);
  if (again && seriesMarkers(again.ical) < sent) {
    console.warn(`Calendar: the server dropped exceptions of ${href} and would not take them back`);
  }
}

// A conflict waits for the server's newer version to sync, so the client's refetch shows it.
async function sendWriteError(res, err, accountId) {
  if (err.conflict) {
    await syncAccount(accountId).catch(e => console.warn(`Calendar: sync after a conflict failed: ${e.message}`));
    return res.status(409).json({ error: 'This event changed on the server', code: 'conflict' });
  }
  if (err.notFound) return res.status(404).json({ error: err.message });
  if (err.forbidden) return readOnlyError(res);
  if (err.code === 'no_organizer') return res.status(400).json({ error: err.message, code: 'no_sender' });
  console.warn(`Calendar: write failed: ${err.message}`);
  return res.status(502).json({ error: err.message });
}

function mailOptions(req) {
  const lang = typeof req.body?.lang === 'string' && /^[a-zA-Z-]{2,20}$/.test(req.body.lang) ? req.body.lang : 'en';
  const timeZone = typeof req.body?.timezone === 'string' && req.body.timezone.length < 100 ? req.body.timezone : 'UTC';
  return { labels: mailLabels(req.body?.mailLabels), lang, timeZone };
}

// Mails what a server that does not schedule leaves to the client. The event is saved by now, so a
// failure here is reported beside the success rather than as one.
async function mailAfterWrite(userId, plan, messages, opts) {
  if (plan?.mode !== 'mail' || !plan.organizer) return {};
  let sent = 0;
  try {
    for (const m of messages) {
      if (!m.to.length) continue;
      sent += (await mailItip({ userId, from: m.from || plan.organizer.email, ...m, ...opts })).sent;
    }
    return sent ? { invitesSent: sent } : {};
  } catch (err) {
    return { inviteError: err.message, ...(err.code ? { inviteErrorCode: err.code } : {}) };
  }
}

async function planFor(userId, row) {
  const accountId = row.account_id;
  const calendarUrl = row.calendar_url || row.url;
  const creds = await credentialsFor(row);
  return { creds, plan: await planInvites({ userId, accountId, calendarUrl, username: row.username, creds }) };
}

router.post('/events', async (req, res) => {
  const calendar = await loadCalendar(req.session.userId, req.body?.calendarId);
  if (!calendar) return res.status(404).json({ error: 'Calendar not found' });
  if (calendar.read_only) return readOnlyError(res);
  const { input, error } = eventInput(req.body, { requireDates: true });
  if (error) return badRequest(res, error);
  try {
    let creds;
    let plan = null;
    if (input.attendees?.length) {
      ({ creds, plan } = await planFor(req.session.userId, calendar));
      input.organizer = plan.organizer;
    } else {
      creds = await credentialsFor(calendar);
    }
    const { uid, ical } = buildEvent(input);
    const href = new URL(`${encodeURIComponent(uid)}.ics`, calendar.url.endsWith('/') ? calendar.url : `${calendar.url}/`).href;
    const { url, etag } = await putEvent(href, ical, creds, { create: true });
    const eventId = await storeFromServer(calendar.id, calendar.user_id, url, ical, creds, etag);
    const mailed = await mailAfterWrite(req.session.userId, plan, [
      { to: inviteInfo(ical).attendees, method: 'REQUEST', ics: ical, kind: 'invite' },
    ], mailOptions(req));
    res.json({ ok: true, eventId, ...mailed });
  } catch (err) {
    await sendWriteError(res, err, calendar.account_id);
  }
});

router.patch('/events/:eventId', async (req, res) => {
  const event = await loadEvent(req.session.userId, req.params.eventId);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  if (event.read_only) return readOnlyError(res);
  const { input, error } = eventInput(req.body, { requireDates: false });
  if (error) return badRequest(res, error);
  const scope = req.body.scope === 'this' ? 'this' : 'all';
  const { recurrenceId } = req.body;
  if (recurrenceId != null && !RID_RE.test(recurrenceId)) return badRequest(res, 'Invalid occurrence');
  if (scope === 'this' && (!recurrenceId || input.start === undefined)) return badRequest(res, 'Editing one occurrence needs its id and dates');

  const moveTo = req.body.calendarId && req.body.calendarId !== event.calendar_id ? req.body.calendarId : null;
  let target = null;
  if (moveTo) {
    if (scope === 'this') return badRequest(res, 'One occurrence cannot move to another calendar');
    target = await loadCalendar(req.session.userId, moveTo);
    if (!target) return res.status(404).json({ error: 'Calendar not found' });
    if (target.read_only) return readOnlyError(res);
    if (target.account_id !== event.account_id) {
      return badRequest(res, 'An event cannot move to a calendar on another account');
    }
  }

  try {
    const before = inviteInfo(event.ical);
    let creds;
    let plan = null;
    if (input.attendees !== undefined || before.attendees.length) {
      ({ creds, plan } = await planFor(req.session.userId, event));
      const mine = before.organizer && plan.myEmails.includes(before.organizer);
      if (before.organizer && !mine) {
        if (input.attendees !== undefined) return res.status(403).json({ error: 'Only the organizer can change who is invited', code: 'not_organizer' });
        plan = null;
      }
      if (before.organizer && mine) plan.organizer = { ...plan.organizer, email: before.organizer };
      input.organizer = plan?.organizer;
    } else {
      creds = await credentialsFor(event);
    }
    const ical = applyEdit(event.ical, input, { scope, recurrenceId });
    const etag = await versionOf(event, creds);
    if (target) {
      await moveToCalendar(event, target, ical, creds, etag);
    } else {
      await putKeepingMarkers(event.href, ical, creds, etag);
      await storeFromServer(event.calendar_id, event.user_id, event.href, ical, creds);
    }
    const after = inviteInfo(ical);
    const removed = before.attendees.filter(e => !after.attendees.includes(e));
    const onlyReminder = Object.keys(input).every(k => ['reminderMinutes', 'organizer', 'timezone'].includes(k));
    const mailed = await mailAfterWrite(req.session.userId, plan, [
      { to: removed, method: 'CANCEL', ics: event.ical, kind: 'cancel', only: removed },
      { to: onlyReminder ? [] : after.attendees, method: 'REQUEST', ics: ical, kind: before.attendees.length ? 'update' : 'invite' },
    ], mailOptions(req));
    res.json({ ok: true, ...mailed });
  } catch (err) {
    await sendWriteError(res, err, event.account_id);
  }
});

router.delete('/events/:eventId', async (req, res) => {
  const event = await loadEvent(req.session.userId, req.params.eventId);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  if (event.read_only) return readOnlyError(res);
  const { scope, recurrenceId } = req.query;
  if (scope === 'this' && (typeof recurrenceId !== 'string' || !RID_RE.test(recurrenceId))) return badRequest(res, 'Invalid occurrence');
  try {
    const before = inviteInfo(event.ical);
    let creds;
    let plan = null;
    if (before.attendees.length && before.organizer) {
      ({ creds, plan } = await planFor(req.session.userId, event));
      if (!plan.myEmails.includes(before.organizer)) plan = null;
      else plan.organizer = { ...plan.organizer, email: before.organizer };
    } else {
      creds = await credentialsFor(event);
    }
    const remaining = scope === 'this' ? removeOccurrence(event.ical, recurrenceId) : null;
    const etag = await versionOf(event, creds);
    if (remaining) {
      await putEvent(event.href, remaining, creds, { etag });
      await storeFromServer(event.calendar_id, event.user_id, event.href, remaining, creds);
    } else {
      await deleteEvent(event.href, creds, { etag });
      await dropLocal(event);
    }
    const mailed = await mailAfterWrite(req.session.userId, plan, [remaining
      ? { to: before.attendees, method: 'REQUEST', ics: remaining, kind: 'update' }
      : { to: before.attendees, method: 'CANCEL', ics: event.ical, kind: 'cancel' }], mailOptions(req));
    res.json({ ok: true, ...mailed });
  } catch (err) {
    await sendWriteError(res, err, event.account_id);
  }
});

// The user's answer to an invitation from someone else, for the whole series.
router.post('/events/:eventId/reply', async (req, res) => {
  const event = await loadEvent(req.session.userId, req.params.eventId);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  if (event.read_only) return readOnlyError(res);
  const partstat = req.body?.status;
  if (!PARTSTATS.includes(partstat)) return badRequest(res, 'Invalid answer');
  try {
    const { creds, plan } = await planFor(req.session.userId, event);
    const { organizer } = inviteInfo(event.ical);
    if (!organizer || plan.myEmails.includes(organizer)) return badRequest(res, 'This is not an invitation from someone else');
    const { ical, email } = setReply(event.ical, plan.myEmails, partstat);
    await putEvent(event.href, ical, creds, { etag: await versionOf(event, creds) });
    await storeFromServer(event.calendar_id, event.user_id, event.href, ical, creds);
    const mailed = await mailAfterWrite(req.session.userId, { ...plan, organizer: plan.organizer || { email } }, [
      { from: email, to: [organizer], method: 'REPLY', ics: ical, kind: partstat.toLowerCase(), only: [email] },
    ], mailOptions(req));
    res.json({ ok: true, ...mailed });
  } catch (err) {
    await sendWriteError(res, err, event.account_id);
  }
});

export default router;
