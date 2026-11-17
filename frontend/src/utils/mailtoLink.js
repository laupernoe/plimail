// mailto: links (RFC 6068), as the installed app receives them through the manifest's protocol
// handler (/?mailto=<the whole mailto: URL, percent-encoded>) or as a browser tab registered with
// registerProtocolHandler does.
//
// Not URLSearchParams: that is the form encoding, where "+" means a space, and in a mailto: URL
// it is a plus ("mailto:a+tag@example.com", "subject=1+1"). Header names are case-insensitive,
// and everything is percent-encoded UTF-8.

const PENDING_KEY = 'mailflow_pending_mailto';
// A link opened while signed out waits for the sign-in, not forever.
const PENDING_TTL_MS = 10 * 60 * 1000;

function decode(text) {
  try { return decodeURIComponent(text); } catch { return text; }
}

// A header value must not carry a line break into the message it starts.
const oneLine = text => text.replace(/[\r\n]+/g, ' ').trim();

// "Doe, John" <j@example.com>, k@example.com: commas inside quotes or angle brackets do not split.
function splitAddresses(text) {
  const out = [];
  let current = '';
  let quoted = false;
  let angle = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\' && quoted && i + 1 < text.length) { current += ch + text[++i]; continue; }
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === '<') angle++;
    else if (!quoted && ch === '>' && angle > 0) angle--;
    if (ch === ',' && !quoted && angle === 0) { out.push(current); current = ''; continue; }
    current += ch;
  }
  out.push(current);
  return out.map(oneLine).filter(Boolean);
}

// Returns { to, cc, bcc, subject, body } for a mailto: URL, or null for anything else. Headers
// other than these (In-Reply-To, a custom one) are ignored, as RFC 6068 section 6 advises.
export function parseMailto(raw) {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!/^mailto:/i.test(text)) return null;
  const rest = text.slice('mailto:'.length).split('#')[0];
  const q = rest.indexOf('?');
  const path = q === -1 ? rest : rest.slice(0, q);
  const query = q === -1 ? '' : rest.slice(q + 1);

  const result = { to: splitAddresses(decode(path)), cc: [], bcc: [], subject: '', body: '' };
  let subjectSeen = false;
  let bodySeen = false;
  for (const field of query.split('&')) {
    if (!field) continue;
    const eq = field.indexOf('=');
    const name = decode(eq === -1 ? field : field.slice(0, eq)).toLowerCase();
    const value = decode(eq === -1 ? '' : field.slice(eq + 1));
    if (name === 'to' || name === 'cc' || name === 'bcc') result[name].push(...splitAddresses(value));
    // Once each: a second Subject or body is ignored rather than appended.
    else if (name === 'subject' && !subjectSeen) { subjectSeen = true; result.subject = oneLine(value); }
    else if (name === 'body' && !bodySeen) { bodySeen = true; result.body = value.replace(/\r\n?/g, '\n'); }
  }
  return result;
}

// The composer's draft for a parsed link. The body is plain text: escaped, so it shows as written
// and cannot add markup to the HTML editor.
export function mailtoComposeData(parsed) {
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return {
    to: parsed.to,
    cc: parsed.cc,
    bcc: parsed.bcc,
    subject: parsed.subject,
    body: parsed.body ? esc(parsed.body).replace(/\n/g, '<br>') : '',
  };
}

// The mailto: URL in a page address's ?mailto= parameter, decoded once. Read by hand, for the
// same reason as above: URLSearchParams would turn a "+" the browser left unescaped into a space.
export function mailtoFromSearch(search) {
  const match = /(?:^\?|&)mailto=([^&]*)/.exec(search || '');
  return match ? decode(match[1]) : null;
}

// Takes ?mailto= out of the address at startup, before the router can redirect a signed-out
// visitor to /login and drop it, and keeps it for MailApp to open once someone is signed in.
// Out of the address, a reload does not open the composer a second time.
export function stashMailtoFromLocation({ location, history, storage, now = Date.now() }) {
  const raw = mailtoFromSearch(location.search);
  if (raw === null) return;
  const params = location.search.slice(1).split('&').filter(p => p && !/^mailto=/.test(p));
  history.replaceState(history.state, '', location.pathname + (params.length ? `?${params.join('&')}` : '') + location.hash);
  try { storage.setItem(PENDING_KEY, JSON.stringify({ raw, at: now })); } catch { /* no session storage: the link is lost */ }
}

// The composer's draft for the link waiting to be opened, if any, removed as it is read.
export function takePendingMailto(storage, now = Date.now()) {
  let pending;
  try {
    pending = JSON.parse(storage.getItem(PENDING_KEY) || 'null');
    storage.removeItem(PENDING_KEY);
  } catch {
    return null;
  }
  if (!pending || typeof pending.raw !== 'string' || !(now - pending.at < PENDING_TTL_MS)) return null;
  const parsed = parseMailto(pending.raw);
  return parsed ? mailtoComposeData(parsed) : null;
}
