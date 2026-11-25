import { query } from './db.js';
import { itipObjects, resourceInfo } from './icalEvents.js';

// Invitations received by mail (iMIP): recording where sync found one, and reading the object
// from IMAP when the pending list needs it. Like a reaction, an invitation is only a reading of a
// message that stays where it is: nothing here moves, flags or deletes mail.

// Called by sync after a message row is written, and when a body is opened. Only fills a row
// that has none, so an object already read is never reset by the next sync of the same uid.
export async function recordInviteParts(accountId, folder, uid, parts) {
  if (!parts?.length) return;
  await query(
    `INSERT INTO mail_invites (message_id, account_id, parts)
     SELECT id, account_id, $4::jsonb FROM messages WHERE account_id = $1 AND folder = $2 AND uid = $3
     ON CONFLICT (message_id) DO NOTHING`,
    [accountId, folder, uid, JSON.stringify(parts)],
  );
}

const validParts = parts => Array.isArray(parts)
  && parts.length > 0
  && parts.length <= 2
  && parts.every(p => p && typeof p.part === 'string' && /^\d+(\.\d+)*$/.test(p.part));

function decodeText(buffer, charset) {
  try {
    return new TextDecoder(charset || 'utf-8').decode(buffer);
  } catch {
    return new TextDecoder('utf-8').decode(buffer);
  }
}

// What a stored object is: the columns the pending list filters on, or null when the text holds
// no event. METHOD comes from the object, else from the part's Content-Type parameter.
export function describeInvite(ical, partMethod = null) {
  if (!/BEGIN:VCALENDAR/i.test(ical || '')) return null;
  try {
    const { method, events } = itipObjects(ical);
    const first = events.find(e => e.uid);
    if (!first) return null;
    const info = resourceInfo(ical);
    return {
      method: method || partMethod || null,
      uid: first.uid,
      sequence: Math.max(...events.map(e => e.sequence)),
      rangeEnd: info?.rangeEnd ?? null,
    };
  } catch {
    return null;
  }
}

async function fetchIcs(row, account, engine) {
  const parts = row.parts;
  if (!validParts(parts)) return '';
  const buffers = await engine.fetchMultipleAttachments(account, row.uid, row.folder,
    parts.map(p => ({ part: p.part, encoding: p.encoding })));
  // Nothing came back: the message may be gone or the server failing. Unknown, not invalid.
  if (!buffers?.size) return undefined;
  for (const p of parts) {
    const buf = buffers.get(p.part);
    if (!buf) continue;
    const text = decodeText(buf, p.charset).replace(/\0/g, '');
    const info = describeInvite(text, p.method);
    if (info) return { text, info };
  }
  return '';
}

// A fetch that failed is not tried again for this long, so the list polled by a tab left open
// does not open an IMAP connection each time.
const RETRY_AFTER_MS = 10 * 60 * 1000;
const failedAt = new Map();
const inFlight = new Map();

async function readOne(row, account, engine, now) {
  if (!account) return;
  if (now - (failedAt.get(row.message_id) || 0) < RETRY_AFTER_MS) return;
  if (inFlight.has(row.message_id)) { await inFlight.get(row.message_id); return; }
  const work = (async () => {
    try {
      const got = await fetchIcs(row, account, engine);
      if (got === undefined) { failedAt.set(row.message_id, Date.now()); return; }
      failedAt.delete(row.message_id);
      await query(
        `UPDATE mail_invites SET ical = $2, method = $3, uid = $4, sequence = $5, range_end = $6, read_at = NOW()
          WHERE message_id = $1 AND ical IS NULL`,
        got ? [row.message_id, got.text, got.info.method, got.info.uid, got.info.sequence, got.info.rangeEnd]
          : [row.message_id, '', null, null, null, null],
      );
    } catch (err) {
      failedAt.set(row.message_id, Date.now());
      console.warn(`Invitation part fetch failed for message ${row.message_id}: ${err.message}`);
    } finally {
      inFlight.delete(row.message_id);
    }
  })();
  inFlight.set(row.message_id, work);
  await work;
}

// Invitations older than this are not read: a meeting mailed half a year ago is over, or was
// answered long since.
export const INVITE_LOOKBACK_DAYS = 120;

// Reads the objects of the user's newest unread invitation rows, at most `max` per call and for
// at most `timeoutMs`: what is not read by then is read on a later call.
export async function readPendingObjects(userId, { engine, timeoutMs = 6000, max = 15, now = Date.now() } = {}) {
  if (!engine) return;
  const { rows } = await query(
    `SELECT i.message_id, i.parts, m.uid, m.folder, m.account_id
       FROM mail_invites i
       JOIN messages m ON m.id = i.message_id
       JOIN email_accounts a ON a.id = m.account_id
      WHERE a.user_id = $1 AND a.enabled AND i.ical IS NULL AND m.is_deleted = false
        AND m.date > NOW() - make_interval(days => $2)
      ORDER BY m.date DESC
      LIMIT $3`,
    [userId, INVITE_LOOKBACK_DAYS, max],
  );
  if (!rows.length) return;
  const accountIds = [...new Set(rows.map(r => r.account_id))];
  const { rows: accounts } = await query('SELECT * FROM email_accounts WHERE id = ANY($1::uuid[])', [accountIds]);
  const byId = new Map(accounts.map(a => [a.id, a]));
  const work = (async () => {
    for (const row of rows) await readOne(row, byId.get(row.account_id), engine, now);
  })();
  let timer;
  await Promise.race([work, new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); })])
    .finally(() => clearTimeout(timer));
}

// The user's read invitation objects that may still matter: not deleted, recent, not over.
export async function invitationMail(userId) {
  const { rows } = await query(
    `SELECT i.message_id, i.ical, i.method, i.uid, i.sequence, m.account_id, m.folder, m.date, m.subject,
            a.email_address AS account_email, a.name AS account_name, f.special_use
       FROM mail_invites i
       JOIN messages m ON m.id = i.message_id
       JOIN email_accounts a ON a.id = m.account_id
       LEFT JOIN folders f ON f.account_id = m.account_id AND f.path = m.folder
      WHERE a.user_id = $1 AND a.enabled AND m.is_deleted = false AND i.ical <> '' AND i.uid IS NOT NULL
        AND m.date > NOW() - make_interval(days => $2)
        AND (i.range_end IS NULL OR i.range_end > NOW())`,
    [userId, INVITE_LOOKBACK_DAYS],
  );
  return rows;
}

export function _resetInviteState() {
  failedAt.clear();
  inFlight.clear();
}
