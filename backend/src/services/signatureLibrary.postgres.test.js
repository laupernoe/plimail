import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'fs/promises';
import pg from 'pg';

vi.mock('./db.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
import { query, withTransaction } from './db.js';
import {
  assignSignature, createSignature, deleteSignature, listSignatures, updateSignature,
} from './signatureLibrary.js';

const MIGRATION = new URL('../../migrations/0105_signature_library.sql', import.meta.url);
const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';

// Migration 0105 and the library against a real PostgreSQL, in a schema of its own (the
// migration creates a permanent table, which cannot reference temporary ones) dropped afterwards.
describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('signature library on PostgreSQL', () => {
  let database;
  const schema = `sig_library_test_${process.pid}`;
  const sql = () => readFile(MIGRATION, 'utf8');
  const account = async (userId, name, email, signature) => (await database.query(
    'INSERT INTO email_accounts (user_id, name, email_address, signature) VALUES ($1, $2, $3, $4) RETURNING id',
    [userId, name, email, signature])).rows[0].id;
  const alias = async (accountId, name, email, signature) => (await database.query(
    'INSERT INTO account_aliases (account_id, name, email, signature) VALUES ($1, $2, $3, $4) RETURNING id',
    [accountId, name, email, signature])).rows[0].id;
  const accountRow = async id => (await database.query('SELECT signature, signature_id FROM email_accounts WHERE id = $1', [id])).rows[0];
  const aliasRow = async id => (await database.query('SELECT signature, signature_id FROM account_aliases WHERE id = $1', [id])).rows[0];

  beforeAll(async () => {
    database = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL });
    await database.connect();
    await database.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE; CREATE SCHEMA ${schema}; SET search_path TO ${schema}`);
    query.mockImplementation((text, values) => database.query(text, values));
    withTransaction.mockImplementation(async (fn) => {
      await database.query('BEGIN');
      try {
        const result = await fn(database);
        await database.query('COMMIT');
        return result;
      } catch (err) {
        await database.query('ROLLBACK');
        throw err;
      }
    });
  });
  afterAll(async () => {
    await database?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await database?.end();
  });
  beforeEach(async () => {
    // The columns of the tables before 0105 that it reads or changes.
    await database.query(`
      DROP TABLE IF EXISTS account_aliases, email_accounts, signatures, users CASCADE;
      CREATE TABLE users (id uuid PRIMARY KEY);
      CREATE TABLE email_accounts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, name varchar(255) NOT NULL,
        email_address varchar(255) NOT NULL, signature text, signature_enabled boolean NOT NULL DEFAULT true);
      CREATE TABLE account_aliases (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        account_id uuid NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE, name varchar(255) NOT NULL,
        email varchar(255) NOT NULL, signature text);
      INSERT INTO users (id) VALUES ('${U1}'), ('${U2}')`);
  });

  it('turns every existing signature into a library entry assigned to its owner, once', async () => {
    const work = await account(U1, 'Work', 'jane@work.example', '<p>Jane, Work</p>');
    const home = await account(U1, 'jane@home.example', 'jane@home.example', '<p>Jane</p>');
    const none = await account(U1, 'Spare', 'spare@example.com', null);
    const blank = await account(U1, 'Blank', 'blank@example.com', '  ');
    const other = await account(U2, 'Bob', 'bob@example.com', '<p>Bob</p>');
    const sales = await alias(work, 'Sales', 'sales@work.example', '<p>Sales team</p>');
    const inherits = await alias(work, 'Info', 'info@work.example', null);

    await database.query(await sql());
    await database.query(await sql());

    const { rows } = await database.query('SELECT user_id, name, html FROM signatures ORDER BY name');
    expect(rows).toEqual([
      { user_id: U2, name: 'Bob (bob@example.com)', html: '<p>Bob</p>' },
      { user_id: U1, name: 'jane@home.example', html: '<p>Jane</p>' },
      { user_id: U1, name: 'Sales (sales@work.example)', html: '<p>Sales team</p>' },
      { user_id: U1, name: 'Work (jane@work.example)', html: '<p>Jane, Work</p>' },
    ]);
    // The copies every send path reads are untouched, and each now names its entry.
    for (const [id, html] of [[work, '<p>Jane, Work</p>'], [home, '<p>Jane</p>'], [other, '<p>Bob</p>']]) {
      const row = await accountRow(id);
      expect(row.signature).toBe(html);
      const { rows: [entry] } = await database.query('SELECT html FROM signatures WHERE id = $1', [row.signature_id]);
      expect(entry.html).toBe(html);
    }
    expect(await accountRow(none)).toEqual({ signature: null, signature_id: null });
    expect(await accountRow(blank)).toEqual({ signature: '  ', signature_id: null });
    expect((await aliasRow(sales)).signature).toBe('<p>Sales team</p>');
    expect((await aliasRow(sales)).signature_id).not.toBeNull();
    expect(await aliasRow(inherits)).toEqual({ signature: null, signature_id: null });
  });

  it('rewrites the copies of the accounts and aliases an entry is assigned to, and only theirs', async () => {
    await database.query(await sql());
    const a1 = await account(U1, 'A', 'a@example.com', null);
    const a2 = await account(U1, 'B', 'b@example.com', null);
    const al = await alias(a1, 'Sales', 'sales@example.com', null);
    const bob = await account(U2, 'Bob', 'bob@example.com', '<p>Bob</p>');

    const entry = await createSignature(U1, { name: ' Formal ', html: '<p>Regards</p><script>x()</script>' });
    expect(entry).toMatchObject({ name: 'Formal', html: '<p>Regards</p>' });
    await assignSignature(U1, { accountId: a1, signatureId: entry.id });
    await assignSignature(U1, { accountId: a1, aliasId: al, signatureId: entry.id });
    expect(await accountRow(a1)).toEqual({ signature: '<p>Regards</p>', signature_id: entry.id });

    await updateSignature(U1, entry.id, { html: '<p>Kind regards</p>' });
    expect((await accountRow(a1)).signature).toBe('<p>Kind regards</p>');
    expect((await aliasRow(al)).signature).toBe('<p>Kind regards</p>');
    expect(await accountRow(a2)).toEqual({ signature: null, signature_id: null });
    // A rename leaves the copies alone.
    await updateSignature(U1, entry.id, { name: 'Formal 2' });
    expect((await accountRow(a1)).signature).toBe('<p>Kind regards</p>');

    // An entry edited to nothing leaves its accounts with no signature, as an empty one always did.
    await updateSignature(U1, entry.id, { html: '' });
    expect((await accountRow(a1)).signature).toBeNull();
    await updateSignature(U1, entry.id, { html: '<p>Back</p>' });

    // None unassigns.
    await assignSignature(U1, { accountId: a1, aliasId: al, signatureId: null });
    expect(await aliasRow(al)).toEqual({ signature: null, signature_id: null });

    await deleteSignature(U1, entry.id);
    expect(await accountRow(a1)).toEqual({ signature: null, signature_id: null });
    expect(await listSignatures(U1)).toEqual([]);
    expect((await accountRow(bob)).signature).toBe('<p>Bob</p>');
  });

  it("never reads, changes, assigns or deletes another user's signature, account or alias", async () => {
    await database.query(await sql());
    const mine = await account(U1, 'A', 'a@example.com', null);
    const theirs = await account(U2, 'Bob', 'bob@example.com', null);
    const theirAlias = await alias(theirs, 'Sales', 'sales@example.com', null);
    const their = await createSignature(U2, { name: 'Bob', html: '<p>Bob</p>' });
    await assignSignature(U2, { accountId: theirs, signatureId: their.id });
    const own = await createSignature(U1, { name: 'Mine', html: '<p>Mine</p>' });

    expect((await listSignatures(U1)).map(s => s.name)).toEqual(['Mine']);
    await expect(updateSignature(U1, their.id, { html: '<p>pwned</p>' })).rejects.toMatchObject({ status: 404 });
    await expect(deleteSignature(U1, their.id)).rejects.toMatchObject({ status: 404 });
    await expect(assignSignature(U1, { accountId: mine, signatureId: their.id })).rejects.toMatchObject({ status: 404 });
    await expect(assignSignature(U1, { accountId: theirs, signatureId: own.id })).rejects.toMatchObject({ status: 404 });
    await expect(assignSignature(U1, { accountId: theirs, aliasId: theirAlias, signatureId: own.id })).rejects.toMatchObject({ status: 404 });
    await expect(assignSignature(U1, { accountId: mine, aliasId: theirAlias, signatureId: own.id })).rejects.toMatchObject({ status: 404 });

    expect(await accountRow(theirs)).toEqual({ signature: '<p>Bob</p>', signature_id: their.id });
    expect(await aliasRow(theirAlias)).toEqual({ signature: null, signature_id: null });
    expect(await accountRow(mine)).toEqual({ signature: null, signature_id: null });
  });
});
