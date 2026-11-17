import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => {
  const query = vi.fn();
  // The transaction client runs its statements through the same mock, so they are recorded in order.
  return { query, pool: {}, withTransaction: vi.fn(async fn => fn({ query, inTransaction: true })) };
});
vi.mock('../index.js', () => ({ imapManager: {} }));
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
vi.mock('../services/pgpKeyring.js', async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, setKeysProtection: vi.fn(async () => 1) };
});

import express from 'express';
import bcrypt from 'bcryptjs';
import authRoutes from './auth.js';
import { query, withTransaction } from '../services/db.js';
import { consume, release, reset } from '../services/rateLimiter.js';
import { destroyUserSessions } from '../services/userSessions.js';
import { PgpRequestError, setKeysProtection } from '../services/pgpKeyring.js';
import { consumeLoginAttempt } from '../services/loginLimiter.js';

// Settings → Security: a user changes their own password, giving the current one. The keys that
// unlock with it come in the same request and are stored in the same transaction.
const USER = 'aaaaaaaa-0000-4000-8000-000000000001';
const KEY = 'bbbbbbbb-0000-4000-8000-000000000002';
const OLD = 'old password';
const OLD_HASH = bcrypt.hashSync(OLD, 4);
let server;
let base;
let stored;
let statements;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = { userId: USER }; req.sessionID = 'current-session'; next(); });
  app.use('/api/auth', authRoutes);
  await new Promise(resolve => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise(resolve => server.close(resolve));
});

beforeEach(() => {
  vi.clearAllMocks();
  stored = OLD_HASH;
  statements = [];
  query.mockImplementation(async (sql, params) => {
    statements.push(sql);
    if (sql.startsWith('SELECT username, password_hash FROM users')) return { rows: [{ username: 'Ann', password_hash: stored }] };
    if (sql.startsWith('SELECT password_hash FROM users')) return { rows: [{ password_hash: stored }] };
    if (sql.startsWith('UPDATE users SET password_hash')) stored = params[0];
    return { rows: [] };
  });
});

const change = body => fetch(`${base}/api/auth/password`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

describe('POST /api/auth/password', { timeout: 30000 }, () => {
  it('sets the new password, keeps this session and ends every other one', async () => {
    const res = await change({ currentPassword: OLD, newPassword: 'new password' });
    expect(res.status).toBe(200);
    expect(await bcrypt.compare('new password', stored)).toBe(true);
    expect(statements).toContain('DELETE FROM password_reset_tokens WHERE user_id = $1');
    expect(statements).toContain('DELETE FROM email_otp_tokens WHERE user_id = $1');
    expect(destroyUserSessions).toHaveBeenCalledWith(USER, { exceptSessionId: 'current-session' });
    expect(setKeysProtection).not.toHaveBeenCalled();
  });

  it('refuses a wrong current password, counting it against the account as a failed sign-in', async () => {
    consume.mockClear();
    await consumeLoginAttempt('ann', '127.0.0.1');
    const expected = consume.mock.calls.map(c => c[0]);
    consume.mockClear();
    reset.mockClear();
    release.mockClear();

    const res = await change({ currentPassword: 'wrong', newPassword: 'new password' });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('wrong_password');
    expect(consume.mock.calls.map(c => c[0])).toEqual(expected);
    expect(reset).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(stored).toBe(OLD_HASH);
    expect(withTransaction).not.toHaveBeenCalled();
    expect(destroyUserSessions).not.toHaveBeenCalled();

    // A right one hands its own attempt back, as a sign-in does.
    await change({ currentPassword: OLD, newPassword: 'new password' });
    expect(reset).toHaveBeenCalledWith(expected[0]);
    expect(release).toHaveBeenCalledWith(expected[1]);
  });

  it('stops at the sign-in limit before looking at the password', async () => {
    consume.mockResolvedValueOnce({ limited: true, resetMs: 7000 });
    const res = await change({ currentPassword: OLD, newPassword: 'new password' });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('7');
    expect(stored).toBe(OLD_HASH);
  });

  it('holds the new password to the policy, before spending an attempt', async () => {
    for (const newPassword of ['short', 'a'.repeat(73), undefined]) {
      const res = await change({ currentPassword: OLD, newPassword });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/Password must be/);
    }
    expect(consume).not.toHaveBeenCalled();
    expect(stored).toBe(OLD_HASH);
  });

  it('refuses an SSO-only user, who has no password to change', async () => {
    stored = null;
    const res = await change({ currentPassword: 'anything', newPassword: 'new password' });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('no_password');
    expect(consume).not.toHaveBeenCalled();
  });

  it('stores the re-encrypted keys in the same transaction as the password', async () => {
    const pgpKeys = [{ id: KEY, armoredPrivate: 'armored', protection: 'login' }];
    const res = await change({ currentPassword: OLD, newPassword: 'new password', pgpKeys });
    expect(res.status).toBe(200);
    expect(setKeysProtection).toHaveBeenCalledWith(USER, pgpKeys, { client: expect.objectContaining({ inTransaction: true }) });
    expect(withTransaction).toHaveBeenCalledTimes(1);
  });

  it('leaves the password as it was when the keys are refused', async () => {
    setKeysProtection.mockRejectedValueOnce(new PgpRequestError(400, 'The private key is not this key', 'invalid_key'));
    const res = await change({ currentPassword: OLD, newPassword: 'new password', pgpKeys: [{ id: KEY, armoredPrivate: 'x', protection: 'login' }] });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('invalid_key');
    expect(statements.some(s => s.startsWith('UPDATE users SET password_hash'))).toBe(false);
    expect(destroyUserSessions).not.toHaveBeenCalled();
  });

  it('refuses a change that another one overtook between the check and the transaction', async () => {
    query.mockImplementation(async (sql) => {
      statements.push(sql);
      if (sql.startsWith('SELECT username, password_hash FROM users')) return { rows: [{ username: 'Ann', password_hash: OLD_HASH }] };
      if (sql.startsWith('SELECT password_hash FROM users')) return { rows: [{ password_hash: 'someone else changed it' }] };
      return { rows: [] };
    });
    const res = await change({ currentPassword: OLD, newPassword: 'new password', pgpKeys: [{ id: KEY, armoredPrivate: 'x', protection: 'login' }] });
    expect(res.status).toBe(409);
    expect(setKeysProtection).not.toHaveBeenCalled();
    expect(statements.some(s => s.startsWith('UPDATE users SET password_hash'))).toBe(false);
    expect(destroyUserSessions).not.toHaveBeenCalled();
  });
});
