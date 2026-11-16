import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// A stand-in for pgp_keys and pgp_public_keys, answering the SQL services/pgpKeyring.js sends.
const { db, wkd } = vi.hoisted(() => ({
  db: { own: [], ring: [], accounts: new Map(), seq: 0 },
  wkd: { answers: new Map(), calls: [] },
}));
vi.mock('../services/db.js', () => {
  const id = () => `00000000-0000-4000-8000-${String(++db.seq).padStart(12, '0')}`;
  return {
    query: vi.fn(async (sql, p = []) => {
      const s = sql.replace(/\s+/g, ' ').trim();
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
          algorithm: p[5], armored_public: p[6], armored_private: p[7], key_created_at: p[8], created_at: new Date(),
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
      if (s.startsWith('SELECT fingerprint, emails, armored_public FROM pgp_keys')) return { rows: db.own.filter(k => k.user_id === p[0]) };
      if (s.startsWith('SELECT email, fingerprint, armored, source, verified FROM pgp_public_keys')) {
        return { rows: db.ring.filter(k => k.user_id === p[0] && p[1].includes(k.email)) };
      }
      throw new Error(`unexpected SQL: ${s}`);
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
vi.mock('../services/rateLimiter.js', () => ({ consume: vi.fn(async () => ({ limited: false, resetMs: 0 })) }));
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
