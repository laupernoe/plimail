// TRUST_PROXY_HOPS counts the reverse proxies in front of Plimail: 1 (the default) for the usual
// TLS-terminating proxy, 0 when browsers connect to it directly. The result has to stay a number:
// Express reads a string 'trust proxy' as a list of addresses, so '2' passed through as it is
// would trust no proxy at all, and req.secure would turn false and drop the Secure flag from the
// session cookie.
export function parseTrustProxyHops(value) {
  const trimmed = (value ?? '').trim();
  if (trimmed === '') return 1;
  if (!/^\d+$/.test(trimmed)) return null;
  return Number(trimmed);
}
