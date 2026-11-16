import { createHash } from 'node:crypto';
import { domainToASCII } from 'node:url';
import { safeFetch } from './safeFetch.js';
import { readBodyLimited } from './senderFavicon.js';
import { validateHostLiteral } from './hostValidation.js';
import { getConnectionPolicy } from './connectionPolicy.js';
import { redisClient } from './redis.js';
import { MAX_KEY_BYTES, PgpFormatError, parsePublicKeys } from './pgpPackets.js';

// Web Key Directory (draft-koch-openpgp-webkey-service): a domain publishes its users' public
// keys over HTTPS at a path derived from the address. Fetched here rather than in the browser,
// which CORS would stop, through safeFetch: every connection, redirects included, is checked
// against private and reserved addresses, and HTTPS is required.

const ZBASE32 = 'ybndrfg8ejkmcpqxot1uwisza345h769';

// z-base-32 (the draft's encoding of the SHA-1 of the local part), most significant bit first.
export function zbase32(bytes) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ZBASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ZBASE32[(value << (5 - bits)) & 31];
  return out;
}

// The local part is lower-cased (ASCII only, as the draft says) before it is hashed; the
// original goes along as ?l= for servers that need it.
export function wkdHash(localPart) {
  const mapped = String(localPart).replace(/[A-Z]/g, c => c.toLowerCase());
  return zbase32(createHash('sha1').update(mapped, 'utf8').digest());
}

const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

// The address split and checked: { local, domain } with the domain in lower-case ASCII, or null
// for anything that is not an ordinary address on a public DNS name (an IP literal, localhost, a
// name with a port or a path in it).
export function parseWkdAddress(email) {
  if (typeof email !== 'string' || email.length > 254) return null;
  const at = email.lastIndexOf('@');
  if (at < 1 || at === email.length - 1) return null;
  const local = email.slice(0, at);
  if (/[\s<>@"/\\]/.test(local) || local.length > 64) return null;
  const rawDomain = email.slice(at + 1).trim().toLowerCase();
  // domainToASCII reads 'example.org/path' as 'example.org', so anything URL-like goes first.
  if (/[/\\:?#[\]@%\s]/.test(rawDomain)) return null;
  const domain = domainToASCII(rawDomain);
  if (!domain || !DOMAIN_RE.test(domain)) return null;
  if (validateHostLiteral(domain)) return null;
  return { local, domain };
}

// The two places a key can be: the advanced method (an openpgpkey. subdomain) and the direct one.
// Both are asked, in that order: the draft falls back to the direct method only when the
// subdomain does not exist, but a wildcard DNS record makes it exist on many domains that publish
// nothing there.
export function wkdUrls(email) {
  const parsed = parseWkdAddress(email);
  if (!parsed) return null;
  const { local, domain } = parsed;
  const hash = wkdHash(local);
  const l = encodeURIComponent(local);
  return {
    advanced: `https://openpgpkey.${domain}/.well-known/openpgpkey/${domain}/hu/${hash}?l=${l}`,
    direct: `https://${domain}/.well-known/openpgpkey/hu/${hash}?l=${l}`,
  };
}

const FETCH_TIMEOUT_MS = 6000;
// A found key is kept an hour (it is also saved to the user's keyring by the caller); an address
// without one is asked again after 15 minutes, so a key published meanwhile is found soon.
const FOUND_TTL_S = 60 * 60;
const MISSING_TTL_S = 15 * 60;
const cacheKey = email => `pgp_wkd:${createHash('sha256').update(email.toLowerCase()).digest('hex')}`;

// One URL: the key bytes, null when there is none there (404, a name that does not resolve, an
// empty answer), and a thrown error for anything else, which is not cached as a miss.
async function fetchOne(url, { allowPrivate, fetchImpl }) {
  let res;
  try {
    res = await fetchImpl(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { Accept: 'application/octet-stream', 'User-Agent': 'Plimail-WKD/1.0' },
    }, { allowPrivate, requireHttps: true });
  } catch (err) {
    const code = err?.cause?.code || err?.code;
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'ENODATA') return null;
    throw err;
  }
  if (res.status === 404 || res.status === 410) {
    try { await res.body?.cancel?.(); } catch { /* best effort */ }
    return null;
  }
  if (!res.ok) {
    try { await res.body?.cancel?.(); } catch { /* best effort */ }
    throw Object.assign(new Error(`WKD answered ${res.status}`), { code: 'ERR_WKD_STATUS' });
  }
  const bytes = await readBodyLimited(res.body, MAX_KEY_BYTES);
  return bytes.length ? bytes : null;
}

// The keys a domain publishes for `email`, as parsePublicKeys gives them, only those with a user
// ID for this address (the draft asks clients to filter). [] when there are none.
// { cached } says whether the answer came from the cache. `fetchImpl` is for tests.
export async function lookupWkd(email, { fetchImpl = safeFetch, cache = redisClient } = {}) {
  const urls = wkdUrls(email);
  if (!urls) return { keys: [], cached: false, invalid: true };
  const wanted = email.toLowerCase();
  const key = cacheKey(wanted);
  try {
    const hit = await cache.get(key);
    if (hit) {
      const stored = JSON.parse(hit);
      return { keys: matching((stored.armored || []).flatMap(a => parsePublicKeys(a)), wanted), cached: true };
    }
  } catch { /* a cache failure means asking the directory */ }

  const { allowPrivateHosts } = await getConnectionPolicy().catch(() => ({ allowPrivateHosts: false }));
  let bytes = null;
  let failure = null;
  for (const url of [urls.advanced, urls.direct]) {
    try {
      bytes = await fetchOne(url, { allowPrivate: allowPrivateHosts, fetchImpl });
      if (bytes) break;
    } catch (err) {
      failure = err;
    }
  }
  let keys = [];
  if (bytes) {
    try {
      keys = matching(parsePublicKeys(bytes), wanted);
    } catch (err) {
      if (!(err instanceof PgpFormatError)) throw err;
      keys = [];
    }
  }
  // A directory that failed for a reason other than "no key" is not cached: a timeout or a 500
  // today says nothing about tomorrow, and caching it as "no key" would hide a key for a while.
  if (keys.length || !failure) {
    cache.set(key, JSON.stringify({ armored: keys.map(k => k.armored) }), { EX: keys.length ? FOUND_TTL_S : MISSING_TTL_S }).catch(() => {});
  }
  if (!keys.length && failure) return { keys: [], cached: false, error: true };
  return { keys, cached: false };
}

function matching(keys, email) {
  return keys.filter(k => k.emails.includes(email));
}
