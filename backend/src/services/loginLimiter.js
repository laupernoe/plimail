import crypto from 'crypto';
import { consume, release, reset } from './rateLimiter.js';
import { rateLimitAddress } from '../utils/rateLimitAddress.js';

// Password sign-in attempts per username, on top of the per-address auth:<ip> budget. The address
// budget alone let anyone with an account of their own keep guessing another one: a guess, then a
// sign-in of their own, and so on. Here a sign-in clears only the counter of the account it signed
// in to, from that address, so guesses at an account add up however they are interleaved, and
// guesses spread over many addresses still meet the username's own hourly limit.
//
// Every username is counted alike, existing or not, before the password is looked at, so neither
// a refusal nor its timing tells whether an account exists.
export const LOGIN_LIMITS = Object.freeze({
  perUserAndAddress: Object.freeze({ max: 10, windowMs: 15 * 60 * 1000 }),
  perUser: Object.freeze({ max: 30, windowMs: 60 * 60 * 1000 }),
});

// Hashed, so a megabyte of username does not become a megabyte of Redis key.
const userKey = username => crypto.createHash('sha256').update(username).digest('hex').slice(0, 32);

// Counts one attempt at `username` (already normalized) from `ip`. Returns { limited, resetMs }
// and succeeded(), to call once the password has checked out.
export async function consumeLoginAttempt(username, ip) {
  const user = userKey(username);
  const pairKey = `login:${user}:${rateLimitAddress(ip)}`;
  const userOnlyKey = `login:${user}`;
  const { perUserAndAddress, perUser } = LOGIN_LIMITS;
  const pair = await consume(pairKey, perUserAndAddress.max, perUserAndAddress.windowMs);
  const any = await consume(userOnlyKey, perUser.max, perUser.windowMs);
  const blocking = [pair, any].filter(r => r.limited);
  return {
    limited: blocking.length > 0,
    resetMs: Math.max(0, ...blocking.map(r => r.resetMs)),
    // The guesses from elsewhere stay counted: only this attempt's hit is handed back.
    succeeded: async () => {
      await reset(pairKey);
      await release(userOnlyKey);
    },
  };
}
