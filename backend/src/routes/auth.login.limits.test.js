import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The real rate limiter, on its in-memory fallback: the Redis client below fails every command.
const { db } = vi.hoisted(() => ({ db: { users: {}, settings: {}, devices: [] } }));
vi.mock('../services/db.js', () => ({
  query: vi.fn(async (sql, params) => {
    if (sql.startsWith('SELECT * FROM users WHERE username')) {
      const user = db.users[params[0]];
      return { rows: user ? [user] : [] };
    }
    if (sql.includes('FROM system_settings')) {
      return { rows: Object.entries(db.settings).map(([key, value]) => ({ key, value })) };
    }
    if (sql.includes('FROM trusted_devices')) {
      return {
        rows: db.devices
          .filter(d => d.user_id === params[0] && d.token_hash === params[1] && (!params[2] || d.created_at > params[2]))
          .map(d => ({ id: d.id })),
      };
    }
    return { rows: [] };
  }),
  pool: {},
  withTransaction: vi.fn(),
}));
vi.mock('../index.js', () => ({ imapManager: { connectAllForUser: vi.fn() } }));
vi.mock('../services/encryption.js', () => ({ decrypt: value => value, encrypt: value => value }));
vi.mock('../services/pushNotifications.js', () => ({ pushConfigured: false }));
vi.mock('../services/hostValidation.js', () => ({ validateHost: vi.fn(), resolveForConnection: vi.fn() }));
vi.mock('../services/smtpTransport.js', () => ({ createSmtpTransport: vi.fn() }));
vi.mock('../services/connectionPolicy.js', () => ({ getConnectionPolicy: vi.fn() }));
vi.mock('../services/authLimiter.js', () => ({ authLimiterConfig: { maxRequests: 1000, windowMs: 900000 } }));
vi.mock('../services/authEvents.js', () => ({ logAuthEvent: vi.fn() }));
vi.mock('../services/mailer.js', () => ({ sendSystemEmail: vi.fn() }));
vi.mock('./oidc.js', () => ({ buildEndSessionUrl: vi.fn() }));
vi.mock('../services/categorizer.js', () => ({ invalidateGlobalCategorizationCache: vi.fn() }));
vi.mock('../services/redis.js', () => {
  const down = async () => { throw new Error('redis down'); };
  return { redisClient: { incr: down, pExpire: down, pTTL: down, del: down, decr: down, set: down } };
});
vi.mock('../services/userSessions.js', () => ({ destroyUserSessions: vi.fn() }));

import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import express from 'express';
import session from 'express-session';
import authRoutes from './auth.js';
import { authLimiterConfig } from '../services/authLimiter.js';
import { LOGIN_LIMITS } from '../services/loginLimiter.js';

let server;
let base;
beforeAll(async () => {
  const app = express();
  // Each test request says which client it is, as the tunnel in front would.
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use(session({ secret: 'x'.repeat(32), resave: false, saveUninitialized: false }));
  app.use('/api/auth', authRoutes);
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  await new Promise(resolve => server.close(resolve));
});

const user = (id, username, password) => ({
  id, username, password_hash: bcrypt.hashSync(password, 4), is_admin: false, totp_enabled: false,
});

let ipCounter = 0;
// A fresh address per test, so the in-memory buckets of one test never reach the next.
const freshIp = () => `198.51.100.${++ipCounter}`;
let nameCounter = 0;

beforeEach(() => {
  authLimiterConfig.maxRequests = 1000;
  nameCounter++;
  db.users = {
    [`alice${nameCounter}`]: user('u-alice', `alice${nameCounter}`, 'alice-password'),
    [`mallory${nameCounter}`]: user('u-mallory', `mallory${nameCounter}`, 'mallory-password'),
  };
  db.settings = {};
  db.devices = [];
});

const login = (username, password, ip, headers = {}) => fetch(`${base}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip, ...headers },
  body: JSON.stringify({ username, password }),
});

describe('POST /api/auth/login limits', () => {
  it('keeps counting guesses at another account between sign-ins of the guesser\'s own', async () => {
    const ip = freshIp();
    const alice = `alice${nameCounter}`;
    const mallory = `mallory${nameCounter}`;
    const statuses = [];
    for (let i = 0; i < LOGIN_LIMITS.perUserAndAddress.max + 1; i++) {
      statuses.push((await login(alice, `guess-${i}`, ip)).status);
      expect((await login(mallory, 'mallory-password', ip)).status).toBe(200);
    }
    expect(statuses.slice(0, -1).every(s => s === 401)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
    // Even the right password, from there.
    expect((await login(alice, 'alice-password', ip)).status).toBe(429);
    // Alice from her own address is not locked out by it.
    expect((await login(alice, 'alice-password', freshIp())).status).toBe(200);
  });

  it('does not let successful sign-ins wipe the address\'s failed attempts', async () => {
    authLimiterConfig.maxRequests = 4;
    const ip = freshIp();
    const statuses = [];
    // Guesses at different usernames, so only the per-address budget can stop them.
    for (let i = 0; i < 3; i++) {
      statuses.push((await login(`nobody-${nameCounter}-${i}`, 'guess', ip)).status);
      statuses.push((await login(`mallory${nameCounter}`, 'mallory-password', ip)).status);
    }
    statuses.push((await login(`nobody-${nameCounter}-3`, 'guess', ip)).status);
    // Four failures in the budget of four: the next attempt, whatever it is, waits.
    expect(statuses).toEqual([401, 200, 401, 200, 401, 200, 401]);
    expect((await login(`mallory${nameCounter}`, 'mallory-password', ip)).status).toBe(429);
   }, 30_000);

  it('limits guesses at one username spread over many addresses', async () => {
    const alice = `alice${nameCounter}`;
    for (let i = 0; i < LOGIN_LIMITS.perUser.max; i++) {
      expect((await login(alice, `guess-${i}`, freshIp())).status).toBe(401);
    }
    expect((await login(alice, 'alice-password', freshIp())).status).toBe(429);
    expect((await login(`mallory${nameCounter}`, 'mallory-password', freshIp())).status).toBe(200);
  });

  it('clears the counter of the account that signed in, from that address', async () => {
    const ip = freshIp();
    const alice = `alice${nameCounter}`;
    for (let i = 0; i < LOGIN_LIMITS.perUserAndAddress.max - 1; i++) {
      expect((await login(alice, `typo-${i}`, ip)).status).toBe(401);
    }
    expect((await login(alice, 'alice-password', ip)).status).toBe(200);
    for (let i = 0; i < LOGIN_LIMITS.perUserAndAddress.max; i++) {
      expect((await login(alice, `typo-${i}`, ip)).status).toBe(401);
    }
  });

  it('answers a username that does not exist exactly as one that does', async () => {
    const ip = freshIp();
    const alice = `alice${nameCounter}`;
    const ghost = `ghost${nameCounter}`;
    for (let i = 0; i < LOGIN_LIMITS.perUserAndAddress.max; i++) {
      await login(alice, `guess-${i}`, ip);
      await login(ghost, `guess-${i}`, ip);
    }
    const [real, missing] = [await login(alice, 'x', ip), await login(ghost, 'x', ip)];
    expect(real.status).toBe(429);
    expect(missing.status).toBe(429);
    expect(await missing.json()).toEqual(await real.json());
  }, 60_000);
});

describe('POST /api/auth/login with a trusted device', () => {
  const remembered = (token, daysAgo = 1) => {
    db.devices.push({
      id: 'device-1', user_id: 'u-alice', token_hash: crypto.createHash('sha256').update(token).digest('hex'),
      created_at: new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000),
    });
    db.users[`alice${nameCounter}`].totp_enabled = true;
  };

  it('skips the second factor while devices may be trusted', async () => {
    remembered('device-token');
    db.settings = { mfa_device_trust: '30d' };
    const res = await login(`alice${nameCounter}`, 'alice-password', freshIp(), { Cookie: 'mf_td=device-token' });
    expect(await res.json()).toMatchObject({ user: { id: 'u-alice' } });
  });

  it('asks for the second factor once the admin has set device trust to never', async () => {
    remembered('device-token');
    db.settings = { mfa_device_trust: 'never' };
    const res = await login(`alice${nameCounter}`, 'alice-password', freshIp(), { Cookie: 'mf_td=device-token' });
    expect(await res.json()).toEqual({ requiresTOTP: true, deviceTrustAvailable: false });
  });

  it('stops trusting a device remembered for longer than the duration the admin has since set', async () => {
    remembered('device-token', 10);
    db.settings = { mfa_device_trust: '7d' };
    const res = await login(`alice${nameCounter}`, 'alice-password', freshIp(), { Cookie: 'mf_td=device-token' });
    expect(await res.json()).toEqual({ requiresTOTP: true, deviceTrustAvailable: true });
  });
});
