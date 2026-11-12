// Finds the IMAP and SMTP settings for an address, as Thunderbird does, so Add account can fill
// in the form. Only the domain is looked up and the password is never involved: every source is
// public (an HTTPS document, DNS), and what it answers is only a suggestion the user saves through
// POST /accounts, which validates it as if it were typed.
//
// The domain is user input and the answer decides where the password will go, so every fetch is
// HTTPS through safeFetch (no private targets unless the instance allows them), capped in time and
// size, and only servers Plimail can log in to are taken: TLS, password authentication, and the
// ports the instance allows. No server is connected to; a guess is only a name that resolves.
//
// Order: the domain's own autoconfig, Thunderbird's ISPDB, SRV records (RFC 6186), the provider
// behind the MX (Google and Microsoft 365 by name, else ISPDB for the MX's domain), then guesses.

import { promises as dnsPromises } from 'node:dns';
import { XMLParser } from 'fast-xml-parser';
import { safeFetch } from './safeFetch.js';
import { validateHostLiteral } from './hostValidation.js';
import { normalizeSenderDomain, readBodyLimited } from './senderFavicon.js';

export const AUTOCONFIG_MAX_BYTES = 256 * 1024;
export const AUTOCONFIG_TIMEOUT_MS = 6000;
const ISPDB_URL = 'https://autoconfig.thunderbird.net/v1.1/';
const IMAP_PORTS = new Set([143, 993]);
const SMTP_PORTS = new Set([465, 587]);
const PASSWORD_AUTH = new Set(['password-cleartext', 'password-encrypted', 'plain', 'secure']);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  processEntities: false,
  parseTagValue: false,
});

const toArray = x => (Array.isArray(x) ? x : x == null ? [] : [x]);
const textOf = (node) => {
  if (node == null) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node).trim();
  if (typeof node === 'object' && '#text' in node) return String(node['#text']).trim();
  return '';
};

// The local part and the domain of an address, the domain in its ASCII form, or null.
export function splitAddress(email) {
  if (typeof email !== 'string' || email.length > 254) return null;
  const at = email.trim().lastIndexOf('@');
  if (at < 1) return null;
  const local = email.trim().slice(0, at);
  if (/[\s<>]/.test(local)) return null;
  const domain = normalizeSenderDomain(email.trim().slice(at + 1));
  return domain ? { local, domain, address: `${local}@${domain}` } : null;
}

function fill(template, who) {
  return template
    .replace(/%EMAILADDRESS%/g, who.address)
    .replace(/%EMAILLOCALPART%/g, who.local)
    .replace(/%EMAILDOMAIN%/g, who.domain);
}

function hostOk(host, { allowPrivate }) {
  const name = normalizeSenderDomain(host);
  if (!name || validateHostLiteral(name, { allowPrivate })) return null;
  return name;
}

function portOk(port, allowed, { allowNonstandardPorts }) {
  return Number.isInteger(port) && port > 0 && port < 65536 && (allowNonstandardPorts || allowed.has(port));
}

// One server as the account form takes it, or null when Plimail could not use it. IMAP TLS is
// read from the port when the account is saved (implicit TLS on x993, STARTTLS elsewhere), so a
// server whose socket type disagrees with its port would be saved wrong and is left out.
export function acceptServer(kind, { host, port, tls }, policy) {
  const name = hostOk(host, policy);
  if (!name || (tls !== 'SSL' && tls !== 'STARTTLS')) return null;
  if (kind === 'imap') {
    if (!portOk(port, IMAP_PORTS, policy) || (tls === 'SSL') !== (port % 1000 === 993)) return null;
  } else if (!portOk(port, SMTP_PORTS, policy)) {
    return null;
  }
  return { host: name, port, tls };
}

// Pure. A Thunderbird autoconfig document (config-v1.1.xml, the ISPDB's format) read into the
// servers it lists, in its order of preference, with the address put into its placeholders.
export function parseAutoconfig(xmlText, email) {
  const who = splitAddress(email);
  let doc;
  try { doc = parser.parse(String(xmlText || '')); } catch { return null; }
  const provider = toArray(doc?.clientConfig?.emailProvider)[0];
  if (!who || !provider || typeof provider !== 'object') return null;
  const read = (node, type) => {
    if (!node || typeof node !== 'object' || node['@_type'] !== type) return null;
    const socket = textOf(node.socketType).toUpperCase();
    const auth = toArray(node.authentication).map(a => textOf(a).toLowerCase()).filter(Boolean);
    if (auth.length && !auth.some(a => PASSWORD_AUTH.has(a))) return null;
    const user = textOf(node.username);
    return {
      host: fill(textOf(node.hostname), who),
      port: Number(textOf(node.port)),
      tls: socket === 'SSL' || socket === 'TLS' ? 'SSL' : socket === 'STARTTLS' ? 'STARTTLS' : socket,
      username: user ? fill(user, who) : null,
    };
  };
  const imap = toArray(provider.incomingServer).map(n => read(n, 'imap')).filter(Boolean);
  const smtp = toArray(provider.outgoingServer).map(n => read(n, 'smtp')).filter(Boolean);
  // Thunderbird reads <calendar> beside <emailProvider>; some documents put it inside.
  const calendar = [...toArray(doc.clientConfig.calendar), ...toArray(provider.calendar)].find(c => c?.['@_type'] === 'caldav');
  const caldavUrl = textOf(calendar?.serverURL);
  return { imap, smtp, caldavUrl: caldavUrl ? fill(caldavUrl, who) : null };
}

// RFC 2782 order: lowest priority first, and among equals the heavier weight first (a fixed
// order rather than the weighted draw, so the same domain always gives the same answer). A
// target of "." says the service is not offered.
export function sortSrv(records) {
  return toArray(records)
    .filter(r => r && typeof r.name === 'string' && r.name && r.name !== '.')
    .sort((a, b) => (a.priority - b.priority) || (b.weight - a.weight));
}

// The registrable part of an MX host (mx2ff3.netcup.net is netcup.net, mx.example.co.uk is
// example.co.uk). A heuristic rather than the public suffix list: a two-letter country code
// under a short second level (co, com, net, org...) keeps three labels.
export function mxBaseDomain(host) {
  const labels = String(host || '').toLowerCase().replace(/\.+$/, '').split('.').filter(Boolean);
  if (labels.length < 2) return null;
  const keep = labels.length >= 3 && labels.at(-1).length === 2 && /^(?:co|com|net|org|ac|gov|edu|ne|or|gr)$/.test(labels.at(-2)) ? 3 : 2;
  return labels.slice(-keep).join('.');
}

const MX_PROVIDERS = [
  { test: /(?:^|\.)(?:google|googlemail)\.com$/, oauth: 'google',
    imap: { host: 'imap.gmail.com', port: 993, tls: 'SSL' }, smtp: { host: 'smtp.gmail.com', port: 587, tls: 'STARTTLS' } },
  { test: /\.mail\.protection\.outlook\.com$/, oauth: 'microsoft',
    imap: { host: 'outlook.office365.com', port: 993, tls: 'SSL' }, smtp: { host: 'smtp.office365.com', port: 587, tls: 'STARTTLS' } },
];

// Which sign-in owns a server, for the form to offer it instead of a password.
export function oauthFor(imapHost) {
  const h = String(imapHost || '').toLowerCase();
  if (h === 'imap.gmail.com') return 'google';
  if (h === 'outlook.office365.com' || h.endsWith('.outlook.com') || h.endsWith('.office365.com')) return 'microsoft';
  return null;
}

// An autoconfig document from url, or null for any failure: refused, slow, too large, not XML.
async function fetchAutoconfig(url, { fetchImpl, allowPrivate }) {
  let res;
  try {
    res = await fetchImpl(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(AUTOCONFIG_TIMEOUT_MS),
      headers: { Accept: 'application/xml, text/xml;q=0.9', 'User-Agent': 'Plimail autoconfig' },
    }, { allowPrivate, requireHttps: true });
  } catch {
    return null;
  }
  try {
    if (res.status !== 200) return null;
    const length = Number(res.headers?.get?.('content-length'));
    if (Number.isFinite(length) && length > AUTOCONFIG_MAX_BYTES) return null;
    return (await readBodyLimited(res.body, AUTOCONFIG_MAX_BYTES)).toString('utf8');
  } catch {
    return null;
  } finally {
    try { await res.body?.cancel?.(); } catch { /* already read or closed */ }
  }
}

// The first server of each kind Plimail can use, out of a parsed document.
function pickFromConfig(config, policy) {
  if (!config) return null;
  const imap = config.imap.map(s => ({ s, ok: acceptServer('imap', s, policy) })).find(x => x.ok);
  if (!imap) return null;
  const smtp = config.smtp.map(s => ({ s, ok: acceptServer('smtp', s, policy) })).find(x => x.ok);
  return {
    imap: imap.ok,
    smtp: smtp?.ok || null,
    username: imap.s.username,
    smtpUsername: smtp?.s.username || null,
    caldavUrl: /^https:\/\//i.test(config.caldavUrl || '') ? config.caldavUrl : null,
  };
}

async function fromAutoconfig(url, email, ctx) {
  return pickFromConfig(parseAutoconfig(await fetchAutoconfig(url, ctx), email), ctx);
}

const quiet = p => p.catch(() => []);

async function fromSrv(domain, { resolver, ...policy }) {
  const look = name => quiet(resolver.resolveSrv(name)).then(sortSrv);
  const [imaps, imap, submissions, submission] = await Promise.all(
    ['_imaps._tcp', '_imap._tcp', '_submissions._tcp', '_submission._tcp'].map(s => look(`${s}.${domain}`)),
  );
  // Implicit TLS first (RFC 8314), each list in its own SRV order.
  const first = (kind, lists) => {
    for (const [records, tls] of lists) {
      for (const r of records) {
        const ok = acceptServer(kind, { host: r.name, port: r.port, tls }, policy);
        if (ok) return ok;
      }
    }
    return null;
  };
  const imapServer = first('imap', [[imaps, 'SSL'], [imap, 'STARTTLS']]);
  if (!imapServer) return null;
  return { imap: imapServer, smtp: first('smtp', [[submissions, 'SSL'], [submission, 'STARTTLS']]) };
}

// RFC 6764: the CalDAV server a domain names in DNS, as a URL. No request is made to it here.
async function caldavFromSrv(domain, { resolver, ...policy }) {
  const [srv] = sortSrv(await quiet(resolver.resolveSrv(`_caldavs._tcp.${domain}`)));
  const host = srv && hostOk(srv.name, policy);
  if (!host) return null;
  const txt = await quiet(resolver.resolveTxt(`_caldavs._tcp.${domain}`));
  const path = txt.map(t => t.join('')).find(t => t.startsWith('path='))?.slice(5) || '/';
  return `https://${host}${srv.port && srv.port !== 443 ? `:${srv.port}` : ''}${path.startsWith('/') ? path : `/${path}`}`;
}

async function fromMx(domain, email, ctx) {
  const mx = (await quiet(ctx.resolver.resolveMx(domain))).filter(r => r?.exchange).sort((a, b) => a.priority - b.priority)[0];
  if (!mx) return null;
  const exchange = mx.exchange.toLowerCase().replace(/\.+$/, '');
  const provider = MX_PROVIDERS.find(p => p.test.test(exchange));
  if (provider) return { source: 'mx', imap: provider.imap, smtp: provider.smtp, oauth: provider.oauth };
  const base = mxBaseDomain(exchange);
  if (!base || base === domain) return null;
  const found = await fromAutoconfig(`${ISPDB_URL}${base}`, email, ctx);
  return found && { source: 'mx-ispdb', ...found };
}

async function resolves(host, resolver) {
  const [v4, v6] = await Promise.all([quiet(resolver.resolve4(host)), quiet(resolver.resolve6(host))]);
  return v4.length > 0 || v6.length > 0;
}

// The usual names, the first that resolves (else the first), on the standard ports.
async function guess(domain, ctx) {
  const pick = async (names, kind, server) => {
    for (const name of names) {
      if (await resolves(name, ctx.resolver)) return acceptServer(kind, { host: name, ...server }, ctx);
    }
    return acceptServer(kind, { host: names[0], ...server }, ctx);
  };
  const [imap, smtp] = await Promise.all([
    pick([`imap.${domain}`, `mail.${domain}`], 'imap', { port: 993, tls: 'SSL' }),
    pick([`smtp.${domain}`, `mail.${domain}`], 'smtp', { port: 587, tls: 'STARTTLS' }),
  ]);
  return imap ? { source: 'guess', imap, smtp } : null;
}

const defaultResolver = () => new dnsPromises.Resolver({ timeout: 3000, tries: 2 });

// The settings for an address, or null when its domain is not one. Result:
// { source, domain, imap: { host, port, tls }, smtp: { host, port, tls } | null, username,
//   smtpUsername, oauth: 'google' | 'microsoft' | null, caldavUrl }
// source: ispdb | autoconfig | wellknown | srv | mx | mx-ispdb | guess.
export async function discoverAccountSettings(email, {
  allowPrivate = false, allowNonstandardPorts = false, fetchImpl = safeFetch, resolver = defaultResolver(),
} = {}) {
  const who = splitAddress(email);
  if (!who) return null;
  const { domain } = who;
  const ctx = { fetchImpl, resolver, allowPrivate, allowNonstandardPorts };

  // The first three asked together, taken in order: each is one or two requests that mostly fail.
  const [ispdb, autoconfig, wellknown, srv, caldavSrv] = await Promise.all([
    fromAutoconfig(`${ISPDB_URL}${domain}`, who.address, ctx),
    fromAutoconfig(`https://autoconfig.${domain}/mail/config-v1.1.xml`, who.address, ctx),
    fromAutoconfig(`https://${domain}/.well-known/autoconfig/mail/config-v1.1.xml`, who.address, ctx),
    fromSrv(domain, ctx).catch(() => null),
    caldavFromSrv(domain, ctx).catch(() => null),
  ]);
  let found = (autoconfig && { source: 'autoconfig', ...autoconfig })
    || (wellknown && { source: 'wellknown', ...wellknown })
    || (ispdb && { source: 'ispdb', ...ispdb })
    || (srv && { source: 'srv', ...srv })
    || await fromMx(domain, who.address, ctx).catch(() => null)
    || await guess(domain, ctx);
  if (!found) return null;
  if (!found.smtp) {
    const fallback = await guess(domain, ctx);
    found = { ...found, smtp: fallback?.smtp || null };
  }
  const oauth = found.oauth || oauthFor(found.imap.host);
  const username = found.username || who.address;
  return {
    source: found.source,
    domain,
    imap: found.imap,
    smtp: found.smtp,
    username,
    smtpUsername: found.smtpUsername && found.smtpUsername !== username ? found.smtpUsername : null,
    oauth,
    // A provider with its own sign-in has no CalDAV to reach with a password.
    caldavUrl: oauth ? null : (found.caldavUrl || caldavSrv || null),
  };
}
