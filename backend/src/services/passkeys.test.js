import { describe, expect, it, vi } from 'vitest';

vi.mock('./redis.js', () => ({ redisClient: { set: vi.fn(async () => 'OK') } }));

import { cleanPasskeyName, relyingParty, rememberChallenge, takeChallenge, userHandleBase64Url } from './passkeys.js';

describe('relyingParty', () => {
  it('takes the RP ID and origin from APP_URL', () => {
    expect(relyingParty({ APP_URL: 'https://mail.kxn.ch' })).toEqual({ available: true, rpId: 'mail.kxn.ch', origins: ['https://mail.kxn.ch'] });
    expect(relyingParty({ APP_URL: 'https://mail.example.com:8443/' })).toEqual({ available: true, rpId: 'mail.example.com', origins: ['https://mail.example.com:8443'] });
  });

  it('adds FRONTEND_URL only when it is the same host', () => {
    expect(relyingParty({ APP_URL: 'http://localhost:3000', FRONTEND_URL: 'http://localhost:5173' }).origins)
      .toEqual(['http://localhost:3000', 'http://localhost:5173']);
    expect(relyingParty({ APP_URL: 'https://mail.example.com', FRONTEND_URL: 'https://evil.example' }).origins)
      .toEqual(['https://mail.example.com']);
  });

  it('is unavailable at an IP address, which cannot be an RP ID', () => {
    expect(relyingParty({ APP_URL: 'https://192.168.1.20:9443' })).toEqual({ available: false, reason: 'ip' });
    expect(relyingParty({ APP_URL: 'https://[fd00::1]:9443' })).toEqual({ available: false, reason: 'ip' });
  });

  it('is unavailable over plain HTTP except on localhost', () => {
    expect(relyingParty({ APP_URL: 'http://mail.example.com' })).toEqual({ available: false, reason: 'insecure' });
    expect(relyingParty({ APP_URL: 'http://localhost:5173' }).available).toBe(true);
  });

  it('is unavailable without APP_URL', () => {
    expect(relyingParty({})).toEqual({ available: false, reason: 'noAppUrl' });
    expect(relyingParty({ APP_URL: 'not a url' })).toEqual({ available: false, reason: 'noAppUrl' });
  });
});

describe('challenges', () => {
  it('are taken once, for their purpose, before they expire', async () => {
    const session = { userId: 'u1' };
    rememberChallenge(session, 'login', 'c1', { now: 1000 });
    expect(await takeChallenge(session, 'register', { now: 1001 })).toBeNull();
    expect(session.passkeyChallenge).toBeUndefined();

    rememberChallenge(session, 'login', 'c2', { now: 1000 });
    expect(await takeChallenge(session, 'login', { now: 1000 + 5 * 60 * 1000 })).toBeNull();

    rememberChallenge(session, 'login', 'c3', { now: 1000 });
    expect(await takeChallenge(session, 'login', { now: 2000 })).toBe('c3');
    expect(await takeChallenge(session, 'login', { now: 2000 })).toBeNull();
  });
});

describe('names and handles', () => {
  it('keeps a name on one line, within the limit', () => {
    expect(cleanPasskeyName(' Work\n\tlaptop ')).toBe('Work laptop');
    expect(cleanPasskeyName('x'.repeat(100))).toHaveLength(64);
    expect(cleanPasskeyName(42)).toBe('');
  });

  it('makes the user handle from the user id\'s bytes', () => {
    expect(Buffer.from(userHandleBase64Url('11111111-1111-4111-8111-111111111111'), 'base64url')).toHaveLength(16);
  });
});
