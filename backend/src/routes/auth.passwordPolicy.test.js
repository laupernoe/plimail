import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Registration and a reset link set a password under the same rule as an admin does
// (utils/passwordPolicy.js): 8 characters at least, 72 bytes at most.
vi.mock('../services/db.js', () => ({ query: vi.fn(async () => ({ rows: [] })), pool: { connect: vi.fn() }, withTransaction: vi.fn() }));
vi.mock('../index.js', () => ({ imapManager: { connectAllForUser: vi.fn() } }));
vi.mock('../services/encryption.js', () => ({ decrypt: value => value, encrypt: value => value }));
vi.mock('../services/pushNotifications.js', () => ({ pushConfigured: false }));
vi.mock('../services/hostValidation.js', () => ({ validateHost: vi.fn(), resolveForConnection: vi.fn() }));
vi.mock('../services/smtpTransport.js', () => ({ createSmtpTransport: vi.fn() }));
vi.mock('../services/connectionPolicy.js', () => ({ getConnectionPolicy: vi.fn() }));
vi.mock('../services/authLimiter.js', () => ({ authLimiterConfig: { maxRequests: 10, windowMs: 900000 } }));
vi.mock('../services/authEvents.js', () => ({ logAuthEvent: vi.fn() }));
vi.mock('../services/mailer.js', () => ({ sendSystemEmail: vi.fn() }));
vi.mock('./oidc.js', () => ({ buildEndSessionUrl: vi.fn() }));
vi.mock('../services/categorizer.js', () => ({ invalidateGlobalCategorizationCache: vi.fn() }));
vi.mock('../services/redis.js', () => ({ redisClient: {} }));
vi.mock('../services/rateLimiter.js', () => ({ consume: vi.fn(async () => ({ limited: false })), reset: vi.fn(), release: vi.fn() }));
vi.mock('../services/userSessions.js', () => ({ destroyUserSessions: vi.fn() }));

import express from 'express';
import session from 'express-session';
import { pool, withTransaction } from '../services/db.js';
import authRoutes from './auth.js';
import { passwordProblem } from '../utils/passwordPolicy.js';

let server;
let base;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  app.use('/api/auth', authRoutes);
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  await new Promise(resolve => server.close(resolve));
});
beforeEach(() => {
  pool.connect.mockReset();
  withTransaction.mockReset();
});

const post = (path, body) => fetch(`${base}/api/auth${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

const BAD = ['1234567', 'ç'.repeat(37), 12345678];

describe('passwordProblem', () => {
  it('takes 8 characters to 72 bytes', () => {
    expect(passwordProblem('12345678')).toBeNull();
    expect(passwordProblem('a'.repeat(72))).toBeNull();
    expect(passwordProblem('ç'.repeat(36))).toBeNull();
    expect(passwordProblem('1234567')).toMatch(/at least 8/);
    expect(passwordProblem('a'.repeat(73))).toMatch(/at most 72 bytes/);
    expect(passwordProblem('ç'.repeat(37))).toMatch(/at most 72 bytes/);
    expect(passwordProblem(undefined)).toMatch(/at least 8/);
  });
});

describe('setting a password', () => {
  it('refuses to register with a password outside the rule, before touching the database', async () => {
    for (const password of BAD) {
      const res = await post('/register', { username: 'maria', password });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/Password must be/);
    }
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('refuses a reset to a password outside the rule, leaving the link unspent', async () => {
    for (const password of [...BAD, 'a'.repeat(73)]) {
      const res = await post('/reset-password', { token: 'a'.repeat(64), password });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/Password must be/);
    }
    expect(withTransaction).not.toHaveBeenCalled();
  });
});
