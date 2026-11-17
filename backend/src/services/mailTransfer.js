// Pure helpers for bulk mail import and export: the mboxrd format, and the few headers an import
// reads before a message is appended. Nothing here touches IMAP or the database.
//
// Mail is not UTF-8, so every message is handled as bytes: a Buffer, or a latin1 string where a
// regex is needed (latin1 maps each byte to one character and back, so nothing is altered).

export class MailTransferFormatError extends Error {}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// A line that opens a message in an mbox. A "From " line with no date after it is not one: an
// mbox written without mboxrd escaping (mboxo) can have those in a body, and splitting there
// would cut a message in two.
const SEPARATOR_RE = /^From \S+\s+(?:[A-Za-z]{3},?\s+)?[A-Za-z]{3}\s+\d{1,2}\s+\d{1,2}:\d{2}/;
const FROM_DATE_RE = /^From \S+\s+(?:[A-Za-z]{3},?\s+)?([A-Za-z]{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s+([+-]\d{4}))?\s+(\d{4})\s*$/;

// No MIME line is anywhere near this long; a longer run without a line feed is not mail.
const MAX_LINE_BYTES = 16 * 1024 * 1024;
const HEADER_SCAN_BYTES = 256 * 1024;

const latin1 = buf => buf.toString('latin1');
const fromLatin1 = str => Buffer.from(str, 'latin1');

// "From MAILER-DAEMON Wed Jan  3 01:05:34 1996\n", the date in UTC.
export function mboxFromLine(date) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date(0);
  const pad = n => String(n).padStart(2, '0');
  return `From MAILER-DAEMON ${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, ' ')} `
    + `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} ${d.getUTCFullYear()}\n`;
}

// The date on a "From " line, or null. A line without a zone is read as UTC, which is what
// mboxFromLine writes.
export function parseFromLineDate(line) {
  const m = FROM_DATE_RE.exec(line);
  if (!m) return null;
  const month = MONTHS.indexOf(m[1][0].toUpperCase() + m[1].slice(1).toLowerCase());
  if (month < 0) return null;
  let ms = Date.UTC(Number(m[7]), month, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5] || 0));
  if (m[6]) {
    const offset = (Number(m[6].slice(1, 3)) * 60 + Number(m[6].slice(3, 5))) * 60000;
    ms -= (m[6][0] === '-' ? -offset : offset);
  }
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date;
}

// mboxrd: a line of ">"s followed by "From " gains one more ">", so no body line can be taken
// for a separator and the unescape is exact.
export function mboxrdEscape(raw) {
  return fromLatin1(latin1(raw).replace(/(^|\n)(>*From )/g, '$1>$2'));
}

export function mboxrdUnescape(raw) {
  return fromLatin1(latin1(raw).replace(/(^|\n)>(>*From )/g, '$1$2'));
}

// IMAP wants CRLF; an mbox written on Unix has bare line feeds.
export function toCrlf(raw) {
  return fromLatin1(latin1(raw).replace(/(?<!\r)\n/g, '\r\n'));
}

// mbox writers add one blank line after each message. It belongs to the file, not the message.
function withoutSeparatorBlank(buf) {
  const n = buf.length;
  if (n >= 4 && buf[n - 4] === 13 && buf[n - 3] === 10 && buf[n - 2] === 13 && buf[n - 1] === 10) return buf.subarray(0, n - 2);
  if (n >= 2 && buf[n - 1] === 10 && buf[n - 2] === 10) return buf.subarray(0, n - 1);
  return buf;
}

// The messages of an mbox, one at a time, from a stream, in memory proportional to one message.
// Yields { index, raw, fromDate, tooLarge }: raw is the message with CRLF line ends and the
// mboxrd escaping undone, or null when it is over maxMessageBytes (its bytes are counted and
// dropped, never held). fromDate is the date on the "From " line, or null.
// onBytes(n) is called with the size of each chunk as it is read, and may throw to stop.
export async function* parseMbox(stream, { maxMessageBytes = Infinity, onBytes } = {}) {
  let carry = Buffer.alloc(0);
  let started = false;
  let index = 0;
  let parts = [];
  let size = 0;
  let tooLarge = false;
  let fromDate = null;

  const finish = () => {
    const message = { index: index++, raw: null, fromDate, tooLarge };
    if (!tooLarge) message.raw = toCrlf(mboxrdUnescape(withoutSeparatorBlank(Buffer.concat(parts))));
    parts = [];
    size = 0;
    tooLarge = false;
    return message;
  };

  // Calls back with each complete message the line ends.
  function* feed(line) {
    const head = line.length >= 5 ? latin1(line.subarray(0, Math.min(line.length, 200))) : '';
    const opens = head.startsWith('From ') && (!started || SEPARATOR_RE.test(head));
    if (opens) {
      if (started) yield finish();
      started = true;
      fromDate = parseFromLineDate(head.replace(/\r?\n$/, ''));
      return;
    }
    if (!started) {
      if (line.every(b => b === 10 || b === 13 || b === 32 || b === 9)) return;
      throw new MailTransferFormatError('Not an mbox file: it does not start with a "From " line');
    }
    size += line.length;
    if (size > maxMessageBytes) {
      tooLarge = true;
      parts = [];
    } else if (!tooLarge) {
      parts.push(line);
    }
  }

  for await (const chunk of stream) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (onBytes) onBytes(data.length);
    const buf = carry.length ? Buffer.concat([carry, data]) : data;
    let start = 0;
    for (let nl = buf.indexOf(10, start); nl !== -1; nl = buf.indexOf(10, start)) {
      yield* feed(buf.subarray(start, nl + 1));
      start = nl + 1;
    }
    carry = Buffer.from(buf.subarray(start));
    if (carry.length > MAX_LINE_BYTES) throw new MailTransferFormatError('Not an mbox file: a line is longer than 16 MB');
  }
  if (carry.length) yield* feed(carry);
  if (started) yield finish();
}

// The header block as one string with folded lines joined, up to the first blank line.
function unfoldedHeaders(raw) {
  const head = raw.subarray(0, HEADER_SCAN_BYTES);
  const text = latin1(head);
  const ends = [text.indexOf('\r\n\r\n'), text.indexOf('\n\n')].filter(i => i >= 0);
  const end = ends.length ? Math.min(...ends) : text.length;
  return text.slice(0, end).replace(/\r?\n[ \t]+/g, ' ');
}

// The Message-ID header with its angle brackets, or null. Only the header block is read, so a
// "Message-ID:" line in a body cannot be taken for it.
export function messageIdOf(raw) {
  const m = /^message-id:[ \t]*(\S+)/im.exec(unfoldedHeaders(raw));
  if (!m) return null;
  const id = m[1].startsWith('<') ? m[1] : `<${m[1]}>`;
  return id.length > 2 && id.length <= 998 ? id : null;
}

// The date a message is stored with: the one on its mbox "From " line, else its Date header, else
// null (the server then uses the time of the import).
export function internalDateOf(raw, fromDate) {
  const plausible = d => d instanceof Date && !Number.isNaN(d.getTime()) && d.getUTCFullYear() >= 1970 && d.getUTCFullYear() < 2100;
  if (plausible(fromDate)) return fromDate;
  const m = /^date:[ \t]*(.+)$/im.exec(unfoldedHeaders(raw));
  if (!m) return null;
  const d = new Date(m[1].trim());
  return plausible(d) ? d : null;
}

// Whether the bytes open with a header field, which is the least a message has to have.
export function looksLikeMessage(raw) {
  return raw.length > 0 && /^[\x21-\x39\x3b-\x7e]+:/.test(latin1(raw.subarray(0, 998)));
}

// The raw Subject header (encoded words not decoded), for naming an exported file; empty without one.
export function subjectOf(raw) {
  const m = /^subject:[ \t]*(.*)$/im.exec(unfoldedHeaders(raw));
  return m ? m[1].trim() : '';
}

// The flags an mbox keeps in the message headers: Status (R read), X-Status (A answered,
// F flagged), as mutt and most mbox writers do, and Thunderbird's X-Mozilla-Status bit field
// (1 read, 2 replied, 4 flagged). Answers null when the message carries none of them.
export function mboxFlagsOf(raw) {
  const headers = unfoldedHeaders(raw);
  const value = name => new RegExp(`^${name}:[ \\t]*(\\S*)`, 'im').exec(headers)?.[1];
  const status = value('status');
  const xStatus = value('x-status');
  const mozilla = value('x-mozilla-status');
  if (status == null && xStatus == null && mozilla == null) return null;
  const bits = mozilla != null && /^[0-9a-f]{1,4}$/i.test(mozilla) ? parseInt(mozilla, 16) : 0;
  const flags = [];
  if (status?.includes('R') || bits & 1) flags.push('\\Seen');
  if (xStatus?.includes('A') || bits & 2) flags.push('\\Answered');
  if (xStatus?.includes('F') || bits & 4) flags.push('\\Flagged');
  return flags;
}

// The message with Status and X-Status headers for its IMAP flags, added at the end of its header
// block, so the read, answered and flagged state survives an export and an import. A message that
// already has a Status header is left as it is.
export function withMboxStatus(raw, flags) {
  if (/^status:/im.test(unfoldedHeaders(raw))) return raw;
  const has = f => flags?.has?.(f) || (Array.isArray(flags) && flags.includes(f));
  const nl = raw.indexOf(10);
  const eol = nl > 0 && raw[nl - 1] === 13 ? '\r\n' : '\n';
  const xStatus = (has('\\Answered') ? 'A' : '') + (has('\\Flagged') ? 'F' : '');
  const lines = Buffer.from(`Status: ${has('\\Seen') ? 'RO' : 'O'}${eol}${xStatus ? `X-Status: ${xStatus}${eol}` : ''}`, 'latin1');
  // The blank line that ends the header block; a message that is only headers gets them at the end.
  const blank = raw.indexOf(eol + eol);
  if (blank < 0) {
    const sep = raw.length && raw[raw.length - 1] !== 10 ? Buffer.from(eol, 'latin1') : Buffer.alloc(0);
    return Buffer.concat([raw, sep, lines]);
  }
  const at = blank + eol.length;
  return Buffer.concat([raw.subarray(0, at), lines, raw.subarray(at)]);
}
