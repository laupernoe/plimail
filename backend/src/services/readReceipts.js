import nodemailer from 'nodemailer';
import { randomBytes } from 'crypto';
import { parseMailboxList } from './messageParser.js';
import { MAILER_ID } from './mailerIdentity.js';

// Read receipts (MDN, RFC 8098). The sending side adds Disposition-Notification-To; the receiving
// side decides whether a receipt may be offered, and builds it. Nothing here touches the database
// or the mail server, so each rule can be tested on its own. routes/readReceipts.js does the I/O.

export const READ_RECEIPT_HEADER = 'Disposition-Notification-To';
// The IMAP keyword Thunderbird and others set once a receipt was sent or declined for a message.
export const MDN_SENT_FLAG = '$MDNSent';

// The header a message asking for a receipt carries, as nodemailer's `headers` option wants it.
// The address is the one the message is sent from, so the receipt comes back to the sender.
export function readReceiptHeaders(requested, fromEmail) {
  return requested === true && fromEmail ? { [READ_RECEIPT_HEADER]: fromEmail } : {};
}

// The user's "ask for a read receipt on every message" setting, off unless turned on.
export const readReceiptAlways = preferences => preferences?.readReceiptRequestAlways === true;

// What to do with a receipt request: 'ask' (the banner, the default), 'always' or 'never'.
export const RECEIPT_REPLY_MODES = ['ask', 'always', 'never'];
export const receiptReplyMode = preferences => (
  RECEIPT_REPLY_MODES.includes(preferences?.readReceiptReply) ? preferences.readReceiptReply : 'ask'
);

const addressOf = value => String(value ?? '').replace(/[\r\n\0]/g, '').trim().toLowerCase();

// Folders a receipt is never offered from: spam, and the user's own outgoing mail.
const NO_RECEIPT_FOLDERS = new Set(['junk', 'spam', 'drafts', 'sent']);
export const folderRole = specialUse => String(specialUse || '').replaceAll('\\', '').toLowerCase();

// Mailing lists and bulk mail: a receipt to a list address tells the list nothing useful and
// confirms a live address to whoever sent it.
function isListOrBulk(h, message) {
  if (message?.is_bulk === true) return true;
  if (h['list-id'] || h['list-post'] || h['list-unsubscribe']) return true;
  return /^\s*(list|bulk|junk)\b/i.test(h.precedence || '');
}

function isMarkedSpam(h) {
  if (/^\s*yes\b/i.test(h['x-spam-flag'] || '')) return true;
  return /^\s*yes\b/i.test(h['x-spam-status'] || '');
}

// A receipt answering a receipt, a bounce or an automatic reply would loop (RFC 8098 section 3).
function isAutomatic(h) {
  if (/^\s*multipart\/report\b/i.test(h['content-type'] || '')) return true;
  const auto = String(h['auto-submitted'] || '').trim().toLowerCase();
  return auto !== '' && !auto.startsWith('no');
}

// Whether a receipt may be offered for a message. `headers` is parseRawHeaders' lower-cased map,
// `flags` the message's IMAP flags, `role` its folder's role (folderRole), `message` the stored row.
//   none     the message asks for nothing
//   done     a receipt was already sent or declined ($MDNSent): never asked again
//   blocked  spam, a list or an automatic message, or a folder that is not the user's inbox mail
//   confirm  the request is from an address other than the one that delivered the message (or
//            names several): only an explicit confirmation may answer it (RFC 8098 section 2.1)
//   ok       a receipt may be sent to `address`
// A message without a Return-Path (one not delivered by an MTA that adds it) cannot be compared,
// so it is not held for confirmation; an empty one (`<>`, a bounce sender) is.
export function assessReceiptRequest({ headers, flags = [], role = '', message = null }) {
  const h = headers || {};
  const requested = parseMailboxList(h['disposition-notification-to'] || '');
  if (!requested.length) return { status: 'none', address: null };
  const address = requested[0].email;
  if ((flags || []).some(f => String(f).toLowerCase() === MDN_SENT_FLAG.toLowerCase())) return { status: 'done', address };
  if (NO_RECEIPT_FOLDERS.has(role) || isMarkedSpam(h) || isListOrBulk(h, message) || isAutomatic(h)) {
    return { status: 'blocked', address };
  }
  if (requested.length > 1) return { status: 'confirm', address, reason: 'multiple_addresses' };
  if (h['return-path'] !== undefined) {
    const returnPath = addressOf(String(h['return-path']).split('\n').pop().replace(/[<>]/g, ''));
    if (!returnPath || returnPath !== address) return { status: 'confirm', address, reason: 'return_path_mismatch' };
  }
  return { status: 'ok', address };
}

const cleanLine = value => String(value ?? '').replace(/[\r\n\0]+/g, ' ').trim();

// The notification of RFC 8098: multipart/report; report-type=disposition-notification, a human
// readable part and the machine readable message/disposition-notification. The user sent it by
// hand, so the disposition is manual-action/MDN-sent-manually (also for "send always": the user
// chose it, and automatic-action is for software acting with no user setting behind it).
// Returns { raw, envelope, messageId }.
export async function buildMdn({ fromName, fromEmail, to, original, reportingUa = MAILER_ID, now = new Date() }) {
  const domain = fromEmail.split('@')[1] || 'plimail.local';
  const messageId = `<${randomBytes(16).toString('hex')}@${domain}>`;
  const subject = cleanLine(original.subject) || '(no subject)';
  const origId = cleanLine(original.messageId);
  const sentOn = original.date ? new Date(original.date).toUTCString() : 'an unknown date';
  const human = [
    `This is a return receipt for the mail that you sent to ${fromEmail}.`,
    '',
    `    Subject: ${subject}`,
    `    Sent:    ${sentOn}`,
    '',
    'Note: This return receipt only acknowledges that the message was displayed on the',
    "recipient's computer. There is no guarantee that the recipient has read or understood",
    'the message contents.',
    '',
  ].join('\r\n');
  const fields = [
    `Reporting-UA: ${cleanLine(domain)}; ${cleanLine(reportingUa)}`,
    `Final-Recipient: rfc822; ${cleanLine(fromEmail)}`,
    ...(origId ? [`Original-Message-ID: ${origId}`] : []),
    'Disposition: manual-action/MDN-sent-manually; displayed',
    '',
  ].join('\r\n');

  // nodemailer writes and encodes the headers (From, To, Subject, Date, Message-ID, threading);
  // the structure below replaces its Content-Type and body, as renderPgpMime does.
  const stream = nodemailer.createTransport({ streamTransport: true, newline: 'windows' });
  const info = await stream.sendMail({
    xMailer: MAILER_ID,
    messageId,
    date: now,
    from: fromName ? { name: cleanLine(fromName), address: fromEmail } : fromEmail,
    to,
    subject: `Read: ${subject}`.slice(0, 300),
    ...(origId ? { inReplyTo: origId, references: origId } : {}),
    text: '',
  });
  const chunks = [];
  await new Promise((resolve, reject) => {
    info.message.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    info.message.on('end', resolve);
    info.message.on('error', reject);
  });
  const rendered = Buffer.concat(chunks).toString('latin1');
  const end = rendered.indexOf('\r\n\r\n');
  if (end < 0) throw new Error('Could not render the receipt headers');
  const kept = rendered.slice(0, end).split(/\r\n(?![ \t])/)
    .filter(f => !/^(content-type|content-transfer-encoding):/i.test(f));
  const boundary = `----=_mdn_${randomBytes(12).toString('hex')}`;
  const b64 = text => Buffer.from(text, 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n');
  const body = [
    'This is a message in MIME format (a read receipt, RFC 8098).',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64(human),
    `--${boundary}`,
    'Content-Type: message/disposition-notification',
    '',
    fields,
    `--${boundary}--`,
    '',
  ].join('\r\n');
  const contentType = `Content-Type: multipart/report; report-type=disposition-notification;\r\n boundary="${boundary}"`;
  return {
    raw: Buffer.from(`${[...kept, contentType].join('\r\n')}\r\n\r\n${body}`, 'latin1'),
    envelope: { from: fromEmail, to: [to] },
    messageId,
  };
}
