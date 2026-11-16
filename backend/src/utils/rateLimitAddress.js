import { isIPv4, isIPv6 } from 'net';

// The address a per-client rate limit is keyed on. An IPv6 client is handed a whole /64, usually
// more, and picks any address in it at will, so keying on the full address would give it a fresh
// bucket per request: it is keyed on its /64. An IPv4-mapped address (::ffff:203.0.113.7, which a
// dual-stack socket reports) is the IPv4 client it maps.
export function rateLimitAddress(ip) {
  if (typeof ip !== 'string' || ip === '') return 'unknown';
  const bare = ip.split('%')[0];
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(bare);
  if (mapped && isIPv4(mapped[1])) return mapped[1];
  if (!isIPv6(bare)) return ip;
  const [head, rest] = bare.split('::');
  const groups = s => (s ? s.split(':').flatMap(g => (isIPv4(g) ? ['0', '0'] : [g])) : []);
  const hi = groups(head);
  const lo = rest === undefined ? [] : groups(rest);
  const all = rest === undefined ? hi : [...hi, ...new Array(8 - hi.length - lo.length).fill('0'), ...lo];
  return `${all.slice(0, 4).map(g => parseInt(g, 16).toString(16)).join(':')}::/64`;
}
