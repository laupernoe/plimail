import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// A stand-in for pgp_keys and pgp_public_keys, answering the SQL services/pgpKeyring.js sends.
const { db, wkd } = vi.hoisted(() => ({
  db: { own: [], ring: [], accounts: new Map(), users: new Map(), seq: 0 },
  wkd: { answers: new Map(), calls: [] },
}));
vi.mock('../services/db.js', () => {
  const id = () => `00000000-0000-4000-8000-${String(++db.seq).padStart(12, '0')}`;
  const query = vi.fn(async (sql, p = []) => {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (s.startsWith('UPDATE users SET pgp_kdf_salt')) {
        const u = db.users.get(p[0]);
        if (!u) return { rows: [] };
        u.pgp_kdf_salt = u.pgp_kdf_salt ?? p[1];
        return { rows: [{ pgp_kdf_salt: u.pgp_kdf_salt }] };
      }
      if (s.startsWith('SELECT username, password_hash FROM users')) {
        const u = db.users.get(p[0]);
        return { rows: u ? [{ username: u.username ?? p[0], password_hash: u.password_hash ?? null }] : [] };
      }
      if (s.startsWith('UPDATE pgp_keys SET auto_email = NULL')) {
        for (const k of db.own) if (k.user_id === p[0] && k.auto_email === p[1] && k.stale_at) k.auto_email = null;
        return { rows: [], rowCount: 0 };
      }
      if (s.startsWith('UPDATE pgp_keys SET stale_at')) {
        const k = db.own.find(r => r.id === p[0] && r.user_id === p[1] && r.protection === 'login');
        if (k) k.stale_at = p[2] ? (k.stale_at || new Date()) : null;
        return { rows: [], rowCount: k ? 1 : 0 };
      }
      if (s.startsWith('INSERT INTO pgp_keys') && s.includes('WHERE NOT EXISTS')) {
        if (db.own.some(k => k.user_id === p[0] && (k.fingerprint === p[2] || (k.emails.includes(p[10]) && !k.stale_at) || k.auto_email === p[10]))) return { rows: [] };
        const row = {
          id: id(), user_id: p[0], account_id: p[1], fingerprint: p[2], emails: JSON.parse(p[3]), user_ids: JSON.parse(p[4]),
          algorithm: p[5], armored_public: p[6], armored_private: p[7], key_created_at: p[8], created_at: new Date(), protection: p[9], auto_email: p[10],
        };
        db.own.push(row);
        return { rows: [row] };
      }
      if (s.startsWith('SELECT id, fingerprint, armored_public FROM pgp_keys WHERE user_id = $1 AND id = ANY')) {
        return { rows: db.own.filter(k => k.user_id === p[0] && p[1].includes(k.id)) };
      }
      if (s.startsWith('UPDATE pgp_keys SET armored_private')) {
        const k = db.own.find(r => r.id === p[0] && r.user_id === p[1]);
        if (k) { k.armored_private = p[2]; k.protection = p[3]; k.stale_at = null; }
        return { rowCount: k ? 1 : 0, rows: [] };
      }
      if (s.startsWith('SELECT id FROM email_accounts')) {
        const a = db.accounts.get(p[1] ?? p[0]);
        return { rows: a && (a.user_id === p[0] || a.user_id === p[1]) ? [{ id: a.id }] : [] };
      }
      if (s.startsWith('SELECT COUNT(*)::int AS n FROM pgp_keys')) return { rows: [{ n: db.own.filter(k => k.user_id === p[0]).length }] };
      if (s.startsWith('SELECT COUNT(*)::int AS n FROM pgp_public_keys')) return { rows: [{ n: db.ring.filter(k => k.user_id === p[0]).length }] };
      if (s.startsWith('SELECT id, account_id, fingerprint') && s.includes('FROM pgp_keys WHERE user_id = $1')) {
        return { rows: db.own.filter(k => k.user_id === p[0]) };
      }
      if (s.startsWith('INSERT INTO pgp_keys')) {
        if (db.own.some(k => k.user_id === p[0] && k.fingerprint === p[2])) return { rows: [] };
        const row = {
          id: id(), user_id: p[0], account_id: p[1], fingerprint: p[2], emails: JSON.parse(p[3]), user_ids: JSON.parse(p[4]),
          algorithm: p[5], armored_public: p[6], armored_private: p[7], key_created_at: p[8], created_at: new Date(), protection: p[9], auto_email: null,
        };
        db.own.push(row);
        return { rows: [row] };
      }
      if (s.startsWith('DELETE FROM pgp_keys WHERE id = $1 AND user_id = $2')) {
        const i = db.own.findIndex(k => k.id === p[0] && k.user_id === p[1]);
        if (i < 0) return { rows: [] };
        db.own.splice(i, 1);
        return { rows: [{ id: p[0] }] };
      }
      if (s.startsWith('SELECT id, email, fingerprint, armored, source, verified, first_seen, last_seen FROM pgp_public_keys WHERE user_id = $1')) {
        return { rows: db.ring.filter(k => k.user_id === p[0]) };
      }
      if (s.startsWith('INSERT INTO pgp_public_keys') && s.includes("SELECT $1, $2, $3, $4, 'autocrypt'")) {
        if (db.ring.some(k => k.user_id === p[0] && k.email === p[1])) return { rows: [] };
        const row = { id: id(), user_id: p[0], email: p[1], fingerprint: p[2], armored: p[3], source: 'autocrypt', verified: false, first_seen: new Date(), last_seen: new Date() };
        db.ring.push(row);
        return { rows: [row] };
      }
      if (s.startsWith('INSERT INTO pgp_public_keys')) {
        const source = s.includes("VALUES ($1, $2, $3, $4, 'wkd')") ? 'wkd' : p[4];
        let row = db.ring.find(k => k.user_id === p[0] && k.email === p[1] && k.fingerprint === p[2]);
        if (row) { row.armored = p[3]; row.last_seen = new Date(); }
        else {
          row = { id: id(), user_id: p[0], email: p[1], fingerprint: p[2], armored: p[3], source, verified: false, first_seen: new Date(), last_seen: new Date() };
          db.ring.push(row);
        }
        return { rows: [row] };
      }
      if (s.startsWith('UPDATE pgp_public_keys SET verified')) {
        const hit = db.ring.filter(k => k.user_id === p[0] && k.fingerprint === p[1]);
        for (const k of hit) k.verified = p[2];
        return { rowCount: hit.length, rows: [] };
      }
      if (s.startsWith('DELETE FROM pgp_public_keys')) {
        const before = db.ring.length;
        db.ring = db.ring.filter(k => !(k.user_id === p[0] && k.fingerprint === p[1]));
        return { rowCount: before - db.ring.length, rows: [] };
      }
      if (s.startsWith('SELECT fingerprint, emails, armored_public, key_created_at FROM pgp_keys')) return { rows: db.own.filter(k => k.user_id === p[0]) };
      if (s.startsWith('SELECT email, fingerprint, armored, source, verified, last_seen FROM pgp_public_keys')) {
        return { rows: db.ring.filter(k => k.user_id === p[0] && p[1].includes(k.email)) };
      }
      throw new Error(`unexpected SQL: ${s}`);
  });
  return {
    query,
    // All or nothing, as PostgreSQL's would be: a throw puts the rows back as they were.
    withTransaction: vi.fn(async (fn) => {
      const saved = db.own.map(k => ({ ...k }));
      try {
        return await fn({ query });
      } catch (err) {
        db.own = saved;
        throw err;
      }
    }),
    pool: {},
  };
});
vi.mock('../services/ownership.js', () => ({
  findOwnedAccount: vi.fn(async (userId, accountId) => {
    const a = db.accounts.get(accountId);
    return a && a.user_id === userId ? { id: a.id } : null;
  }),
}));
vi.mock('../services/rateLimiter.js', () => ({ consume: vi.fn(async () => ({ limited: false, resetMs: 0 })), release: vi.fn(async () => {}), reset: vi.fn(async () => {}) }));
vi.mock('bcryptjs', () => ({ default: { compare: vi.fn(async (password, hash) => hash === `hash:${password}`) } }));
vi.mock('../services/wkd.js', async () => {
  const { parsePublicKeys } = await import('../services/pgpPackets.js');
  return {
    parseWkdAddress: email => (/@[a-z0-9.-]+\.[a-z]+$/.test(email) ? { local: email.split('@')[0], domain: email.split('@')[1] } : null),
    lookupWkd: vi.fn(async (email) => {
      wkd.calls.push(email);
      const armored = wkd.answers.get(email);
      return { keys: armored ? parsePublicKeys(armored) : [] };
    }),
  };
});
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, res, next) => {
    if (!req.headers['x-user']) return res.status(401).json({ error: 'Not authenticated' });
    req.session = { userId: req.headers['x-user'] };
    next();
  },
}));

import express from 'express';
import pgpRoutes from './pgp.js';
import { KEYS } from '../services/pgp.fixtures.js';
import { matchApiTokenRoute } from '../services/apiTokenAllowlist.js';
import { consume, release, reset } from '../services/rateLimiter.js';
import { consumeLoginAttempt } from '../services/loginLimiter.js';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const OTHER_ACCOUNT = '22222222-2222-4222-8222-222222222222';
let server, base;

beforeAll(async () => {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/pgp', pgpRoutes);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => res.status(500).json({ error: err.message }));
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
});
beforeEach(() => {
  db.own = [];
  db.ring = [];
  db.accounts = new Map([[ACCOUNT, { id: ACCOUNT, user_id: 'u1' }], [OTHER_ACCOUNT, { id: OTHER_ACCOUNT, user_id: 'u2' }]]);
  db.users = new Map([['u1', { password_hash: 'hash:secret pw' }], ['u2', { password_hash: null }]]);
  wkd.answers.clear();
  wkd.calls.length = 0;
});

const call = (path, { method = 'GET', body, user } = {}) => fetch(`${base}/api/pgp${path}`, {
  method,
  headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(user ? { 'X-User': user } : {}) },
  body: body !== undefined ? JSON.stringify(body) : undefined,
});

const addAlice = (user = 'u1', over = {}) => call('/keys', {
  method: 'POST', user, body: { armoredPrivate: KEYS.alicePrivate, armoredPublic: KEYS.alicePublic, ...over },
});

describe('own keys', () => {
  it('requires a session', async () => {
    expect((await call('/keys')).status).toBe(401);
    expect((await call('/keyring')).status).toBe(401);
    expect((await call('/lookup', { method: 'POST', body: { emails: [] } })).status).toBe(401);
  });

  it('stores a protected key pair and lists it to its owner only', async () => {
    const res = await addAlice('u1', { accountId: ACCOUNT });
    expect(res.status).toBe(201);
    const { key } = await res.json();
    expect(key).toMatchObject({ fingerprint: KEYS.aliceFingerprint, emails: ['alice@example.org'], accountId: ACCOUNT });
    expect((await (await call('/keys', { user: 'u1' })).json()).keys).toHaveLength(1);
    expect((await (await call('/keys', { user: 'u2' })).json()).keys).toHaveLength(0);
  });

  it('never stores a private key without a passphrase', async () => {
    const res = await call('/keys', { method: 'POST', user: 'u1', body: { armoredPrivate: KEYS.bobUnprotectedPrivate, armoredPublic: KEYS.bobPublic } });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('unprotected_key');
    expect(db.own).toHaveLength(0);
  });

  it('refuses another user\'s account', async () => {
    expect((await addAlice('u1', { accountId: OTHER_ACCOUNT })).status).toBe(404);
    expect(db.own).toHaveLength(0);
  });

  it('refuses the same key twice', async () => {
    await addAlice();
    expect((await addAlice()).status).toBe(409);
  });

  it('lets only the owner delete a key', async () => {
    const { key } = await (await addAlice()).json();
    expect((await call(`/keys/${key.id}`, { method: 'DELETE', user: 'u2' })).status).toBe(404);
    expect(db.own).toHaveLength(1);
    expect((await call(`/keys/${key.id}`, { method: 'DELETE', user: 'u1' })).status).toBe(200);
    expect(db.own).toHaveLength(0);
    expect((await call('/keys/not-a-uuid', { method: 'DELETE', user: 'u1' })).status).toBe(404);
  });
});

describe('keys that unlock with the Plimail password', () => {
  const addAuto = (user = 'u1', over = {}) => addAlice(user, { protection: 'login', auto: true, ...over });

  it('stores an automatic key once per address, however many tabs make one', async () => {
    const answers = await Promise.all([addAuto(), addAuto(), addAuto()]);
    expect(answers.map(r => r.status).sort()).toEqual([201, 409, 409]);
    expect((await answers.find(r => r.status === 409).json()).code).toBe('exists');
    expect(db.own).toHaveLength(1);
    const { keys } = await (await call('/keys', { user: 'u1' })).json();
    expect(keys[0]).toMatchObject({ protection: 'login', auto: true });
  });

  it('makes no automatic key for an address that already has one of the user\'s keys', async () => {
    await addAlice();
    expect((await addAuto()).status).toBe(409);
    expect(db.own).toHaveLength(1);
    expect(db.own[0].protection).toBe('passphrase');
  });

  it('refuses an automatic key with its own passphrase or for several addresses, and an unknown protection', async () => {
    expect((await addAuto('u1', { protection: 'passphrase' })).status).toBe(400);
    expect((await addAlice('u1', { protection: 'plain' })).status).toBe(400);
    expect((await addAlice('u1', { auto: 'yes' })).status).toBe(400);
    expect(db.own).toHaveLength(0);
  });

  it('gives each user one salt, made once', async () => {
    const first = await (await call('/kdf', { user: 'u1' })).json();
    const again = await (await call('/kdf', { user: 'u1' })).json();
    const other = await (await call('/kdf', { user: 'u2' })).json();
    expect(Buffer.from(first.salt, 'base64')).toHaveLength(16);
    expect(again.salt).toBe(first.salt);
    expect(other.salt).not.toBe(first.salt);
  });

  it('says whether a password is the Plimail password, and nothing for an SSO-only user', async () => {
    const check = (password, user = 'u1') => call('/verify-password', { method: 'POST', user, body: { password } }).then(r => r.json());
    expect(await check('secret pw')).toEqual({ ok: true, hasPassword: true });
    expect(await check('wrong')).toEqual({ ok: false, hasPassword: true });
    expect(await check('anything', 'u2')).toEqual({ ok: false, hasPassword: false });
    expect((await call('/verify-password', { method: 'POST', user: 'u1', body: {} })).status).toBe(400);
  });

  it('re-encrypts keys all at once, and keeps every old one when any of them is refused', async () => {
    const { key: a } = await (await addAuto()).json();
    const { key: c } = await (await call('/keys', { method: 'POST', user: 'u1', body: { armoredPrivate: KEYS.carolPrivate, armoredPublic: KEYS.carolPublic, protection: 'login' } })).json();
    const before = db.own.map(k => k.armored_private);
    const put = keys => call('/keys/protection', { method: 'PUT', user: 'u1', body: { keys } });

    // The second is not protected: nothing changes, the first included.
    const refused = await put([
      { id: a.id, armoredPrivate: KEYS.alicePrivate, protection: 'passphrase' },
      { id: c.id, armoredPrivate: KEYS.bobUnprotectedPrivate, protection: 'login' },
    ]);
    expect(refused.status).toBe(400);
    expect(db.own.map(k => k.armored_private)).toEqual(before);
    expect(db.own[0].protection).toBe('login');

    // Another key under this key's id.
    expect((await put([{ id: a.id, armoredPrivate: KEYS.carolPrivate, protection: 'login' }])).status).toBe(400);
    // Another user's key.
    expect((await call('/keys/protection', { method: 'PUT', user: 'u2', body: { keys: [{ id: a.id, armoredPrivate: KEYS.alicePrivate, protection: 'login' }] } })).status).toBe(404);
    expect(db.own[0].protection).toBe('login');

    const ok = await put([{ id: a.id, armoredPrivate: KEYS.alicePrivate, protection: 'passphrase' }]);
    expect(await ok.json()).toEqual({ updated: 1 });
    expect(db.own[0].protection).toBe('passphrase');
  });
});

describe('keys the current password no longer opens', () => {
  const addAuto = () => addAlice('u1', { protection: 'login', auto: true });

  it('lets the owner mark a login key stale, and then makes a new automatic key for the address', async () => {
    const { key: old } = await (await addAuto()).json();
    expect((await call(`/keys/${old.id}`, { method: 'PATCH', user: 'u2', body: { stale: true } })).status).toBe(404);
    expect((await call(`/keys/${old.id}`, { method: 'PATCH', user: 'u1', body: { stale: 'yes' } })).status).toBe(400);
    expect((await call(`/keys/${old.id}`, { method: 'PATCH', user: 'u1', body: { stale: true } })).status).toBe(200);
    const { keys } = await (await call('/keys', { user: 'u1' })).json();
    expect(keys[0]).toMatchObject({ stale: true, auto: true });
    // Same fixture key again stands in for a new one: the old row keeps its fingerprint, so give the
    // new one another fingerprint by removing the duplicate guard's match.
    db.own[0].fingerprint = 'old';
    expect((await addAuto()).status).toBe(201);
    expect(db.own).toHaveLength(2);
    expect(db.own.map(k => [Boolean(k.stale_at), k.auto_email])).toEqual([[true, null], [false, 'alice@example.org']]);
  });

  it('a key with its own passphrase cannot be marked, and re-encrypting a key makes it usable again', async () => {
    const { key: own } = await (await addAlice()).json();
    expect((await call(`/keys/${own.id}`, { method: 'PATCH', user: 'u1', body: { stale: true } })).status).toBe(404);
    db.own = [];
    const { key } = await (await addAuto()).json();
    await call(`/keys/${key.id}`, { method: 'PATCH', user: 'u1', body: { stale: true } });
    await call('/keys/protection', { method: 'PUT', user: 'u1', body: { keys: [{ id: key.id, armoredPrivate: KEYS.alicePrivate, protection: 'login' }] } });
    expect(db.own[0].stale_at).toBeNull();
  });
});

describe('verify-password budget', () => {
  // The sign-in form's own buckets for this username: what a wrong password here must count in.
  const loginKeys = async () => {
    consume.mockClear();
    await consumeLoginAttempt('ann', '127.0.0.1');
    const keys = consume.mock.calls.map(c => c[0]);
    consume.mockClear();
    return keys;
  };

  it('counts a wrong password as a failed sign-in at the account, and hands a right one back', async () => {
    db.users.get('u1').username = 'Ann';
    const expected = await loginKeys();
    release.mockClear();
    reset.mockClear();
    const check = password => call('/verify-password', { method: 'POST', user: 'u1', body: { password } });
    await check('wrong');
    expect(consume.mock.calls.map(c => c[0])).toEqual(expected);
    expect(consume.mock.calls.every(c => !String(c[0]).startsWith('pgp-verify'))).toBe(true);
    expect(release).not.toHaveBeenCalled();
    expect(reset).not.toHaveBeenCalled();
    await check('secret pw');
    expect(reset).toHaveBeenCalledWith(expected[0]);
    expect(release).toHaveBeenCalledWith(expected[1]);
    consume.mockResolvedValueOnce({ limited: true, resetMs: 5000 });
    const limited = await check('secret pw');
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('5');
  });

  it('counts nothing for an SSO-only user, who has no password to guess', async () => {
    consume.mockClear();
    expect(await (await call('/verify-password', { method: 'POST', user: 'u2', body: { password: 'x' } })).json()).toEqual({ ok: false, hasPassword: false });
    expect(consume).not.toHaveBeenCalled();
  });
});

describe('keyring', () => {
  it('adds a public key under each of its addresses', async () => {
    const res = await call('/keyring', { method: 'POST', user: 'u1', body: { armored: KEYS.bobPublic } });
    expect(res.status).toBe(201);
    const { added } = await res.json();
    expect(added.map(k => k.email).sort()).toEqual(['bob.work@example.com', 'bob@example.net']);
    expect(added.every(k => k.source === 'manual' && k.verified === false)).toBe(true);
  });

  it('refuses a private key', async () => {
    const res = await call('/keyring', { method: 'POST', user: 'u1', body: { armored: KEYS.bobUnprotectedPrivate } });
    expect(res.status).toBe(400);
    expect(db.ring).toHaveLength(0);
  });

  it('does not let a client claim a key came from a directory', async () => {
    expect((await call('/keyring', { method: 'POST', user: 'u1', body: { armored: KEYS.bobPublic, source: 'wkd' } })).status).toBe(400);
  });

  it('collects an Autocrypt key only for an address that has none yet', async () => {
    await call('/keyring', { method: 'POST', user: 'u1', body: { armored: KEYS.carolPublic, source: 'manual' } });
    const first = await (await call('/keyring', {
      method: 'POST', user: 'u1', body: { armored: KEYS.bobPublic, source: 'autocrypt', email: 'bob@example.net' },
    })).json();
    expect(first.added).toHaveLength(1);
    expect(first.added[0]).toMatchObject({ email: 'bob@example.net', source: 'autocrypt', verified: false });
    // An address that already has a key (Carol's, added by hand) gets nothing more this way.
    const known = await (await call('/keyring', {
      method: 'POST', user: 'u1', body: { armored: KEYS.carolPublic, source: 'autocrypt', email: 'carol@example.org' },
    })).json();
    expect(known.added).toEqual([]);
    expect(db.ring.filter(k => k.email === 'carol@example.org')).toMatchObject([{ source: 'manual' }]);
  });

  it('refuses an Autocrypt address the key does not name', async () => {
    const res = await call('/keyring', { method: 'POST', user: 'u1', body: { armored: KEYS.bobPublic, source: 'autocrypt', email: 'mallory@example.net' } });
    expect(res.status).toBe(400);
  });

  it('scopes verify and delete to the owner', async () => {
    await call('/keyring', { method: 'POST', user: 'u1', body: { armored: KEYS.bobPublic } });
    const fp = KEYS.bobFingerprint;
    expect((await call(`/keyring/${fp}`, { method: 'PATCH', user: 'u2', body: { verified: true } })).status).toBe(404);
    expect((await call(`/keyring/${fp}`, { method: 'DELETE', user: 'u2' })).status).toBe(404);
    expect(db.ring.every(k => !k.verified)).toBe(true);
    expect((await call(`/keyring/${fp}`, { method: 'PATCH', user: 'u1', body: { verified: true } })).status).toBe(200);
    expect(db.ring.every(k => k.verified)).toBe(true);
    expect((await call(`/keyring/${fp}`, { method: 'DELETE', user: 'u1' })).status).toBe(200);
    expect(db.ring).toHaveLength(0);
  });
});

describe('lookup', () => {
  it('answers from the user\'s own keys and keyring before asking a directory', async () => {
    await addAlice();
    await call('/keyring', { method: 'POST', user: 'u1', body: { armored: KEYS.bobPublic } });
    const { results } = await (await call('/lookup', { method: 'POST', user: 'u1', body: { emails: ['Alice@Example.org', 'bob@example.net'] } })).json();
    expect(results['alice@example.org']).toMatchObject({ source: 'own' });
    expect(results['bob@example.net'].source).toBe('keyring');
    expect(wkd.calls).toEqual([]);
  });

  it('asks the directory for the rest and keeps what it finds in the keyring', async () => {
    wkd.answers.set('carol@example.org', KEYS.carolPublic);
    const { results } = await (await call('/lookup', { method: 'POST', user: 'u1', body: { emails: ['carol@example.org', 'nobody@example.org'] } })).json();
    expect(results['carol@example.org'].source).toBe('wkd');
    expect(results['carol@example.org'].keys[0].fingerprint).toBe(KEYS.carolFingerprint);
    expect(results['nobody@example.org']).toEqual({ source: null, keys: [] });
    expect(db.ring).toMatchObject([{ user_id: 'u1', email: 'carol@example.org', source: 'wkd', verified: false }]);
  });

  it('never answers with another user\'s keys', async () => {
    await call('/keyring', { method: 'POST', user: 'u2', body: { armored: KEYS.bobPublic } });
    await addAlice('u2');
    const { results } = await (await call('/lookup', { method: 'POST', user: 'u1', body: { emails: ['bob@example.net', 'alice@example.org'] } })).json();
    expect(results['bob@example.net'].source).toBe(null);
    expect(results['alice@example.org'].source).toBe(null);
  });

  it('encrypts to one key per address: a verified one before a newer unverified one', async () => {
    await call('/keyring', { method: 'POST', user: 'u1', body: { armored: KEYS.carolPublic } });
    // A second key for the same address, seen later (say, collected from a message).
    db.ring.push({ id: 'x', user_id: 'u1', email: 'carol@example.org', fingerprint: KEYS.bobFingerprint, armored: KEYS.bobPublic, source: 'autocrypt', verified: false, first_seen: new Date(), last_seen: new Date(Date.now() + 1000) });
    let { results } = await (await call('/lookup', { method: 'POST', user: 'u1', body: { emails: ['carol@example.org'] } })).json();
    expect(results['carol@example.org'].keys.map(k => k.fingerprint)).toEqual([KEYS.bobFingerprint]);
    db.ring.find(k => k.fingerprint === KEYS.carolFingerprint).verified = true;
    ({ results } = await (await call('/lookup', { method: 'POST', user: 'u1', body: { emails: ['carol@example.org'] } })).json());
    expect(results['carol@example.org'].keys.map(k => k.fingerprint)).toEqual([KEYS.carolFingerprint]);
  });

  it('asks no directory for a local lookup (the reader), so opening a message tells no one', async () => {
    wkd.answers.set('carol@example.org', KEYS.carolPublic);
    const { results } = await (await call('/lookup', { method: 'POST', user: 'u1', body: { emails: ['carol@example.org'], local: true } })).json();
    expect(results['carol@example.org']).toEqual({ source: null, keys: [] });
    expect(wkd.calls).toEqual([]);
  });

  it('counts each address asked of a directory against the limit, not those found locally', async () => {
    consume.mockClear();
    await call('/keyring', { method: 'POST', user: 'u1', body: { armored: KEYS.bobPublic } });
    await call('/lookup', { method: 'POST', user: 'u1', body: { emails: ['bob@example.net', 'a@example.org', 'b@example.org', 'c@example.org'] } });
    expect(consume.mock.calls.filter(([key]) => key === 'pgp-wkd:u1')).toHaveLength(3);
    consume.mockClear();
    await call('/lookup', { method: 'POST', user: 'u1', body: { emails: ['bob@example.net'] } });
    expect(consume).not.toHaveBeenCalled();
    consume.mockResolvedValueOnce({ limited: true, resetMs: 5000 });
    const res = await call('/lookup', { method: 'POST', user: 'u1', body: { emails: ['d@example.org'] } });
    expect(res.status).toBe(429);
    expect(wkd.calls).not.toContain('d@example.org');
  });

  it('bounds the request', async () => {
    const emails = Array.from({ length: 51 }, (_, i) => `u${i}@example.org`);
    expect((await call('/lookup', { method: 'POST', user: 'u1', body: { emails } })).status).toBe(400);
    expect((await call('/lookup', { method: 'POST', user: 'u1', body: { emails: 'x@example.org' } })).status).toBe(400);
  });
});

describe('API tokens', () => {
  it('cannot reach any of these routes', () => {
    for (const [method, path] of [
      ['GET', '/api/pgp/keys'], ['POST', '/api/pgp/keys'], ['GET', '/api/pgp/keyring'], ['POST', '/api/pgp/keyring'],
      ['POST', '/api/pgp/lookup'], ['DELETE', `/api/pgp/keyring/${KEYS.bobFingerprint}`],
    ]) expect(matchApiTokenRoute(method, path)).toBe(null);
  });
});
