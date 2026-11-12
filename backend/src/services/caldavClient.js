// CalDAV client. Discovers calendars and reads and writes events over WebDAV.
// Every request goes through safeFetch and the host policy, as server-provided hrefs are attacker-influenced.
//
// Credentials are bound to origins. A creds object carries the origins its password may go to: the
// origin of the account's server URL, and nothing else. A redirect, href or SRV target on any other
// origin is not followed but fails with an error naming it, so the user can enter it as the server
// URL if it is right. Same-origin redirects are followed.

import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import { XMLParser } from 'fast-xml-parser';
import { validateHost } from './hostValidation.js';
import { safeFetch } from './safeFetch.js';

const parser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  trimValues: false,
  processEntities: { maxTotalExpansions: 10_000_000, maxExpansionDepth: 10 },
});

const toArray = x => (Array.isArray(x) ? x : x == null ? [] : [x]);
const textOf = (node) => {
  if (node == null) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (typeof node === 'object' && '#text' in node) return String(node['#text']);
  return '';
};
const absolute = (href, base) => { try { return new URL(href, base).href; } catch { return href; } };
const escapeXml = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Same reason as CardDAV: SabreDAV writes each trailing CR as &#13; and the parser leaves numeric references.
function decodeCharRefs(str) {
  return str.replace(/&#([xX][0-9a-fA-F]+|\d+);/g, (match, code) => {
    const cp = /^[xX]/.test(code) ? parseInt(code.slice(1), 16) : parseInt(code, 10);
    if (!Number.isFinite(cp) || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return match;
    return String.fromCodePoint(cp);
  });
}

function propsOf(response) {
  const merged = {};
  for (const ps of toArray(response.propstat)) {
    const status = textOf(ps.status);
    if (status && !/\b2\d\d\b/.test(status)) continue;
    Object.assign(merged, ps.prop || {});
  }
  return merged;
}

const MAX_REDIRECTS = 5;
const WELL_KNOWN_PATHS = ['/.well-known/caldav', '/dav/', '/caldav/', '/remote.php/dav/', '/dav.php/', '/cal.php/', '/SOGo/dav/', '/webdav/caldav/'];

// Every body is read through readBody against one of these caps. Discovery answers are small. An
// etag listing runs to a few hundred bytes per event, so a calendar of 100,000 events fits in the
// listing cap. Event data is fetched in batches that are split when they exceed theirs, so the
// event cap is in practice the size of one event, attachments included.
export const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
export const MAX_LISTING_BYTES = 50 * 1024 * 1024;
export const MAX_EVENT_DATA_BYTES = 25 * 1024 * 1024;

// The auth scheme each origin last asked for. An origin known to want Digest is first asked without
// credentials, so its challenge comes back and the password never goes out as Basic.
const schemes = new Map();
function rememberScheme(origin, scheme) {
  if (schemes.size >= 1000) schemes.clear();
  schemes.set(origin, scheme);
}
export const forgetAuthSchemes = () => schemes.clear();

const originOf = (url) => { try { return new URL(url).origin; } catch { return null; } };

// The credentials for one CalDAV server: its password goes to that server's origin only.
export function bindCredentials(serverUrl, { username, password, allowPrivate = false }) {
  const origin = originOf(serverUrl);
  if (!origin || origin === 'null') throw new Error('Invalid server URL');
  return { username, password, allowPrivate, origins: [origin] };
}

function otherOriginError(url, creds) {
  return Object.assign(new Error(
    `The CalDAV server points to ${url}, which is not on ${creds.origins?.[0] || 'the account\'s server'}. `
    + 'MailFlow only sends the password to the server it was given; if that address is right, enter it as the server URL.',
  ), { otherOrigin: url });
}

function tooLargeError(url, limit) {
  return Object.assign(new Error(`The CalDAV server sent more than ${Math.round(limit / 1048576)} MB for ${url}`), { tooLarge: true });
}

// The body as text, refused past `limit` bytes as they arrive rather than once they are all held.
async function readBody(res, url, limit = MAX_RESPONSE_BYTES) {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    await discard(res);
    throw tooLargeError(url, limit);
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => {});
        throw tooLargeError(url, limit);
      }
      chunks.push(value);
    }
  } catch (err) {
    if (err.tooLarge) throw err;
    if (err.name === 'TimeoutError') throw new Error('CalDAV server did not respond (timed out)', { cause: err });
    throw new Error(`Could not read the CalDAV server's answer: ${err.message}`, { cause: err });
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

function discard(res) {
  return res.body?.cancel().catch(() => {});
}

// Pure. The Authorization header answering an RFC 7616 Digest challenge, or null for a challenge
// that is not Digest or uses an algorithm unknown here.
export function digestHeader(challenge, { username, password, method, url, cnonce = crypto.randomBytes(8).toString('hex') }) {
  const at = challenge.search(/digest\s/i);
  if (at < 0) return null;
  const params = {};
  for (const m of challenge.slice(at + 7).matchAll(/([a-zA-Z-]+)=(?:"([^"]*)"|([^\s,]+))/g)) {
    const key = m[1].toLowerCase();
    if (!(key in params)) params[key] = m[2] ?? m[3];
  }
  const algorithm = (params.algorithm || 'MD5').toUpperCase();
  const hashName = { MD5: 'md5', 'SHA-256': 'sha256' }[algorithm];
  if (!hashName || !params.nonce) return null;
  const hash = str => crypto.createHash(hashName).update(str).digest('hex');
  const uri = new URL(url).pathname + new URL(url).search;
  const ha1 = hash(`${username}:${params.realm ?? ''}:${password}`);
  const ha2 = hash(`${method}:${uri}`);
  const qop = (params.qop || '').split(',').map(q => q.trim()).includes('auth') ? 'auth' : null;
  const nc = '00000001';
  const response = qop ? hash(`${ha1}:${params.nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : hash(`${ha1}:${params.nonce}:${ha2}`);
  const quote = str => String(str).replace(/["\\]/g, '\\$&');
  return [
    `Digest username="${quote(username)}"`, `realm="${quote(params.realm ?? '')}"`, `nonce="${quote(params.nonce)}"`,
    `uri="${quote(uri)}"`, `algorithm=${algorithm}`, `response="${response}"`,
    ...(params.opaque != null ? [`opaque="${quote(params.opaque)}"`] : []),
    ...(qop ? [`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`] : []),
  ].join(', ');
}

const authFailed = () => Object.assign(new Error('Authentication failed — check the username and app password'), { status: 401 });
const BASIC_RE = /(^|[\s,])basic(\s|,|$)/i;

// Redirects are followed here rather than by fetch, which would change the verb, and only within
// the origins the credentials are bound to. No credentials go out until the origin has answered with
// a challenge: Digest when it offers it, Basic otherwise. An origin that took Basic gets it up front
// from then on, which saves the round trip; one that asked for Digest is asked again each time, as
// each answer needs a fresh nonce. The URL the answer came from, after redirects, is kept (urlOf).
async function request(method, url, creds, { depth, body, headers = {}, contentType = 'application/xml; charset=utf-8' } = {}, hops = 0) {
  const { username, password, allowPrivate = false } = creds;
  let target;
  try { target = new URL(url); } catch { throw new Error('Invalid server URL'); }
  if (!creds.origins?.includes(target.origin)) throw otherOriginError(url, creds);
  const hostErr = await validateHost(target.hostname, { allowPrivate });
  if (hostErr) throw new Error(hostErr);
  const basic = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  const all = { ...headers };
  if (body) all['Content-Type'] = contentType;
  if (depth != null) all.Depth = String(depth);
  const known = schemes.get(target.origin);
  if (known === 'basic') all.Authorization = basic;
  const send = async () => {
    try {
      return await safeFetch(url, { method, headers: all, body, redirect: 'manual', signal: AbortSignal.timeout(30000) }, { allowPrivate, plaintextPrivateOnly: true });
    } catch (err) {
      if (err.name === 'TimeoutError') throw new Error('CalDAV server did not respond (timed out)', { cause: err });
      // fetch reports a refused connection as "fetch failed", with safeFetch's reason as the cause.
      throw new Error(`Could not reach the CalDAV server: ${err.cause?.message || err.message}`, { cause: err });
    }
  };
  let res = await send();
  if (res.status === 401) {
    const challenge = res.headers.get('www-authenticate') || '';
    await discard(res);
    const digest = digestHeader(challenge, { username, password, method, url });
    const sentBasic = all.Authorization === basic;
    if (digest) {
      all.Authorization = digest;
      rememberScheme(target.origin, 'digest');
    } else if (!sentBasic && (!challenge || BASIC_RE.test(challenge))) {
      all.Authorization = basic;
    } else {
      if (!sentBasic && challenge) {
        throw Object.assign(new Error('The CalDAV server asks for a sign-in method MailFlow does not support'), { status: 401 });
      }
      throw authFailed();
    }
    res = await send();
    if (res.status !== 401 && all.Authorization === basic) rememberScheme(target.origin, 'basic');
  }
  if (res.status === 401) {
    await discard(res);
    throw authFailed();
  }
  if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.get('location')) {
    await discard(res);
    if (hops >= MAX_REDIRECTS) throw new Error('The CalDAV server redirected too many times');
    let next;
    try { next = new URL(res.headers.get('location'), url); } catch { throw new Error('The CalDAV server redirected to an invalid address'); }
    if (!creds.origins.includes(next.origin)) throw otherOriginError(next.href, creds);
    return request(method, next.href, creds, { depth, body, headers, contentType }, hops + 1);
  }
  landed.set(res, url);
  return res;
}

const landed = new WeakMap();
// Relative hrefs in an answer are relative to where it came from, not to where the request began.
const urlOf = (res, fallback) => landed.get(res) || fallback;

// The body of a successful answer, and the URL it came from.
async function dav(method, url, creds, opts = {}, limit = MAX_RESPONSE_BYTES) {
  const res = await request(method, url, creds, opts);
  if (!res.ok) {
    await discard(res);
    throw Object.assign(new Error(`CalDAV request failed (${res.status} ${res.statusText})`), { status: res.status });
  }
  const at = urlOf(res, url);
  return { text: await readBody(res, at, limit), url: at };
}

export function parseHref(xmlText, key, baseUrl) {
  const response = toArray(parser.parse(xmlText)?.multistatus?.response)[0];
  if (!response) return null;
  const val = propsOf(response)[key];
  const href = toArray(val?.href ?? val)[0];
  const text = textOf(href).trim();
  return text ? absolute(text, baseUrl) : null;
}

async function propfindHref(url, prop, key, creds) {
  const body = `<?xml version="1.0" encoding="utf-8"?>
<propfind xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><prop>${prop}</prop></propfind>`;
  const answer = await dav('PROPFIND', url, creds, { depth: 0, body });
  return parseHref(answer.text, key, answer.url);
}

// Pure. The mailto addresses of a calendar-user-address-set, lowercased, in the server's order.
export function parseAddresses(xmlText) {
  const response = toArray(parser.parse(xmlText)?.multistatus?.response)[0];
  if (!response) return [];
  const set = propsOf(response)['calendar-user-address-set'];
  const out = [];
  for (const href of toArray(set?.href ?? set)) {
    const m = /^mailto:(.+)$/i.exec(textOf(href).trim());
    const email = m && decodeURIComponent(m[1]).trim().toLowerCase();
    if (email && !out.includes(email)) out.push(email);
  }
  return out;
}

// RFC 6638. Whether the server delivers invitations itself (calendar-auto-schedule), and the
// addresses an organizer may use there. Anything that fails reads as "the server does not".
export async function schedulingInfo(calendarUrl, creds) {
  let serverSchedules = false;
  try {
    const res = await request('OPTIONS', calendarUrl, creds);
    await discard(res);
    serverSchedules = res.ok && /(^|[\s,])calendar-auto-schedule([\s,]|$)/i.test(res.headers.get('dav') || '');
  } catch (err) {
    if (err.status === 401) throw err;
  }
  let addresses = [];
  try {
    const principal = await propfindHref(calendarUrl, '<current-user-principal/>', 'current-user-principal', creds);
    if (principal) {
      const body = `<?xml version="1.0" encoding="utf-8"?>
<propfind xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><prop><C:calendar-user-address-set/></prop></propfind>`;
      addresses = parseAddresses((await dav('PROPFIND', principal, creds, { depth: 0, body })).text);
    }
  } catch (err) {
    if (err.status === 401) throw err;
  }
  return { serverSchedules: serverSchedules && addresses.length > 0, addresses };
}

// RFC 6764: a domain can name its CalDAV host and path in DNS.
async function srvCandidate(hostname) {
  try {
    const [srv] = await dns.resolveSrv(`_caldavs._tcp.${hostname}`);
    if (!srv?.name) return null;
    const txt = await dns.resolveTxt(`_caldavs._tcp.${hostname}`).catch(() => []);
    const path = txt.flat().find(t => t.startsWith('path='))?.slice(5) || '/';
    return `https://${srv.name}:${srv.port}${path}`;
  } catch {
    return null;
  }
}

// The URL the user gave, then the standard and the common locations on that server. A server
// that answers but names no principal may still hold the calendars at the URL itself. A candidate
// on another origin, from SRV or a redirect, is not tried with the password but kept as the hint
// to give when nothing on this origin answers.
async function resolvePrincipal(serverUrl, creds) {
  const { origin, hostname } = new URL(serverUrl);
  const candidates = [serverUrl, ...WELL_KNOWN_PATHS.map(path => `${origin}${path}`)];
  const srv = await srvCandidate(hostname);
  if (srv) candidates.splice(1, 0, srv);
  let answered = false;
  let lastErr;
  let hint = null;
  for (const base of candidates) {
    try {
      const principal = await propfindHref(base, '<current-user-principal/>', 'current-user-principal', creds);
      if (principal) return { principal, hint };
      if (base === serverUrl) answered = true;
    } catch (err) {
      if (err.status === 401 || err.tooLarge) throw err;
      if (err.otherOrigin) hint ||= err;
      else lastErr = err;
    }
  }
  if (answered || (!lastErr && !hint)) return { principal: serverUrl, hint };
  throw hint || lastErr;
}

async function calendarHome(principal, creds) {
  try {
    return await propfindHref(principal, '<C:calendar-home-set/>', 'calendar-home-set', creds) || principal;
  } catch (err) {
    if (err.status === 401 || err.otherOrigin || err.tooLarge) throw err;
    return principal;
  }
}

// Where an account's calendars are listed, found from its server URL. Several requests; the result
// is worth keeping (see caldavSync.js).
export async function discoverHome(serverUrl, creds) {
  const { principal, hint } = await resolvePrincipal(serverUrl, creds);
  return { home: await calendarHome(principal, creds), hint };
}

const HOME_PROPFIND = `<?xml version="1.0" encoding="utf-8"?>
<propfind xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CS="http://calendarserver.org/ns/" xmlns:A="http://apple.com/ns/ical/"><prop>
  <resourcetype/><displayname/><current-user-privilege-set/><CS:getctag/><A:calendar-color/><C:supported-calendar-component-set/>
</prop></propfind>`;

// The calendars a home lists, with their ctags, in one request. One the home lists on another
// origin cannot be read with these credentials, so it comes back apart, under `elsewhere`. `home`
// is where the listing came from, redirects followed.
export async function listCalendars(home, creds) {
  const answer = await dav('PROPFIND', home, creds, { depth: 1, body: HOME_PROPFIND });
  const all = parseCalendars(answer.text, answer.url);
  const calendars = all.filter(c => creds.origins.includes(originOf(c.url)));
  return { home: answer.url, calendars, elsewhere: all.filter(c => !calendars.includes(c)) };
}

// Whether a calendar's own URL answers that it is gone (404 or 410). Any other answer, or an error,
// proves nothing, so the caller keeps the calendar.
export async function calendarGone(url, creds) {
  try {
    await dav('PROPFIND', url, creds, { depth: 0, body: '<?xml version="1.0" encoding="utf-8"?><propfind xmlns="DAV:"><prop><resourcetype/></prop></propfind>' });
    return false;
  } catch (err) {
    if (err.status === 404 || err.status === 410) return true;
    throw err;
  }
}

// Never an empty list: no calendar at all is an error, not an account whose calendars were deleted.
export function requireCalendars({ calendars, elsewhere }, creds, hint) {
  if (calendars.length) return calendars;
  if (elsewhere.length) throw otherOriginError(elsewhere[0].url, creds);
  if (hint) throw hint;
  throw new Error('No calendars found for this account');
}

// Writable unless the server lists privileges and write is not among them. No list says nothing.
function readOnlyFrom(privilegeSet) {
  if (!privilegeSet || typeof privilegeSet !== 'object') return false;
  const privileges = toArray(privilegeSet.privilege);
  if (!privileges.length) return false;
  return !privileges.some(p => p && typeof p === 'object' && ('write' in p || 'write-content' in p || 'all' in p));
}

function colorFrom(raw) {
  const m = /^#?([0-9a-fA-F]{6})/.exec(textOf(raw).trim());
  return m ? `#${m[1].toLowerCase()}` : null;
}

// Pure. Calendars able to hold events, out of a Depth 1 PROPFIND of the calendar home.
export function parseCalendars(xmlText, baseUrl) {
  const calendars = [];
  for (const response of toArray(parser.parse(xmlText)?.multistatus?.response)) {
    const props = propsOf(response);
    if (!props.resourcetype || typeof props.resourcetype !== 'object' || !('calendar' in props.resourcetype)) continue;
    const comps = toArray(props['supported-calendar-component-set']?.comp).map(c => c?.['@_name']);
    if (comps.length && !comps.includes('VEVENT')) continue;
    const href = textOf(response.href).trim();
    if (!href) continue;
    const url = absolute(href, baseUrl);
    calendars.push({
      url,
      name: textOf(props.displayname).trim() || decodeURIComponent(url.replace(/\/$/, '').split('/').pop()) || 'Calendar',
      color: colorFrom(props['calendar-color']),
      ctag: textOf(props.getctag).trim() || null,
      readOnly: readOnlyFrom(props['current-user-privilege-set']),
    });
  }
  return calendars;
}

export async function discoverCalendars({ serverUrl, username, password, allowPrivate = false }) {
  const creds = bindCredentials(serverUrl, { username, password, allowPrivate });
  const { home, hint } = await discoverHome(serverUrl, creds);
  return requireCalendars(await listCalendars(home, creds), creds, hint);
}

// The first of these hosts that serves CalDAV with these credentials. Each try binds them to that
// host's origin, so a mail password reaches only the hosts given, never one a redirect, an href or
// an SRV record names. When none serves CalDAV, the host one of them pointed to is the useful answer.
export async function findCalDavServer(hosts, { username, password, allowPrivate = false }) {
  const errors = [];
  for (const host of [...new Set(hosts.filter(Boolean))]) {
    const serverUrl = `https://${host}/`;
    try {
      const calendars = await discoverCalendars({ serverUrl, username, password, allowPrivate });
      return { serverUrl, calendars };
    } catch (err) {
      errors.push(err);
    }
  }
  throw errors.find(e => e.otherOrigin) || errors.at(-1) || new Error('No CalDAV server found');
}

// Servers spell one href several ways (%40 or @, %7B or {), so hrefs compare through this.
export function hrefKey(url) {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname.split('/').map((seg) => {
      try { return decodeURIComponent(seg); } catch { return seg; }
    }).join('/')}`;
  } catch {
    return url;
  }
}

// Pure. A listing or multiget. A 507 anywhere means the server cut the answer short, which must not
// read as "the other events are gone".
export function parseResources(xmlText, calendarUrl) {
  const responses = toArray(parser.parse(xmlText)?.multistatus?.response);
  if (responses.some(r => /\b507\b/.test(textOf(r.status)))) {
    throw new Error('CalDAV server returned a truncated response');
  }
  const self = absolute(calendarUrl, calendarUrl).replace(/\/$/, '');
  const out = [];
  for (const response of responses) {
    const rawHref = textOf(response.href).trim();
    if (!rawHref) continue;
    const url = absolute(rawHref, calendarUrl);
    if (url.replace(/\/$/, '') === self) continue;
    const props = propsOf(response);
    if (props.resourcetype && typeof props.resourcetype === 'object' && 'collection' in props.resourcetype) continue;
    const contentType = textOf(props.getcontenttype);
    if (contentType && !/calendar/i.test(contentType)) continue;
    const data = decodeCharRefs(textOf(props['calendar-data'])).trim();
    out.push({ rawHref, url, etag: textOf(props.getetag).trim() || null, ical: data || null });
  }
  return out;
}

const QUERY_UNSUPPORTED = new Set([400, 403, 405, 415, 422, 501]);
export const MULTIGET_BATCH = 100;

// Hrefs and etags of every event in a calendar. Complete or throwing, never partial.
export async function listEvents(calendarUrl, creds) {
  const body = `<?xml version="1.0" encoding="utf-8"?>
<C:calendar-query xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><prop><getetag/></prop>
<C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT"/></C:comp-filter></C:filter></C:calendar-query>`;
  try {
    const answer = await dav('REPORT', calendarUrl, creds, { depth: 1, body }, MAX_LISTING_BYTES);
    return parseResources(answer.text, answer.url);
  } catch (err) {
    if (!QUERY_UNSUPPORTED.has(err.status)) throw err;
  }
  const listing = await dav('PROPFIND', calendarUrl, creds, { depth: 1, body: `<?xml version="1.0" encoding="utf-8"?>
<propfind xmlns="DAV:"><prop><getetag/><getcontenttype/><resourcetype/></prop></propfind>` }, MAX_LISTING_BYTES);
  return parseResources(listing.text, listing.url);
}

// A batch over the cap is asked for again in halves. A single event over it comes back with an
// error instead of its data, so that one event is reported and the others still sync. Each entry is
// one of listEvents: the href as the server wrote it goes in the request, and the URL it resolved to
// is used to fetch the event alone.
async function multiget(calendarUrl, batch, creds) {
  const body = `<?xml version="1.0" encoding="utf-8"?>
<C:calendar-multiget xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><prop><getetag/><C:calendar-data/></prop>${batch.map(e => `<href>${escapeXml(e.rawHref)}</href>`).join('')}</C:calendar-multiget>`;
  try {
    const answer = await dav('REPORT', calendarUrl, creds, { depth: 1, body }, MAX_EVENT_DATA_BYTES);
    return parseResources(answer.text, answer.url);
  } catch (err) {
    if (err.tooLarge) {
      if (batch.length === 1) {
        const { rawHref, url } = batch[0];
        return [{ rawHref, url, etag: null, ical: null, error: `The event at ${url} is larger than ${MAX_EVENT_DATA_BYTES / 1048576} MB` }];
      }
      const half = Math.ceil(batch.length / 2);
      return [...await multiget(calendarUrl, batch.slice(0, half), creds), ...await multiget(calendarUrl, batch.slice(half), creds)];
    }
    if (!QUERY_UNSUPPORTED.has(err.status)) throw err;
  }
  const events = [];
  for (const { rawHref, url } of batch) {
    try {
      const one = await getEvent(url, creds);
      if (one) events.push({ rawHref, url, ...one });
    } catch (err) {
      if (!err.tooLarge) throw err;
      events.push({ rawHref, url, etag: null, ical: null, error: err.message });
    }
  }
  return events;
}

// `entries` come from listEvents. A bare href is read against the calendar's URL.
export async function fetchEvents(calendarUrl, entries, creds) {
  const all = entries.map(e => (typeof e === 'string' ? { rawHref: e, url: absolute(e, calendarUrl) } : e));
  const events = [];
  for (let i = 0; i < all.length; i += MULTIGET_BATCH) {
    events.push(...await multiget(calendarUrl, all.slice(i, i + MULTIGET_BATCH), creds));
  }
  return events;
}

export async function getEvent(url, creds) {
  const res = await request('GET', url, creds);
  if (res.status === 404 || res.status === 410) { await discard(res); return null; }
  if (!res.ok) {
    await discard(res);
    throw Object.assign(new Error(`CalDAV request failed (${res.status} ${res.statusText})`), { status: res.status });
  }
  return { etag: res.headers.get('etag'), ical: await readBody(res, url, MAX_EVENT_DATA_BYTES) };
}

// A write that replaces or removes an event names the version it was made from, so a change made
// elsewhere in the meantime is a conflict rather than overwritten. Without one there is no safe write.
function requireVersion(etag) {
  if (!etag) throw new Error('The version of this event on the server is not known, so it was not changed');
}

// 412 is the server saying the event is not the version this edit was made from. The etag returned
// is the one the server gave for what was sent, if it stored it unchanged, else null.
export async function putEvent(url, ical, creds, { etag, create = false } = {}) {
  if (!create) requireVersion(etag);
  const headers = create ? { 'If-None-Match': '*' } : { 'If-Match': etag };
  const res = await request('PUT', url, creds, { body: ical, headers, contentType: 'text/calendar; charset=utf-8' });
  await discard(res);
  if (res.status === 412) throw Object.assign(new Error('Event changed on the server'), { conflict: true });
  if (!res.ok) {
    throw Object.assign(new Error(`The CalDAV server refused the event (${res.status} ${res.statusText})`), { status: res.status, forbidden: res.status === 403 });
  }
  const at = urlOf(res, url);
  const location = res.headers.get('location');
  const sentEtag = res.headers.get('etag');
  if (!location) return { url: at, etag: sentEtag };
  let stored;
  try { stored = new URL(location, at); } catch { return { url: at, etag: sentEtag }; }
  // Saved, but where these credentials cannot follow: the next sync brings the event in.
  if (!creds.origins.includes(stored.origin)) throw otherOriginError(stored.href, creds);
  return { url: stored.href, etag: stored.href === at ? sentEtag : null };
}

// RFC 4918 MOVE to another calendar on the same server, so the event is never in both or neither.
// Overwrite: F, so nothing at the destination is replaced. `unsupported` marks a server that will
// not move between these calendars, which leaves the event where it was.
const MOVE_UNSUPPORTED = new Set([403, 405, 501, 502]);
export async function moveEvent(url, destination, creds, { etag } = {}) {
  requireVersion(etag);
  let dest;
  try { dest = new URL(destination); } catch { throw new Error('Invalid destination'); }
  if (!creds.origins.includes(dest.origin)) throw otherOriginError(dest.href, creds);
  const res = await request('MOVE', url, creds, { headers: { Destination: dest.href, Overwrite: 'F', 'If-Match': etag } });
  await discard(res);
  if (res.status === 412) throw Object.assign(new Error('Event changed on the server'), { conflict: true });
  if (res.status === 404 || res.status === 410) throw Object.assign(new Error('Event not found on the server'), { notFound: true });
  if (MOVE_UNSUPPORTED.has(res.status)) {
    throw Object.assign(new Error(`The CalDAV server did not move the event (${res.status} ${res.statusText})`), { status: res.status, unsupported: true });
  }
  if (!res.ok) throw Object.assign(new Error(`The CalDAV server refused the move (${res.status} ${res.statusText})`), { status: res.status });
  return { url: dest.href };
}

export async function deleteEvent(url, creds, { etag } = {}) {
  requireVersion(etag);
  // The empty body sends Content-Length: 0, which MDaemon answers 411 without.
  const res = await request('DELETE', url, creds, { body: '', headers: { 'If-Match': etag } });
  await discard(res);
  if (res.status === 412) throw Object.assign(new Error('Event changed on the server'), { conflict: true });
  if (res.status === 404 || res.status === 410) return;
  if (!res.ok) {
    throw Object.assign(new Error(`The CalDAV server refused the deletion (${res.status} ${res.statusText})`), { status: res.status, forbidden: res.status === 403 });
  }
}
