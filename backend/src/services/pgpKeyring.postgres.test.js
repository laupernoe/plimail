import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'crypto';
import pg from 'pg';

const h = vi.hoisted(() => ({ pool: null }));

// The keys that unlock with the Plimail password (migration 0095) on a real database: the unique
// automatic key per address under concurrent tabs, and re-encryption that is all or nothing.
vi.mock('./db.js', () => ({
  pool: { connect: (...a) => h.pool.connect(...a), query: (...a) => h.pool.query(...a) },
  query: (text, params) => h.pool.query(text, params),
  withTransaction: async (fn) => {
    const client = await h.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },
}));

import { runMigrations } from './migrations.js';
import { addOwnKey, kdfSalt, listOwnKeys, setKeysProtection } from './pgpKeyring.js';
import { autocryptFor } from './autocrypt.js';
import { KEYS } from './pgp.fixtures.js';

const ADMIN_URL = process.env.MAILFLOW_TEST_DATABASE_URL;

describe.skipIf(!ADMIN_URL)('automatic OpenPGP keys on PostgreSQL', () => {
  const dbName = `mailflow_pgpauto_${randomBytes(4).toString('hex')}`;
  let admin;
  let ann;
  let eve;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(ADMIN_URL);
    url.pathname = `/${dbName}`;
    h.pool = new pg.Pool({ connectionString: url.toString(), max: 10 });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await runMigrations();
    ({ rows: [ann] } = await h.pool.query("INSERT INTO users (username) VALUES ('ann') RETURNING id"));
    ({ rows: [eve] } = await h.pool.query("INSERT INTO users (username) VALUES ('eve') RETURNING id"));
  });

  afterAll(async () => {
    await h.pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin?.end();
    vi.restoreAllMocks();
  });

  beforeEach(async () => {
    await h.pool.query('DELETE FROM pgp_keys');
  });

  const auto = userId => addOwnKey(userId, { armoredPrivate: KEYS.alicePrivate, armoredPublic: KEYS.alicePublic, protection: 'login', auto: true });

  it('stores one automatic key per address when several tabs make it at once', async () => {
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => auto(ann.id)));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(r => r.status === 'rejected').every(r => r.reason.code === 'exists')).toBe(true);
    const keys = await listOwnKeys(ann.id);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ protection: 'login', auto: true, emails: ['alice@example.org'] });
    // Another user's address is theirs to have a key for.
    await expect(auto(eve.id)).resolves.toMatchObject({ auto: true });
  });

  it('makes no automatic key over one the user imported for the address', async () => {
    await addOwnKey(ann.id, { armoredPrivate: KEYS.alicePrivate, armoredPublic: KEYS.alicePublic });
    await expect(auto(ann.id)).rejects.toMatchObject({ status: 409, code: 'exists' });
  });

  it('re-encrypts all of the keys or none', async () => {
    const a = await auto(ann.id);
    const c = await addOwnKey(ann.id, { armoredPrivate: KEYS.carolPrivate, armoredPublic: KEYS.carolPublic, protection: 'login' });
    await expect(setKeysProtection(ann.id, [
      { id: a.id, armoredPrivate: KEYS.alicePrivate, protection: 'passphrase' },
      { id: c.id, armoredPrivate: KEYS.alicePrivate, protection: 'passphrase' },
    ])).rejects.toMatchObject({ status: 400, code: 'invalid_key' });
    expect((await listOwnKeys(ann.id)).map(k => k.protection)).toEqual(['login', 'login']);
    await expect(setKeysProtection(eve.id, [{ id: a.id, armoredPrivate: KEYS.alicePrivate, protection: 'passphrase' }]))
      .rejects.toMatchObject({ status: 404 });
    expect(await setKeysProtection(ann.id, [{ id: a.id, armoredPrivate: KEYS.alicePrivate, protection: 'passphrase' }])).toBe(1);
    expect((await listOwnKeys(ann.id)).find(k => k.id === a.id).protection).toBe('passphrase');
  });

  it('keeps one salt per user and finds the From address\'s key for the Autocrypt header', async () => {
    const salt = await kdfSalt(ann.id);
    expect(await kdfSalt(ann.id)).toBe(salt);
    expect(await kdfSalt(eve.id)).not.toBe(salt);
    await auto(ann.id);
    expect(await autocryptFor(ann.id, 'alice@example.org')).toMatch(/^addr=alice@example\.org; keydata=/);
    expect(await autocryptFor(eve.id, 'alice@example.org')).toBeNull();
  });
});
