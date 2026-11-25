import { itipObjects, nextOccurrence } from './icalEvents.js';

// The invitations waiting for the user's answer, from the two places one arrives: a message
// (iMIP REQUEST) and a calendar the server put the event in (scheduling, PARTSTAT=NEEDS-ACTION).
// Pure: the rows are read by the caller. One meeting is one entry, keyed by UID and occurrence,
// whichever of the two holds it and however many copies of the message there are.

const HIDDEN_FOLDERS = new Set(['trash', 'junk', 'spam']);
const hiddenFolder = row => HIDDEN_FOLDERS.has(String(row.special_use || '').replaceAll('\\', '').toLowerCase());

export const inviteKey = (uid, recurrenceId) => `${uid}\n${recurrenceId || ''}`;

// The newer revision first (RFC 5546 2.1.5: SEQUENCE, then DTSTAMP). At the same revision a
// cancellation outranks the request, and a copy the user can see outranks one in the bin.
function newerMail(a, b) {
  return (b.ev.sequence - a.ev.sequence)
    || ((b.method === 'CANCEL') - (a.method === 'CANCEL'))
    || (b.ev.stamp - a.ev.stamp)
    || (hiddenFolder(a.row) - hiddenFolder(b.row))
    || (new Date(b.row.date || 0) - new Date(a.row.date || 0));
}

function newerCopy(a, b) {
  return (Boolean(a.row.read_only) - Boolean(b.row.read_only)) || (b.ev.sequence - a.ev.sequence);
}

function group(map, key) {
  if (!map.has(key)) map.set(key, { mail: [], calendar: [] });
  return map.get(key);
}

function parsed(ical, mine) {
  try { return itipObjects(ical, mine); } catch { return null; }
}

function occurrence(ical, recurrenceId, nowMs) {
  try { return nextOccurrence(ical, recurrenceId, nowMs); } catch { return null; }
}

// mail: mail_invites rows joined to their message. calendar: calendar_events rows with their
// calendar. replies: calendar_invite_replies rows. Returns every invitation still to come, with
// `status` the user's answer so far ('NEEDS-ACTION' when there is none).
export function invitations({ mail = [], calendar = [], replies = [], myEmails = [], nowMs = Date.now() }) {
  const mine = new Set(myEmails.map(e => e.toLowerCase()));
  const groups = new Map();
  for (const row of mail) {
    const obj = parsed(row.ical, myEmails);
    const method = obj?.method || String(row.method || '').toUpperCase();
    if (!obj || (method !== 'REQUEST' && method !== 'CANCEL')) continue;
    // A message with the series in it is about the series; one without is about its occurrences.
    const master = obj.events.find(e => e.uid && !e.recurrenceId);
    for (const ev of master ? [master] : obj.events.filter(e => e.uid)) {
      group(groups, inviteKey(ev.uid, ev.recurrenceId)).mail.push({ row, ev, method });
    }
  }
  for (const row of calendar) {
    const obj = parsed(row.ical, myEmails);
    if (!obj) continue;
    for (const ev of obj.events.filter(e => e.uid)) group(groups, inviteKey(ev.uid, ev.recurrenceId)).calendar.push({ row, ev });
  }
  const answers = new Map(replies.map(r => [inviteKey(r.uid, r.recurrence_id), r]));

  const out = [];
  for (const [key, { mail: mails, calendar: copies }] of groups) {
    mails.sort(newerMail);
    copies.sort(newerCopy);
    const latest = mails[0] || null;
    const copy = copies[0] || null;
    const cancelled = latest && (latest.method === 'CANCEL' || latest.ev.cancelled);
    if (cancelled && (!copy || latest.ev.sequence >= copy.ev.sequence)) continue;
    // The newest request the user can see. A newer revision in the bin is not shown at all.
    const request = latest && !cancelled && !hiddenFolder(latest.row) ? latest : null;
    const fromMail = Boolean(request && (!copy || request.ev.sequence > copy.ev.sequence));
    const source = fromMail ? request : copy;
    if (!source) continue;
    const { ev } = source;
    if (ev.cancelled || !ev.me || !ev.organizer?.email || mine.has(ev.organizer.email)) continue;
    if (!fromMail && source.row.read_only) continue;

    let status = ev.me.status;
    let answeredAt = null;
    if (fromMail) {
      const answer = answers.get(key);
      const current = answer && answer.sequence >= ev.sequence;
      status = current ? answer.partstat : 'NEEDS-ACTION';
      answeredAt = current ? answer.answered_at : null;
    }
    const occ = occurrence(source.row.ical, ev.recurrenceId, nowMs);
    if (!occ) continue;
    const message = request || mails.find(m => m.method === 'REQUEST' && !hiddenFolder(m.row)) || null;
    out.push({
      key,
      uid: ev.uid,
      recurrenceId: ev.recurrenceId,
      sequence: ev.sequence,
      source: fromMail ? 'mail' : 'calendar',
      status,
      answeredAt,
      summary: occ.summary,
      location: occ.location,
      description: occ.description,
      allDay: occ.allDay,
      start: occ.start,
      end: occ.end,
      timezone: occ.timezone,
      isRecurring: Boolean(occ.isRecurring),
      organizer: ev.organizer,
      invitedAs: ev.me.email,
      messageId: message?.row.message_id || null,
      // Every copy of the request, so each shows the invitation where it is read.
      messageIds: [...new Set(mails.filter(m => m.method === 'REQUEST' && !hiddenFolder(m.row)).map(m => m.row.message_id))],
      accountId: message?.row.account_id || null,
      accountEmail: message?.row.account_email || null,
      accountName: message?.row.account_name || null,
      eventId: copy?.row.id || null,
      calendarId: copy?.row.calendar_id || null,
      readOnly: copy ? Boolean(copy.row.read_only) : false,
      // What the answer is written over: the mailed object, or the calendar's copy.
      ical: source.row.ical,
      calendarIcal: copy?.row.ical || null,
    });
  }
  return out.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
}

// What the browser is shown of one: the objects stay on the server.
export function publicInvitation(inv) {
  const out = { ...inv };
  delete out.ical;
  delete out.calendarIcal;
  return out;
}
