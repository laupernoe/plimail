import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The passkey routes over HTTP, with the real @simplewebauthn/server verification: the responses
// come from a software authenticator (passkeys.fixtures.js), so a refusal here is the library and
// the route refusing what an attacker or a copied key would send. The database is an in-memory
// stand-in; Redis keeps the SET NX claims and fails the rate limiter's commands, which then counts
// in memory, as it does when Redis is down.
const { db, redis } = vi.hoisted(() => ({
  db: { users: new Map(), passkeys: [], settings: {} },
  redis: { keys: new Set() },
}));

vi.mock('../services/db.js', () => {
  const view = p => ({ id: p.id, name: p.name, created_at: p.created_at, last_used_at: p.last_used_at, backed_up: p.backed_up });
  return {
    query: vi.fn(async (sql, params = []) => {
      const text = sql.replace(/\s+/g, ' ').trim();
      if (text.includes('FROM system_settings')) {
        return { rows: Object.entries(db.settings).filter(([key]) => text.includes(`'${key}'`)).map(([key, value]) => ({ key, value })) };
      }
      if (text.startsWith('SELECT id FROM users WHERE id')) return { rows: db.users.has(params[0]) ? [{ id: params[0] }] : [] };
      if (text.includes('FROM users WHERE id')) return { rows: db.users.has(params[0]) ? [db.users.get(params[0])] : [] };
      if (text.startsWith('UPDATE users SET last_seen_at')) return { rows: [], rowCount: 1 };
      if (text.startsWith('SELECT * FROM passkeys WHERE credential_id')) {
        return { rows: db.passkeys.filter(p => p.credential_id === params[0]) };
      }
      if (text.startsWith('SELECT credential_id, transports FROM passkeys')) {
        return { rows: db.passkeys.filter(p => p.user_id === params[0]) };
      }
      if (text.startsWith('SELECT id, name, created_at')) {
        return { rows: db.passkeys.filter(p => p.user_id === params[0]).map(view) };
      }
      if (text.startsWith('UPDATE passkeys SET counter')) {
        const p = db.passkeys.find(row => row.id === params[0]);
        if (!p || !(p.counter < params[1] || (p.counter === 0 && params[1] === 0))) return { rows: [], rowCount: 0 };
        Object.assign(p, { counter: params[1], backed_up: params[2], last_used_at: new Date().toISOString() });
        return { rows: [], rowCount: 1 };
      }
      if (text.startsWith('INSERT INTO passkeys')) {
        const [userId, credentialId, publicKey, counter, transports, deviceType, backedUp, aaguid, name, max] = params;
        if (db.passkeys.some(p => p.credential_id === credentialId)) return { rows: [] };
        if (db.passkeys.filter(p => p.user_id === userId).length >= max) return { rows: [] };
        const row = {
          id: crypto.randomUUID(), user_id: userId, credential_id: credentialId, public_key: publicKey, counter,
          transports: JSON.parse(transports), device_type: deviceType, backed_up: backedUp, aaguid, name,
          created_at: new Date().toISOString(), last_used_at: null,
        };
        db.passkeys.push(row);
        return { rows: [view(row)] };
      }
      if (text.startsWith('UPDATE passkeys SET name')) {
        const p = db.passkeys.find(row => row.id === params[0] && row.user_id === params[1]);
        if (!p) return { rows: [] };
        p.name = params[2];
        return { rows: [view(p)] };
      }
      if (text.startsWith('DELETE FROM passkeys')) {
        const before = db.passkeys.length;
        db.passkeys = db.passkeys.filter(p => !(p.id === params[0] && p.user_id === params[1]));
        return { rows: [], rowCount: before - db.passkeys.length };
      }
      throw new Error(`unexpected query: ${text}`);
    }),
    withTransaction: vi.fn(),
  };
});
vi.mock('../services/redis.js', () => {
  const down = async () => { throw new Error('redis down'); };
  return {
    redisClient: {
      incr: down, pExpire: down, pTTL: down, del: down, decr: down,
      set: vi.fn(async (key, _value, opts) => {
        if (opts?.NX && redis.keys.has(key)) return null;
        redis.keys.add(key);
        return 'OK';
      }),
    },
  };
});
vi.mock('../index.js', () => ({ imapManager: { connectAllForUser: vi.fn() } }));
vi.mock('../services/authEvents.js', () => ({ logAuthEvent: vi.fn() }));
vi.mock('../services/authLimiter.js', () => ({ authLimiterConfig: { maxRequests: 1000, windowMs: 900000 } }));
vi.mock('../services/encryption.js', () => ({ decrypt: v => v, encrypt: v => v }));

import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import express from 'express';
import session from 'express-session';
import passkeyRoutes from './passkeys.js';
import { imapManager } from '../index.js';
import { logAuthEvent } from '../services/authEvents.js';
import { LOGIN_LIMITS } from '../services/loginLimiter.js';
import { userHandleBase64Url } from '../services/passkeys.js';
import { softAuthenticator } from '../services/passkeys.fixtures.js';

// Each test runs several ceremonies, each with real signatures and a bcrypt check.
vi.setConfig({ testTimeout: 30_000 });

const RP_ID = 'mail.example.com';
const ORIGIN = `https://${RP_ID}`;
const PASSWORD = 'correct horse battery';

let server;
let base;
beforeAll(async () => {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use(session({ secret: 'x'.repeat(32), resave: false, saveUninitialized: false }));
  // Stands in for a password sign-in, and reads back who the session is.
  app.post('/test/signin', (req, res) => { req.session.userId = req.body.userId; req.session.username = req.body.username; res.json({ ok: true }); });
  app.get('/test/whoami', (req, res) => res.json({ userId: req.session.userId || null, sessionId: req.sessionID }));
  app.use('/api/passkeys', passkeyRoutes);
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  await new Promise(resolve => server.close(resolve));
});

let ipCounter = 0;
let ip;
const env = { APP_URL: process.env.APP_URL, FRONTEND_URL: process.env.FRONTEND_URL };
afterAll(() => {
  for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

const PASSWORD_HASH = bcrypt.hashSync(PASSWORD, 4);
const addUser = (id, username, extra = {}) => {
  db.users.set(id, {
    id, username, password_hash: PASSWORD_HASH, display_name: null, avatar: null, is_admin: false,
    totp_enabled: false, totp_secret: null, ...extra,
  });
};

beforeEach(() => {
  process.env.APP_URL = ORIGIN;
  delete process.env.FRONTEND_URL;
  db.users = new Map();
  db.passkeys = [];
  db.settings = {};
  redis.keys = new Set();
  ip = `198.51.100.${++ipCounter}`;
  addUser('11111111-1111-4111-8111-111111111111', `alice${ipCounter}`);
  addUser('22222222-2222-4222-8222-222222222222', `bob${ipCounter}`);
  vi.mocked(logAuthEvent).mockClear();
  vi.mocked(imapManager.connectAllForUser).mockClear();
});
const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';

// A browser: keeps its session cookie.
function browser() {
  let cookie = '';
  const call = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip, ...(cookie ? { Cookie: cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    let json = null;
    try { json = await res.json(); } catch { /* no body */ }
    return { status: res.status, body: json };
  };
  return {
    call,
    get cookie() { return cookie; },
    set cookie(value) { cookie = value; },
    signIn: async (userId) => call('POST', '/test/signin', { userId, username: db.users.get(userId).username }),
  };
}

// Alice, signed in with her password, adds a passkey made by `authenticator`.
async function addPasskey(authenticator, userId = ALICE, name = 'Laptop') {
  const b = browser();
  await b.signIn(userId);
  const options = await b.call('POST', '/api/passkeys/registration/options', { password: PASSWORD });
  expect(options.status).toBe(200);
  const added = await b.call('POST', '/api/passkeys/registration/verify', { response: authenticator.register(options.body.options), name });
  expect(added.status).toBe(201);
  return added.body.passkey;
}

const newAuthenticator = (userId = ALICE, opts = {}) => softAuthenticator({ rpId: RP_ID, userHandle: userHandleBase64Url(userId), ...opts });

async function signInWith(authenticator, answer = {}) {
  const b = browser();
  const options = await b.call('POST', '/api/passkeys/login/options');
  expect(options.status).toBe(200);
  const response = authenticator.authenticate(options.body.options, answer);
  const result = await b.call('POST', '/api/passkeys/login/verify', { response });
  return { b, result, response, options: options.body.options };
}

describe('adding a passkey', () => {
  it('asks for the password first, then stores the passkey with its name', async () => {
    const b = browser();
    await b.signIn(ALICE);
    expect((await b.call('POST', '/api/passkeys/registration/options', {})).status).toBe(400);
    const wrong = await b.call('POST', '/api/passkeys/registration/options', { password: 'nope' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.reauth).toBe('password');

    const options = await b.call('POST', '/api/passkeys/registration/options', { password: PASSWORD });
    expect(options.status).toBe(200);
    expect(options.body.options.rp.id).toBe(RP_ID);
    expect(options.body.options.authenticatorSelection).toMatchObject({ residentKey: 'required', userVerification: 'required' });
    expect(options.body.options.user.id).toBe(userHandleBase64Url(ALICE));

    const authenticator = newAuthenticator();
    const added = await b.call('POST', '/api/passkeys/registration/verify', { response: authenticator.register(options.body.options), name: '  My\nphone ' });
    expect(added.status).toBe(201);
    expect(added.body.passkey).toMatchObject({ name: 'My phone', lastUsedAt: null });
    expect(db.passkeys).toHaveLength(1);
    expect(db.passkeys[0]).toMatchObject({ user_id: ALICE, credential_id: authenticator.id, counter: 0 });
    expect(logAuthEvent).toHaveBeenCalledWith('passkey_added', expect.objectContaining({ userId: ALICE }));

    const list = await b.call('GET', '/api/passkeys');
    expect(list.body.passkeys).toEqual([expect.objectContaining({ name: 'My phone', createdAt: expect.any(String), lastUsedAt: null })]);
  });

  it('refuses a registration answer replayed against the same challenge', async () => {
    const b = browser();
    await b.signIn(ALICE);
    const options = await b.call('POST', '/api/passkeys/registration/options', { password: PASSWORD });
    const response = newAuthenticator().register(options.body.options);
    expect((await b.call('POST', '/api/passkeys/registration/verify', { response })).status).toBe(201);
    const again = await b.call('POST', '/api/passkeys/registration/verify', { response: newAuthenticator().register(options.body.options) });
    expect(again.status).toBe(400);
    expect(again.body.code).toBe('challenge');
    expect(db.passkeys).toHaveLength(1);
  });

  it('refuses a passkey made on another origin', async () => {
    const b = browser();
    await b.signIn(ALICE);
    const options = await b.call('POST', '/api/passkeys/registration/options', { password: PASSWORD });
    const response = newAuthenticator().register(options.body.options, { origin: 'https://evil.example' });
    const res = await b.call('POST', '/api/passkeys/registration/verify', { response });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('rejected');
    expect(db.passkeys).toHaveLength(0);
  });

  it('refuses a passkey without user verification', async () => {
    const b = browser();
    await b.signIn(ALICE);
    const options = await b.call('POST', '/api/passkeys/registration/options', { password: PASSWORD });
    const response = newAuthenticator().register(options.body.options, { userVerified: false });
    expect((await b.call('POST', '/api/passkeys/registration/verify', { response })).status).toBe(400);
  });

  it('does not take a challenge made for another user of the same browser', async () => {
    const b = browser();
    await b.signIn(ALICE);
    const options = await b.call('POST', '/api/passkeys/registration/options', { password: PASSWORD });
    await b.signIn(BOB);
    const res = await b.call('POST', '/api/passkeys/registration/verify', { response: newAuthenticator(BOB).register(options.body.options) });
    expect(res.status).toBe(400);
    expect(db.passkeys).toHaveLength(0);
  });

  it('needs a password on the account, and password sign-in left on', async () => {
    addUser(ALICE, `alice${ipCounter}`, { password_hash: null });
    const b = browser();
    await b.signIn(ALICE);
    const noPassword = await b.call('POST', '/api/passkeys/registration/options', { password: PASSWORD });
    expect(noPassword.status).toBe(403);
    expect(noPassword.body.code).toBe('noPassword');

    addUser(ALICE, `alice${ipCounter}`);
    db.settings.internal_auth_disabled = 'true';
    const off = await b.call('POST', '/api/passkeys/registration/options', { password: PASSWORD });
    expect(off.status).toBe(403);
    expect(off.body.code).toBe('passwordLoginOff');
  });

  it('is refused when signed out', async () => {
    expect((await browser().call('POST', '/api/passkeys/registration/options', { password: PASSWORD })).status).toBe(401);
  });
});

describe('signing in with a passkey', () => {
  it('opens a session for the passkey\'s user, without the two-factor step', async () => {
    addUser(ALICE, `alice${ipCounter}`, { totp_enabled: true, totp_secret: 'SECRET' });
    db.settings.mfa_enforcement = 'required';
    const authenticator = newAuthenticator();
    await addPasskey(authenticator);
    const { b, result } = await signInWith(authenticator);
    expect(result.status).toBe(200);
    expect(result.body.user).toMatchObject({ id: ALICE, username: `alice${ipCounter}`, totpEnabled: true });
    expect(result.body.requiresTOTP).toBeUndefined();
    expect((await b.call('GET', '/test/whoami')).body.userId).toBe(ALICE);
    expect(imapManager.connectAllForUser).toHaveBeenCalledWith(ALICE);
    expect(logAuthEvent).toHaveBeenCalledWith('login_success', expect.objectContaining({ userId: ALICE, success: true }));
    expect(db.passkeys[0].counter).toBe(1);
    expect(db.passkeys[0].last_used_at).toEqual(expect.any(String));
  });

  it('gives the session a new id', async () => {
    const authenticator = newAuthenticator();
    await addPasskey(authenticator);
    const b = browser();
    const options = await b.call('POST', '/api/passkeys/login/options');
    const before = (await b.call('GET', '/test/whoami')).body.sessionId;
    expect((await b.call('POST', '/api/passkeys/login/verify', { response: authenticator.authenticate(options.body.options) })).status).toBe(200);
    expect((await b.call('GET', '/test/whoami')).body.sessionId).not.toBe(before);
  });

  it('accepts authenticators that keep no counter', async () => {
    const authenticator = newAuthenticator();
    await addPasskey(authenticator);
    expect((await signInWith(authenticator, { counter: 0 })).result.status).toBe(200);
    expect((await signInWith(authenticator, { counter: 0 })).result.status).toBe(200);
  });

  it('refuses a challenge used twice', async () => {
    const authenticator = newAuthenticator();
    await addPasskey(authenticator);
    const b = browser();
    const options = await b.call('POST', '/api/passkeys/login/options');
    const cookie = b.cookie;
    const first = await b.call('POST', '/api/passkeys/login/verify', { response: authenticator.authenticate(options.body.options) });
    expect(first.status).toBe(200);
    // The same session as it was before the sign-in, challenge and all, with a fresh signature.
    b.cookie = cookie;
    const replay = await b.call('POST', '/api/passkeys/login/verify', { response: authenticator.authenticate(options.body.options) });
    expect(replay.status).toBe(400);
    expect(replay.body.code).toBe('challenge');
  });

  it('lets only one of two requests sent together with one challenge through', async () => {
    const authenticator = newAuthenticator();
    await addPasskey(authenticator);
    const b = browser();
    const options = await b.call('POST', '/api/passkeys/login/options');
    const cookie = b.cookie;
    const tab = () => { const c = browser(); c.cookie = cookie; return c; };
    const responses = [authenticator.authenticate(options.body.options), authenticator.authenticate(options.body.options)];
    const results = await Promise.all(responses.map(response => tab().call('POST', '/api/passkeys/login/verify', { response })));
    expect(results.map(r => r.status).sort()).toEqual([200, 400]);
  });

  it('refuses a challenge older than five minutes', async () => {
    const authenticator = newAuthenticator();
    await addPasskey(authenticator);
    const b = browser();
    const now = Date.now();
    const spy = vi.spyOn(Date, 'now').mockReturnValue(now - 6 * 60 * 1000);
    const options = await b.call('POST', '/api/passkeys/login/options');
    spy.mockRestore();
    const res = await b.call('POST', '/api/passkeys/login/verify', { response: authenticator.authenticate(options.body.options) });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('challenge');
  });

  it('refuses an answer signed for another origin', async () => {
    const authenticator = newAuthenticator();
    await addPasskey(authenticator);
    const { b, result } = await signInWith(authenticator, { origin: 'https://mail.example.com.evil.example' });
    expect(result.status).toBe(401);
    expect((await b.call('GET', '/test/whoami')).body.userId).toBeNull();
    expect(logAuthEvent).toHaveBeenCalledWith('login_fail', expect.objectContaining({ userId: ALICE, success: false }));
  });

  it('refuses an answer for another RP ID', async () => {
    const authenticator = newAuthenticator();
    await addPasskey(authenticator);
    expect((await signInWith(authenticator, { rpId: 'evil.example' })).result.status).toBe(401);
  });

  it('refuses a counter that goes back or stays, and says so in the log', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const authenticator = newAuthenticator();
    await addPasskey(authenticator);
    expect((await signInWith(authenticator, { counter: 5 })).result.status).toBe(200);
    expect(db.passkeys[0].counter).toBe(5);
    const back = await signInWith(authenticator, { counter: 3 });
    expect(back.result.status).toBe(401);
    expect((await back.b.call('GET', '/test/whoami')).body.userId).toBeNull();
    expect((await signInWith(authenticator, { counter: 5 })).result.status).toBe(401);
    expect(db.passkeys[0].counter).toBe(5);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('may have been copied'));
    warn.mockRestore();
  });

  it('refuses an answer without user verification', async () => {
    const authenticator = newAuthenticator();
    await addPasskey(authenticator);
    expect((await signInWith(authenticator, { userVerified: false })).result.status).toBe(401);
  });

  it('refuses a passkey whose user handle names another account', async () => {
    const authenticator = newAuthenticator();
    await addPasskey(authenticator);
    expect((await signInWith(authenticator, { handle: userHandleBase64Url(BOB) })).result.status).toBe(401);
  });

  it('refuses a passkey nobody added', async () => {
    const { result } = await signInWith(newAuthenticator());
    expect(result.status).toBe(401);
  });

  it('refuses an account that is gone', async () => {
    const authenticator = newAuthenticator();
    await addPasskey(authenticator);
    db.users.delete(ALICE);
    expect((await signInWith(authenticator)).result.status).toBe(401);
  });

  it('refuses everyone while password sign-in is turned off', async () => {
    const authenticator = newAuthenticator();
    await addPasskey(authenticator);
    const b = browser();
    const options = await b.call('POST', '/api/passkeys/login/options');
    db.settings.internal_auth_disabled = 'true';
    const res = await b.call('POST', '/api/passkeys/login/verify', { response: authenticator.authenticate(options.body.options) });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('passwordLoginOff');
    expect((await b.call('GET', '/test/whoami')).body.userId).toBeNull();
    expect((await browser().call('POST', '/api/passkeys/login/options')).status).toBe(403);
  });

  it('counts failures against the account\'s sign-in limit', async () => {
    const authenticator = newAuthenticator();
    await addPasskey(authenticator);
    const statuses = [];
    for (let i = 0; i < LOGIN_LIMITS.perUserAndAddress.max; i++) {
      statuses.push((await signInWith(authenticator, { origin: 'https://evil.example' })).result.status);
    }
    expect(statuses.every(s => s === 401)).toBe(true);
    const limited = await signInWith(authenticator);
    expect(limited.result.status).toBe(429);
    expect(limited.result.body.user).toBeUndefined();
  });
});

describe('managing passkeys', () => {
  it('renames without the password, and only the user\'s own', async () => {
    const passkey = await addPasskey(newAuthenticator());
    const alice = browser();
    await alice.signIn(ALICE);
    const renamed = await alice.call('PATCH', `/api/passkeys/${passkey.id}`, { name: 'Work laptop' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.passkey.name).toBe('Work laptop');
    expect((await alice.call('PATCH', `/api/passkeys/${passkey.id}`, { name: '   ' })).status).toBe(400);

    const bob = browser();
    await bob.signIn(BOB);
    expect((await bob.call('PATCH', `/api/passkeys/${passkey.id}`, { name: 'Mine now' })).status).toBe(404);
    expect(db.passkeys[0].name).toBe('Work laptop');
  });

  it('removes only with the password', async () => {
    const passkey = await addPasskey(newAuthenticator());
    const bob = browser();
    await bob.signIn(BOB);
    expect((await bob.call('DELETE', `/api/passkeys/${passkey.id}`, { password: PASSWORD })).status).toBe(404);

    const alice = browser();
    await alice.signIn(ALICE);
    expect((await alice.call('DELETE', `/api/passkeys/${passkey.id}`, {})).status).toBe(400);
    expect((await alice.call('DELETE', `/api/passkeys/${passkey.id}`, { password: 'wrong' })).status).toBe(400);
    expect(db.passkeys).toHaveLength(1);
    expect((await alice.call('DELETE', `/api/passkeys/${passkey.id}`, { password: PASSWORD })).status).toBe(200);
    expect(db.passkeys).toHaveLength(0);
    expect(logAuthEvent).toHaveBeenCalledWith('passkey_removed', expect.objectContaining({ userId: ALICE }));
  });
});

describe('where passkeys cannot work', () => {
  it('says so for an address that is an IP, and makes no challenge', async () => {
    process.env.APP_URL = 'https://192.168.1.20:9443';
    const b = browser();
    expect((await b.call('GET', '/api/passkeys/status')).body).toEqual({ available: false, reason: 'ip' });
    const options = await b.call('POST', '/api/passkeys/login/options');
    expect(options.status).toBe(409);
    expect(options.body).toMatchObject({ code: 'unavailable', reason: 'ip' });
  });

  it('gives the RP ID where they do', async () => {
    expect((await browser().call('GET', '/api/passkeys/status')).body).toEqual({ available: true, rpId: RP_ID });
  });
});
