// SSRF-safe fetch. A custom undici connector validates the target of EVERY
// connection the request makes — the initial host and every redirect hop, whether
// the target is a hostname or a literal IP — and pins the socket to the checked
// address (closing the check-then-connect rebinding window). This is the HTTP
// analogue of resolveForConnection() used for IMAP/SMTP.
//
// It also enforces scheme policy: only http(s) is allowed, and by default HTTPS is
// required for public targets (so Basic-auth credentials aren't sent in the clear).
// requireHttps defaults to !allowPrivate — public fetches must be HTTPS, while a
// self-hosted target reachable only because the admin enabled private hosts may use
// plaintext HTTP on a trusted network. Redirect downgrades to http are refused too.
// plaintextPrivateOnly narrows that further: plaintext is let through only to an address that
// is itself private, checked on the address each connection is made to, so a public host
// (or a name that resolves to one) still needs HTTPS when the admin allows private hosts.
//
// Use for outbound fetches to attacker-influenced or user-configured URLs
// (one-click unsubscribe, category list sources, CardDAV discovery). Admin-configured
// provider URLs that intentionally point at internal hosts (the AI base URL)
// deliberately keep using plain fetch.

import net from 'node:net';
import dns from 'node:dns';
import { Agent, buildConnector } from 'undici';
import { validateHostLiteral } from './hostValidation.js';

const baseConnect = buildConnector({});

function blocked() {
  return Object.assign(
    new Error('Host resolves to a private or reserved IP address'),
    { code: 'ERR_BLOCKED_PRIVATE_IP' },
  );
}
function insecure() {
  return Object.assign(
    new Error('Plaintext HTTP is not allowed for this request'),
    { code: 'ERR_INSECURE_TRANSPORT' },
  );
}

// A connector that refuses plaintext (when required) and private/reserved addresses,
// pinning the socket to a validated IP (with the original hostname kept for TLS SNI).
function guardedConnector(allowPrivate, requireHttps, plaintextPrivateOnly) {
  return (opts, callback) => {
    if (requireHttps && opts.protocol === 'http:') return callback(insecure());
    const plaintext = plaintextPrivateOnly && opts.protocol === 'http:';
    const refusal = (address) => {
      if (validateHostLiteral(address, { allowPrivate })) return blocked();
      if (plaintext && !validateHostLiteral(address)) return insecure();
      return null;
    };
    const host = opts.hostname;
    // Literal IP target (e.g. a redirect to http://169.254.169.254) — check directly.
    if (net.isIP(host)) {
      const err = refusal(host);
      if (err) return callback(err);
      return baseConnect(opts, callback);
    }
    // Hostname — resolve, validate every address, then connect to a checked IP.
    dns.lookup(host, { all: true }, (err, addresses) => {
      if (err) return callback(err);
      for (const a of addresses) {
        const refused = refusal(a.address);
        if (refused) return callback(refused);
      }
      baseConnect({ ...opts, hostname: addresses[0].address, servername: opts.servername || host }, callback);
    });
  };
}

const agents = new Map();
function agentFor(allowPrivate, requireHttps, plaintextPrivateOnly) {
  const key = `${allowPrivate ? 'priv' : 'pub'}:${requireHttps ? 'https' : 'any'}:${plaintextPrivateOnly ? 'plain-private' : 'plain-any'}`;
  if (!agents.has(key)) agents.set(key, new Agent({ connect: guardedConnector(allowPrivate, requireHttps, plaintextPrivateOnly) }));
  return agents.get(key);
}

export function safeFetch(url, options = {}, { allowPrivate = false, requireHttps = !allowPrivate, plaintextPrivateOnly = false } = {}) {
  let parsed;
  try { parsed = new URL(url); }
  catch { return Promise.reject(new Error('Invalid URL')); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return Promise.reject(Object.assign(new Error('Only http(s) URLs are allowed'), { code: 'ERR_UNSUPPORTED_SCHEME' }));
  }
  if (requireHttps && parsed.protocol !== 'https:') {
    return Promise.reject(insecure());
  }
  return fetch(url, { ...options, dispatcher: agentFor(allowPrivate, requireHttps, plaintextPrivateOnly) });
}
