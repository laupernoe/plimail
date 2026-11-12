// Invitations for calendar events. A server that schedules (RFC 6638 calendar-auto-schedule)
// delivers them itself once the event is saved with an ORGANIZER it knows; for any other server
// MailFlow mails them (RFC 6047) from the user's own mail account for the organizer's address.

import { query } from './db.js';
import crypto from 'node:crypto';
import { findOwnedAccount } from './ownership.js';
import { MAILER_ID } from './mailerIdentity.js';
import { schedulingInfo } from './caldavClient.js';
import { expandResource, itipMessage } from './icalEvents.js';
import { redactEmail } from '../utils/redact.js';

const CACHE_MS = 60 * 60_000;
const cache = new Map();

export function forgetScheduling(accountId) {
  cache.delete(accountId);
}

export async function schedulingFor(accountId, calendarUrl, creds) {
  const hit = cache.get(accountId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.info;
  const info = await schedulingInfo(calendarUrl, creds);
  cache.set(accountId, { at: Date.now(), info });
  const addresses = [...new Set(info.addresses.map(a => a.toLowerCase()))].sort();
  try {
    await query(
      'UPDATE caldav_accounts SET calendar_addresses = $2 WHERE id = $1 AND calendar_addresses IS DISTINCT FROM $2::text[]',
      [accountId, addresses],
    );
  } catch (err) {
    console.warn(`Calendar: could not store the addresses of account ${accountId}: ${err.message}`);
  }
  return info;
}

// The user's own sending addresses: every mail account and alias, lowercased.
export async function ownAddresses(userId) {
  const r = await query(
    `SELECT m.id AS account_id, lower(m.email_address) AS email, COALESCE(m.sender_name, m.name) AS name, NULL::uuid AS alias_id
       FROM email_accounts m WHERE m.user_id = $1 AND m.enabled
     UNION ALL
     SELECT m.id, lower(a.email), a.name, a.id
       FROM account_aliases a JOIN email_accounts m ON m.id = a.account_id
      WHERE m.user_id = $1 AND m.enabled`,
    [userId],
  );
  return r.rows.filter(row => row.email);
}

// Every address that is the user's: own mail accounts and aliases, CalDAV logins that are
// addresses, and what their servers listed as the user's calendar addresses. Whether the user
// organizes an event or is invited to it is always decided against this one list.
async function addressesWith(userId, own) {
  const accounts = await query('SELECT lower(username) AS username, calendar_addresses FROM caldav_accounts WHERE user_id = $1', [userId]);
  const out = new Set(own.map(o => o.email));
  for (const a of accounts.rows) {
    if (a.username.includes('@')) out.add(a.username);
    for (const email of a.calendar_addresses || []) out.add(email.toLowerCase());
  }
  return [...out];
}

export async function knownAddresses(userId) {
  return addressesWith(userId, await ownAddresses(userId));
}

// Who organizes a new invitation, and how it reaches people. The server's own addresses come
// first when it schedules, as it only delivers for an organizer it recognizes.
export async function planInvites({ userId, accountId, calendarUrl, username, creds }) {
  const scheduling = await schedulingFor(accountId, calendarUrl, creds);
  const own = await ownAddresses(userId);
  const myEmails = await addressesWith(userId, own);
  const byEmail = new Map(own.map(o => [o.email, o]));
  if (scheduling.serverSchedules) {
    const email = scheduling.addresses.find(a => byEmail.has(a)) || scheduling.addresses[0];
    return { mode: 'server', organizer: { email, name: byEmail.get(email)?.name || null }, myEmails };
  }
  const login = String(username || '').toLowerCase();
  const sender = scheduling.addresses.map(a => byEmail.get(a)).find(Boolean) || byEmail.get(login) || null;
  return { mode: 'mail', organizer: sender ? { email: sender.email, name: sender.name || null } : null, myEmails };
}

const LABEL_KEYS = ['invite', 'update', 'cancel', 'accepted', 'declined', 'tentative', 'when', 'where'];
const DEFAULT_LABELS = {
  invite: 'Invitation: {title}', update: 'Updated invitation: {title}', cancel: 'Cancelled: {title}',
  accepted: 'Accepted: {title}', declined: 'Declined: {title}', tentative: 'Tentative: {title}',
  when: 'When', where: 'Where',
};

// Labels the browser sends in the user's language; anything missing or odd falls back to English.
export function mailLabels(raw) {
  const out = { ...DEFAULT_LABELS };
  if (raw && typeof raw === 'object') {
    for (const key of LABEL_KEYS) {
      const v = raw[key];
      if (typeof v === 'string' && v.trim() && v.length <= 200 && !/[\r\n]/.test(v)) out[key] = v;
    }
  }
  return out;
}

function firstOccurrence(ics) {
  const occ = expandResource(ics, Date.now() - 86400000, Date.now() + 5 * 365 * 86400000)[0]
    || expandResource(ics, 0, 8.64e15)[0];
  return occ || null;
}

function whenText(occ, { lang, timeZone }) {
  if (!occ) return '';
  const locale = (() => { try { return Intl.getCanonicalLocales(lang)[0]; } catch { return 'en'; } })();
  if (occ.allDay) {
    const f = new Intl.DateTimeFormat(locale, { dateStyle: 'full', timeZone: 'UTC' });
    const last = new Date(Date.parse(`${occ.end}T00:00:00Z`) - 86400000);
    const first = new Date(`${occ.start}T00:00:00Z`);
    return last > first ? `${f.format(first)} – ${f.format(last)}` : f.format(first);
  }
  const zone = (() => { try { new Intl.DateTimeFormat('en', { timeZone }); return timeZone; } catch { return 'UTC'; } })();
  const f = new Intl.DateTimeFormat(locale, { dateStyle: 'full', timeStyle: 'short', timeZone: zone });
  // timeStyle cannot be combined with timeZoneName: Intl throws.
  const t = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', timeZone: zone, timeZoneName: 'short' });
  return `${f.format(new Date(occ.start))} – ${t.format(new Date(occ.end))}`;
}

async function senderFor(userId, email) {
  const own = (await ownAddresses(userId)).find(o => o.email === email);
  if (!own) return null;
  const account = await findOwnedAccount(userId, own.account_id);
  return account ? { account, name: own.name || null } : null;
}

// Mails one iTIP message. Returns { sent, rejected } or throws an Error with a user-facing message.
export async function mailItip({ userId, from, to, method, ics, kind, labels, lang, timeZone, only }) {
  const recipients = [...new Set(to.map(e => e.toLowerCase()))].filter(e => e && e !== from);
  if (!recipients.length) return { sent: 0, rejected: [] };
  const sender = await senderFor(userId, from);
  if (!sender) throw Object.assign(new Error('No mail account sends from the organizer address'), { code: 'no_sender' });
  // Loaded here: the SMTP transport pulls in the OAuth routes and, through them, the mail engine.
  const { createAccountSmtpTransport } = await import('./smtpTransport.js');
  const smtp = await createAccountSmtpTransport(sender.account);
  if (smtp.error) throw new Error(smtp.error);
  const content = itipMessage(ics, method, { only });
  // Read before a CANCEL marks it cancelled, which leaves an exception with no occurrence to show.
  const occ = firstOccurrence(ics);
  const title = occ?.summary || '';
  const subject = labels[kind].replace('{title}', title);
  const lines = [subject, ''];
  const when = whenText(occ, { lang, timeZone });
  if (when) lines.push(`${labels.when}: ${when}`);
  if (occ?.location) lines.push(`${labels.where}: ${occ.location}`);
  if (occ?.description && method !== 'REPLY') lines.push('', occ.description);
  const domain = from.split('@')[1] || 'mailflow.local';
  try {
    const info = await smtp.transport.sendMail({
      xMailer: MAILER_ID,
      from: sender.name ? { name: sender.name, address: from } : from,
      to: recipients.join(', '),
      subject,
      text: lines.join('\n'),
      messageId: `<${crypto.randomUUID()}@${domain}>`,
      icalEvent: { method, content, filename: 'invite.ics' },
      attachments: [{ filename: 'invite.ics', content, contentType: `application/ics; name="invite.ics"` }],
    });
    const rejected = (info?.rejected || []).map(String);
    console.log(`Calendar: mailed ${method} for ${redactEmail(from)} to ${recipients.length - rejected.length} of ${recipients.length}`);
    return { sent: recipients.length - rejected.length, rejected };
  } catch (err) {
    console.warn(`Calendar: ${method} from ${redactEmail(from)} failed: ${err.message}`);
    // Loaded here: outgoingMail.js pulls in the whole mail engine.
    const { sanitizeSmtpError } = await import('./outgoingMail.js');
    throw new Error(sanitizeSmtpError(err), { cause: err });
  } finally {
    smtp.transport.close?.();
  }
}
