import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import pg from 'pg';

// Tries at the password and replies sent at once, against a real PostgreSQL, where statements on
// separate connections do interleave. The tables live in a schema of their own, dropped after.
const { state } = vi.hoisted(() => ({ state: { pool: null } }));
vi.mock('./db.js', () => ({
  query: (sql, params) => state.pool.query(sql, params),
  withTransaction: async (fn) => {
    const client = await state.pool.connect();
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

import {
  MAX_FAILED_ATTEMPTS, MAX_REPLIES, addReply, attemptFailed, attemptSucceeded, newToken, reserveAttempt,
} from './secureMessages.js';

const URL = process.env.MAILFLOW_TEST_DATABASE_URL;
const SCHEMA = `secure_race_${process.pid}_${Date.now()}`;

describe.skipIf(!URL)('password-protected messages under concurrency (PostgreSQL)', () => {
  let admin;
  beforeAll(async () => {
    admin = new pg.Client({ connectionString: URL });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    await admin.query(`SET search_path TO ${SCHEMA}`);
    await admin.query(`
      CREATE TABLE secure_messages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        token TEXT NOT NULL UNIQUE,
        user_id UUID NOT NULL,
        sender_name TEXT, sender_email TEXT NOT NULL DEFAULT 'a@example.com',
        ciphertext BYTEA NOT NULL DEFAULT '\\x00', iv TEXT NOT NULL DEFAULT '', salt TEXT NOT NULL DEFAULT '',
        iterations INTEGER NOT NULL DEFAULT 1, auth_verifier TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL, revoked_at TIMESTAMPTZ,
        open_count INTEGER NOT NULL DEFAULT 0, failed_attempts INTEGER NOT NULL DEFAULT 0, locked_at TIMESTAMPTZ
      );
      CREATE TABLE secure_message_replies (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        secure_message_id UUID NOT NULL REFERENCES secure_messages(id) ON DELETE CASCADE,
        ciphertext BYTEA NOT NULL, iv TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), read_at TIMESTAMPTZ
      )`);
    state.pool = new pg.Pool({ connectionString: URL, max: 30, options: `-c search_path=${SCHEMA}` });
  });
  afterAll(async () => {
    await state.pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin?.end();
  });

  let message;
  beforeEach(async () => {
    const token = newToken();
    const { rows: [row] } = await admin.query(
      `INSERT INTO secure_messages (token, user_id, auth_verifier, expires_at)
       VALUES ($1, gen_random_uuid(), 'v', NOW() + INTERVAL '1 day') RETURNING id, token`,
      [token],
    );
    message = row;
  });
  const row = async () => (await admin.query('SELECT failed_attempts, locked_at FROM secure_messages WHERE id = $1', [message.id])).rows[0];

  it('lets no more tries reach the comparison than the message has, however many arrive at once', async () => {
    const reserved = (await Promise.all(Array.from({ length: 40 }, () => reserveAttempt(message.token)))).filter(Boolean);
    expect(reserved).toHaveLength(MAX_FAILED_ATTEMPTS);
    const outcomes = await Promise.all(reserved.map(r => attemptFailed(r.id)));
    expect(outcomes.filter(o => o.locked).length).toBeGreaterThan(0);
    expect(await row()).toMatchObject({ failed_attempts: MAX_FAILED_ATTEMPTS });
    expect((await row()).locked_at).not.toBeNull();
    expect(await reserveAttempt(message.token)).toBeNull();
  });

  it('gives a right key\'s try back, so opening often never locks the message', async () => {
    for (let i = 0; i < MAX_FAILED_ATTEMPTS * 2; i++) {
      const r = await reserveAttempt(message.token);
      expect(r).not.toBeNull();
      await attemptSucceeded(r.id);
    }
    expect(await row()).toMatchObject({ failed_attempts: 0, locked_at: null });
  });

  it(`stores no more than ${MAX_REPLIES} replies, however many arrive at once`, async () => {
    const results = await Promise.all(Array.from({ length: MAX_REPLIES * 3 }, () => (
      addReply(message.id, randomBytes(32), randomBytes(12).toString('base64'))
    )));
    expect(results.filter(Boolean)).toHaveLength(MAX_REPLIES);
    const { rows: [{ n }] } = await admin.query(
      'SELECT COUNT(*)::int AS n FROM secure_message_replies WHERE secure_message_id = $1', [message.id],
    );
    expect(n).toBe(MAX_REPLIES);
  });
});
