import { isPrivateAddress } from './hostValidation.js';

// The sign-in rate limits are keyed on req.ip. Behind a proxy or tunnel that TRUST_PROXY_HOPS
// does not count, every request seems to come from the proxy, and one client's failures lock out
// everyone, which looks like nothing more than people mistyping. So the first requests over plain
// HTTP (the listener a proxy forwards to; the built-in HTTPS one is reached directly) are watched,
// and when they all share one private or loopback address the log says so, once.
export function createClientAddressWatch({ sample = 25, warn = console.warn, hops } = {}) {
  let seen = 0;
  let address = null;
  let done = false;
  return function clientAddressWatch(req, _res, next) {
    if (!done && !req.socket?.encrypted) {
      const ip = req.ip;
      if (seen === 0) address = ip;
      seen += 1;
      if (ip !== address || !isPrivateAddress(ip)) {
        done = true;
      } else if (seen >= sample) {
        done = true;
        warn(`WARNING: the last ${seen} requests all appear to come from ${ip}, a private or loopback address, `
          + `so every client shares one sign-in rate limit. If a reverse proxy or tunnel sits in front of Plimail, `
          + `set TRUST_PROXY_HOPS to the number of proxies (now ${hops ?? 'unknown'}).`);
      }
    }
    next();
  };
}
