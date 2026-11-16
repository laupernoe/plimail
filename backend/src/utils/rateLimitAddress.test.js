import { describe, it, expect } from 'vitest';
import { rateLimitAddress } from './rateLimitAddress.js';

describe('rateLimitAddress', () => {
  it('keys an IPv4 client on its address', () => {
    expect(rateLimitAddress('203.0.113.7')).toBe('203.0.113.7');
    expect(rateLimitAddress('::ffff:203.0.113.7')).toBe('203.0.113.7');
  });

  it('keys every address of one IPv6 /64 alike, however it is written', () => {
    const key = rateLimitAddress('2001:db8:1:2::1');
    expect(key).toBe('2001:db8:1:2::/64');
    for (const ip of ['2001:db8:1:2:aaaa:bbbb:cccc:dddd', '2001:0db8:0001:0002:0:0:0:ffff', '2001:DB8:1:2::9%eth0']) {
      expect(rateLimitAddress(ip)).toBe(key);
    }
    expect(rateLimitAddress('2001:db8:1:3::1')).not.toBe(key);
    expect(rateLimitAddress('::1')).toBe('0:0:0:0::/64');
    expect(rateLimitAddress('2001:db8::')).toBe('2001:db8:0:0::/64');
  });

  it('has a key for a request without an address', () => {
    expect(rateLimitAddress(undefined)).toBe('unknown');
    expect(rateLimitAddress('')).toBe('unknown');
  });
});
