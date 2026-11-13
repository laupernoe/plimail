import { describe, it, expect } from 'vitest';
import express from 'express';
import { parseTrustProxyHops } from './trustProxy.js';

// A reverse proxy appends the address of whoever connected to it to X-Forwarded-For. With two
// proxies, the outer one has already set the header to the client's address.
const OUTER = '172.18.0.5';

// Sets 'trust proxy' the way index.js does (index.js connects to Redis as soon as it loads, so
// it is not imported here). The assertions are on the req.ip Express derives, not on the parsed
// number, because req.ip is what the login rate limit is keyed on.
async function seenAs(setting, forwardedFor) {
  const app = express();
  app.set('trust proxy', setting);
  app.get('/', (req, res) => res.json({ ip: req.ip, secure: req.secure }));
  const server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/`, {
      headers: { 'X-Forwarded-For': forwardedFor, 'X-Forwarded-Proto': 'https' },
    });
    return await res.json();
  } finally {
    server.close();
  }
}

describe('TRUST_PROXY_HOPS', () => {
  it('trusts one proxy when unset, so a client behind it cannot pick its own address', async () => {
    for (const value of [undefined, '']) {
      expect(parseTrustProxyHops(value)).toBe(1);
      expect(await seenAs(parseTrustProxyHops(value), '6.6.6.6, 203.0.113.7'))
        .toEqual({ ip: '203.0.113.7', secure: true });
    }
  });

  it('gives each client behind two proxies its own address with 2', async () => {
    const hops = parseTrustProxyHops('2');
    expect(await seenAs(hops, `203.0.113.7, ${OUTER}`)).toEqual({ ip: '203.0.113.7', secure: true });
    expect(await seenAs(hops, `198.51.100.9, ${OUTER}`)).toEqual({ ip: '198.51.100.9', secure: true });
  });

  it('ignores addresses further back than the hops it trusts', async () => {
    expect((await seenAs(parseTrustProxyHops('2'), `6.6.6.6, 203.0.113.7, ${OUTER}`)).ip)
      .toBe('203.0.113.7');
  });

  it('sees every client behind two proxies as the outer one with 1', async () => {
    expect((await seenAs(1, `203.0.113.7, ${OUTER}`)).ip).toBe(OUTER);
    expect((await seenAs(1, `198.51.100.9, ${OUTER}`)).ip).toBe(OUTER);
  });

  it('trusts nothing with 0, for browsers connecting directly', async () => {
    expect(parseTrustProxyHops('0')).toBe(0);
    expect(await seenAs(0, '6.6.6.6')).toEqual({ ip: '127.0.0.1', secure: false });
  });

  it('accepts a whole number of proxies, trimmed, and rejects anything else', () => {
    expect(parseTrustProxyHops('1')).toBe(1);
    expect(parseTrustProxyHops(' 2 ')).toBe(2);
    for (const value of ['-1', '1.5', 'true', 'loopback', '2,3', 'abc']) {
      expect(parseTrustProxyHops(value)).toBeNull();
    }
  });
});
