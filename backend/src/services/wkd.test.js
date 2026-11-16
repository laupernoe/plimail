import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({ query: vi.fn(async () => ({ rows: [] })) }));
vi.mock('./redis.js', () => ({ redisClient: { get: vi.fn(), set: vi.fn() } }));

import { KEYS } from './pgp.fixtures.js';
import { lookupWkd, parseWkdAddress, wkdHash, wkdUrls, zbase32 } from './wkd.js';
import { safeFetch } from './safeFetch.js';

function memoryCache() {
  const store = new Map();
  return {
    store,
    get: vi.fn(async k => store.get(k)?.value ?? null),
    set: vi.fn(async (k, value, opts) => { store.set(k, { value, ttl: opts?.EX }); return 'OK'; }),
  };
}

const keyResponse = bytes => new Response(bytes, { status: 200, headers: { 'Content-Type': 'application/octet-stream' } });

describe('WKD addressing', () => {
  it('hashes the local part as the draft\'s example does', () => {
    // draft-koch-openpgp-webkey-service, section 3.1: Joe.Doe@Example.ORG
    expect(wkdHash('Joe.Doe')).toBe('iy9q119eutrkn8s1mk4r39qejnbu3n5q');
    expect(wkdUrls('Joe.Doe@Example.ORG')).toEqual({
      advanced: 'https://openpgpkey.example.org/.well-known/openpgpkey/example.org/hu/iy9q119eutrkn8s1mk4r39qejnbu3n5q?l=Joe.Doe',
      direct: 'https://example.org/.well-known/openpgpkey/hu/iy9q119eutrkn8s1mk4r39qejnbu3n5q?l=Joe.Doe',
    });
  });

  it('encodes z-base-32 most significant bit first', () => {
    expect(zbase32(Buffer.from([0]))).toBe('yy');
    expect(zbase32(Buffer.from([0xff]))).toBe('9h');
  });

  it('percent-encodes the original local part', () => {
    expect(wkdUrls('a+b&c@example.org').direct).toMatch(/\?l=a%2Bb%26c$/);
  });

  it('refuses addresses that would point the fetch somewhere else', () => {
    for (const email of [
      'x@127.0.0.1', 'x@[::1]', 'x@localhost', 'x@printer.local', 'x@example.org:8443', 'x@example.org/path',
      'x@10.0.0.1', 'x@169.254.169.254', 'x@a..b', 'nobody', '@example.org', 'x@', 'x@0x7f000001',
    ]) {
      expect(parseWkdAddress(email), email).toBe(null);
      expect(wkdUrls(email), email).toBe(null);
    }
  });

  it('accepts internationalized domains in their ASCII form', () => {
    expect(parseWkdAddress('anna@bücher.example')).toEqual({ local: 'anna', domain: 'xn--bcher-kva.example' });
  });
});

describe('lookupWkd', () => {
  let cache;
  beforeEach(() => { cache = memoryCache(); });

  it('tries the advanced method, then the direct one, and keeps keys with the address', async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (url, init, guard) => {
      calls.push({ url, guard, redirect: init.redirect });
      if (url.startsWith('https://openpgpkey.')) return new Response('', { status: 404 });
      return keyResponse(Buffer.from(KEYS.bobBinaryBase64, 'base64'));
    });
    const result = await lookupWkd('bob@example.net', { fetchImpl, cache });
    expect(calls.map(c => c.url)).toEqual([wkdUrls('bob@example.net').advanced, wkdUrls('bob@example.net').direct]);
    // HTTPS only, private addresses refused unless the admin allows them.
    expect(calls[0].guard).toEqual({ allowPrivate: false, requireHttps: true });
    expect(result.keys.map(k => k.primary.fingerprint)).toEqual([KEYS.bobFingerprint]);
    expect(cache.set).toHaveBeenCalledTimes(1);
  });

  it('drops keys that have no user ID for the address asked about', async () => {
    const fetchImpl = vi.fn(async () => keyResponse(Buffer.from(KEYS.bobBinaryBase64, 'base64')));
    const result = await lookupWkd('mallory@example.net', { fetchImpl, cache });
    expect(result.keys).toEqual([]);
  });

  it('caches a miss for a short time and answers the next lookup from the cache', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 404 }));
    expect((await lookupWkd('nobody@example.org', { fetchImpl, cache })).keys).toEqual([]);
    const [[, value, opts]] = cache.set.mock.calls;
    expect(JSON.parse(value)).toEqual({ armored: [] });
    expect(opts.EX).toBe(15 * 60);
    const again = await lookupWkd('nobody@example.org', { fetchImpl, cache });
    expect(again.cached).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2); // the first lookup's two URLs only
  });

  it('serves a cached key without asking the directory again', async () => {
    const fetchImpl = vi.fn(async () => keyResponse(Buffer.from(KEYS.bobBinaryBase64, 'base64')));
    await lookupWkd('bob@example.net', { fetchImpl, cache });
    const again = await lookupWkd('bob@example.net', { fetchImpl, cache });
    expect(again.cached).toBe(true);
    expect(again.keys[0].primary.fingerprint).toBe(KEYS.bobFingerprint);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not cache a directory failure as "no key"', async () => {
    const fetchImpl = vi.fn(async () => new Response('oops', { status: 503 }));
    const result = await lookupWkd('bob@example.net', { fetchImpl, cache });
    expect(result).toMatchObject({ keys: [], error: true });
    expect(cache.set).not.toHaveBeenCalled();
  });

  it('takes a TLS failure on the advanced host and a 404 on the direct one for no key', async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (url.startsWith('https://openpgpkey.')) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ERR_TLS_CERT_ALTNAME_INVALID' } });
      return new Response('', { status: 404 });
    });
    const result = await lookupWkd('nobody@example.org', { fetchImpl, cache });
    expect(result).toEqual({ keys: [], cached: false });
    expect(JSON.parse(cache.set.mock.calls[0][1])).toEqual({ armored: [] });
  });

  it('treats a name that does not resolve as no key', async () => {
    const fetchImpl = vi.fn(async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); });
    const result = await lookupWkd('bob@example.net', { fetchImpl, cache });
    expect(result.keys).toEqual([]);
    expect(result.error).toBeUndefined();
  });

  it('never fetches for an address on a private host', async () => {
    const fetchImpl = vi.fn();
    expect((await lookupWkd('x@127.0.0.1', { fetchImpl, cache })).invalid).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('goes through safeFetch, which refuses private addresses on every connection', async () => {
    // The real guard: a literal private address is refused before any request is made.
    await expect(safeFetch('https://127.0.0.1/.well-known/openpgpkey/hu/x', {}, { allowPrivate: false, requireHttps: true }))
      .rejects.toMatchObject({ cause: { code: 'ERR_BLOCKED_PRIVATE_IP' } });
    await expect(safeFetch('http://example.org/', {}, { allowPrivate: false, requireHttps: true }))
      .rejects.toMatchObject({ code: 'ERR_INSECURE_TRANSPORT' });
  });

  it('ignores an answer that is not a key', async () => {
    const fetchImpl = vi.fn(async () => keyResponse(Buffer.from('<html>not found</html>')));
    const result = await lookupWkd('bob@example.net', { fetchImpl, cache });
    expect(result.keys).toEqual([]);
  });
});
