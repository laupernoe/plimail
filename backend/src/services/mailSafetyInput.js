import { Parser } from 'htmlparser2';
import { BLOCK, DECOY, NOTICE, WARN } from './attachmentExtensions.js';
import { decodeMimeWords, parseMailboxList, parseRawHeaders } from './messageParser.js';

// What the AI mail actions (translate, "is this a scam?") send to the model about a received
// message, built from what is already stored plus the raw header block. Nothing here sends a byte
// of attachment content: attachments go out as metadata only. Alongside the model input the scam
// check derives red flags that need no model (a link whose text names another domain, a disguised
// or executable attachment, failed sender authentication), which the client shows either way.

export const SCAM_BODY_LIMIT = 20_000;
export const TRANSLATE_BODY_LIMIT = 24_000;
const MAX_LINKS = 40;
const MAX_ATTACHMENTS = 30;
const MAX_FLAGS = 20;
const MAX_FIELD = 300;

const SKIP_TAGS = new Set(['script', 'style', 'head', 'title', 'noscript', 'template']);
const BLOCK_TAGS = new Set(['p', 'div', 'br', 'tr', 'li', 'ul', 'ol', 'table', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'blockquote', 'pre', 'hr', 'section', 'article', 'header', 'footer']);
// Zero-width and other invisible characters senders pad text with.
const INVISIBLE_RE = /[\u00ad\u061c\u115f\u1160\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u206a-\u206f\ufeff]/g;

function oneLine(value, max = MAX_FIELD) {
  // eslint-disable-next-line no-control-regex -- control characters are what this removes
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

// Visible text and links of an HTML body in one linear pass (htmlparser2 is a state machine).
export function parseHtmlBody(html) {
  let text = '';
  const links = [];
  let skipDepth = 0;
  let anchor = null;
  const parser = new Parser({
    onopentag(name, attrs) {
      if (SKIP_TAGS.has(name)) { skipDepth++; return; }
      if (skipDepth) return;
      if (BLOCK_TAGS.has(name)) text += '\n';
      if (name === 'a') anchor = { href: typeof attrs.href === 'string' ? attrs.href.trim() : '', text: '' };
    },
    onclosetag(name) {
      if (SKIP_TAGS.has(name)) { if (skipDepth) skipDepth--; return; }
      if (skipDepth) return;
      if (BLOCK_TAGS.has(name)) text += '\n';
      if (name === 'a' && anchor) {
        if (anchor.href && links.length < MAX_LINKS * 4) links.push({ href: anchor.href, text: oneLine(anchor.text, 200) });
        anchor = null;
      }
    },
    ontext(chunk) {
      if (skipDepth) return;
      const clean = chunk.replace(INVISIBLE_RE, '');
      text += clean;
      if (anchor && anchor.text.length < 400) anchor.text += clean;
    },
  }, { decodeEntities: true, lowerCaseTags: true });
  try {
    const CHUNK = 65536;
    for (let i = 0; i < html.length; i += CHUNK) parser.write(html.slice(i, i + CHUNK));
    parser.end();
  } catch { /* whatever was read before a parser error is kept */ }
  return { text: tidyText(text), links };
}

export function tidyText(text) {
  return String(text || '')
    .replace(INVISIBLE_RE, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Cut at a paragraph or sentence end near the limit, and say so.
export function truncateText(text, limit) {
  if (text.length <= limit) return { text, truncated: null };
  let end = limit;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  const floor = Math.floor(end * 0.9);
  const para = text.lastIndexOf('\n\n', end);
  const cut = para >= floor ? para : Math.min(end, Math.max(text.lastIndexOf('. ', end - 2) + 1, text.lastIndexOf(' ', end - 1), floor));
  const shown = text.slice(0, cut > 0 ? cut : end).trimEnd();
  return { text: shown, truncated: { shown: shown.length, total: text.length } };
}

// The message's plain text: the stored text part, or the HTML's visible text.
export function messagePlainText(message) {
  const stored = tidyText(message.body_text || '');
  if (stored) return stored;
  return message.body_html ? parseHtmlBody(message.body_html).text : '';
}

function hostOf(href) {
  try {
    const url = new URL(href);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  } catch {
    return null;
  }
}

// The domain a link's visible text names, when the text itself is a URL or a bare domain.
const SHOWN_DOMAIN_RE = /^(?:https?:\/\/)?(?:www\.)?((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24})(?::\d+)?(?:[/?#][^\s]*)?$/i;
export function shownDomain(text) {
  const m = SHOWN_DOMAIN_RE.exec(String(text || '').trim());
  return m ? m[1].toLowerCase() : null;
}

// A rough registrable domain: the last two labels, three under a two-letter ccTLD's generic
// second level (example.co.uk). Good enough to tell paypal.com from paypal.com.evil.io.
const SECOND_LEVELS = new Set(['co', 'com', 'org', 'net', 'ac', 'gov', 'edu', 'gv', 'or', 'ne']);
export function baseDomain(host) {
  const labels = String(host || '').toLowerCase().split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  const take = labels[labels.length - 1].length === 2 && SECOND_LEVELS.has(labels[labels.length - 2]) ? 3 : 2;
  return labels.slice(-take).join('.');
}

export function analyzeLinks(rawLinks) {
  const seen = new Set();
  const links = [];
  const mismatches = [];
  for (const link of rawLinks) {
    const host = hostOf(link.href);
    if (!host) continue;
    const shown = shownDomain(link.text);
    const mismatch = Boolean(shown && baseDomain(shown) !== baseDomain(host));
    const key = `${link.text}\u0000${host}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (mismatch) mismatches.push({ shown, actual: host });
    if (links.length < MAX_LINKS) links.push({ text: link.text, host, mismatch });
  }
  return { links, mismatches };
}

// Windows and browsers drop trailing dots and spaces from a saved name ("invoice.exe." lands as
// invoice.exe), so they are dropped before the extension is read.
function stripTrailingDotsAndSpaces(name) {
  let end = name.length;
  while (end > 0 && /[.\s\u180e]/.test(name[end - 1])) end--;
  return name.slice(0, end);
}

const MACRO_EXTENSIONS = new Set(['docm', 'xlsm', 'xlsb', 'pptm', 'xlam', 'dotm', 'xltm', 'potm', 'ppam', 'sldm']);

// The risk of one attachment by its name, the declared MIME type being sender-controlled.
export function classifyAttachment(filename, mimeType = '') {
  const name = stripTrailingDotsAndSpaces(String(filename || '').replace(INVISIBLE_RE, '').trim()).toLowerCase();
  const parts = name.split('.');
  const ext = parts.length > 1 ? parts[parts.length - 1] : '';
  const prevExt = parts.length > 2 ? parts[parts.length - 2] : '';
  const doubleExtension = (BLOCK.has(ext) || WARN.has(ext)) && DECOY.has(prevExt) && !(ext === 'rtf' && ['doc', 'docx', 'odt'].includes(prevExt));
  const mime = String(mimeType || '').toLowerCase();
  let level = 'ok';
  if (BLOCK.has(ext) || /x-msdownload|x-msdos-program|x-sh\b|x-shellscript|java-archive|x-iso9660|vnd\.microsoft\.portable-executable/.test(mime)) level = 'block';
  else if (WARN.has(ext) || /macroenabled|text\/html|image\/svg/.test(mime)) level = 'warn';
  else if (NOTICE.has(ext) || /zip|x-rar|x-7z|x-tar|gzip|x-bzip/.test(mime)) level = 'notice';
  return { ext, level, doubleExtension, macro: MACRO_EXTENSIONS.has(ext) || /macroenabled/.test(mime), archive: level === 'notice' };
}

function attachmentList(message) {
  let list = message.attachments;
  if (typeof list === 'string') {
    try { list = JSON.parse(list); } catch { list = []; }
  }
  if (!Array.isArray(list)) return [];
  // Images shown inside the body are part of the message, not files the reader is asked to open.
  return list.filter(a => a && !(a.disposition === 'inline' && /^image\//i.test(a.type || '')));
}

function attachmentFlag(name, risk) {
  if (risk.doubleExtension) return { type: 'double_extension', name };
  if (risk.level === 'block') return { type: 'executable_attachment', name };
  if (risk.macro) return { type: 'macro_attachment', name };
  if (risk.level === 'warn') return { type: 'active_attachment', name };
  if (risk.archive) return { type: 'archive_attachment', name };
  return null;
}

// The first Authentication-Results header is the one the receiving server added on top; ones
// further down can come from the sender and prove nothing.
export function parseAuthenticationResults(value) {
  const first = String(value || '').split('\n')[0];
  const results = {};
  for (const m of first.matchAll(/\b(spf|dkim|dmarc)\s*=\s*([a-z]+)/gi)) {
    const mechanism = m[1].toLowerCase();
    if (!results[mechanism]) results[mechanism] = m[2].toLowerCase();
  }
  return { raw: oneLine(first, 600), ...results };
}

function addressOf(entry) {
  return String(entry?.email || entry?.address || '').trim().toLowerCase();
}

function domainOfAddress(address) {
  const at = address.lastIndexOf('@');
  return at > 0 ? address.slice(at + 1) : '';
}

function storedReplyTo(message) {
  let list = message.reply_to;
  if (typeof list === 'string') {
    try { list = JSON.parse(list); } catch { list = []; }
  }
  return Array.isArray(list) ? list.map(addressOf).filter(Boolean) : [];
}

// Build the scam-check input. rawHeaders is the message's header block when it could be read
// from the mail server, or empty.
export function buildScamAnalysis(message, rawHeaders = '', { bodyLimit = SCAM_BODY_LIMIT } = {}) {
  const headers = rawHeaders ? parseRawHeaders(rawHeaders) : {};
  const flags = [];
  const flag = (f) => { if (flags.length < MAX_FLAGS) flags.push(f); };

  const fromName = oneLine(message.from_name || message.sender_name || '');
  const fromAddress = String(message.from_email || message.sender_email || '').trim().toLowerCase();
  const fromDomain = domainOfAddress(fromAddress);

  // A display name that is itself an address other than the sender's: "service@paypal.com" <x@evil.io>.
  const nameAddress = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.exec(fromName)?.[0]?.toLowerCase();
  if (nameAddress && fromAddress && baseDomain(domainOfAddress(nameAddress)) !== baseDomain(fromDomain)) {
    flag({ type: 'display_name_address', shown: nameAddress, actual: fromAddress });
  }

  const headerReplyTo = headers['reply-to'] ? parseMailboxList(decodeMimeWords(headers['reply-to'])).map(addressOf) : [];
  const replyTo = [...new Set([...headerReplyTo, ...storedReplyTo(message)])].filter(a => a && a !== fromAddress);
  const foreignReplyTo = replyTo.find(a => baseDomain(domainOfAddress(a)) !== baseDomain(fromDomain));
  if (foreignReplyTo) flag({ type: 'reply_to_differs', address: foreignReplyTo });

  const returnPath = oneLine(String(headers['return-path'] || '').split('\n')[0].replace(/[<>]/g, ''), 200).toLowerCase();
  const auth = headers['authentication-results'] ? parseAuthenticationResults(headers['authentication-results']) : null;
  if (auth?.dmarc === 'fail') flag({ type: 'auth_fail', mechanism: 'dmarc', result: auth.dmarc });
  if (auth?.spf === 'fail') flag({ type: 'auth_fail', mechanism: 'spf', result: auth.spf });
  if (auth?.dkim === 'fail') flag({ type: 'auth_fail', mechanism: 'dkim', result: auth.dkim });

  const html = message.body_html ? parseHtmlBody(message.body_html) : { text: '', links: [] };
  const plain = tidyText(message.body_text || '') || html.text;
  const body = truncateText(plain, bodyLimit);
  const { links, mismatches } = analyzeLinks(html.links);
  for (const m of mismatches.slice(0, 5)) flag({ type: 'link_mismatch', ...m });

  const attachments = attachmentList(message).slice(0, MAX_ATTACHMENTS).map((a) => {
    const name = oneLine(decodeMimeWords(String(a.filename || 'attachment')), 200);
    const risk = classifyAttachment(name, a.type);
    const f = attachmentFlag(name, risk);
    if (f) flag(f);
    return {
      name,
      mime: oneLine(a.type || 'unknown', 100),
      size: Number.isFinite(Number(a.size)) ? Number(a.size) : null,
      ext: risk.ext,
      risk: f ? f.type : 'none',
    };
  });

  const lines = [];
  lines.push(`From: ${fromName ? `"${fromName}" ` : ''}<${fromAddress || 'unknown'}>`);
  if (replyTo.length) lines.push(`Reply-To: ${replyTo.slice(0, 5).join(', ')}`);
  if (returnPath && returnPath !== fromAddress) lines.push(`Return-Path: ${returnPath}`);
  lines.push(`Authentication-Results (added by the receiving server): ${auth ? auth.raw : 'not available'}`);
  lines.push(`Subject: ${oneLine(message.subject || '(no subject)', 500)}`);
  lines.push('');
  lines.push(`Links (${links.length}${html.links.length > links.length ? ', more not listed' : ''}):`);
  for (const l of links) {
    lines.push(`- text: "${l.text || '(no text)'}" -> actual domain: ${l.host}${l.mismatch ? '  [MISMATCH: the text names another domain]' : ''}`);
  }
  if (!links.length) lines.push('- none');
  lines.push('');
  lines.push(`Attachments (${attachments.length}, metadata only, contents not included):`);
  for (const a of attachments) {
    lines.push(`- ${a.name} | declared type: ${a.mime} | size: ${a.size ?? 'unknown'} bytes | extension: ${a.ext || 'none'}${a.risk !== 'none' ? ` | [${a.risk.replace(/_/g, ' ').toUpperCase()}]` : ''}`);
  }
  if (!attachments.length) lines.push('- none');
  lines.push('');
  lines.push(`Detected red flags: ${flags.length ? flags.map(f => f.type).join(', ') : 'none'}`);
  lines.push('');
  lines.push(body.truncated
    ? `Body (plain text, first ${body.truncated.shown} of ${body.truncated.total} characters):`
    : 'Body (plain text):');
  lines.push(body.text || '(empty)');

  return { input: lines.join('\n'), flags, truncated: body.truncated };
}
