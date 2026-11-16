import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';

vi.mock('./db.js', () => ({ query: vi.fn() }));
import {
  MAX_IMAGES_PER_USER, MAX_TOTAL_BYTES_PER_USER, SIGNATURE_IMAGE_QUOTA_CODE,
  deleteUnreferencedSignatureImages, saveSignatureImage,
} from './signatureImages.js';

// The per-user cap and the sweep of images no signature uses, against real SQL. Uses only
// connection-local temporary tables in an explicitly supplied database.
describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('signature image storage', () => {
  let database;
  const U1 = '11111111-1111-4111-8111-111111111111';
  const U2 = '22222222-2222-4222-8222-222222222222';
  const queryFn = (...args) => database.query(...args);
  const image = (size = 10) => ({ type: 'image/png', bytes: Buffer.alloc(size, 1), width: 1, height: 1 });
  const ids = async () => (await database.query('SELECT id FROM signature_images')).rows.map(r => r.id);
  const age = (id, days) => database.query(
    "UPDATE signature_images SET created_at = NOW() - ($2 || ' days')::interval WHERE id = $1", [id, String(days)]);

  beforeAll(async () => {
    database = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL });
    await database.connect();
    await database.query(`CREATE TEMP TABLE signature_images (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL, content_type text NOT NULL, data bytea NOT NULL, width integer NOT NULL,
      height integer NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`);
    await database.query('CREATE TEMP TABLE email_accounts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, signature text)');
    await database.query('CREATE TEMP TABLE account_aliases (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid, signature text)');
    await database.query('CREATE TEMP TABLE scheduled_messages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, status text)');
  });
  afterAll(async () => { await database?.end(); });
  beforeEach(async () => {
    await database.query('TRUNCATE signature_images, email_accounts, account_aliases, scheduled_messages');
  });

  it(`refuses image ${MAX_IMAGES_PER_USER + 1} of a user, and only for that user`, async () => {
    for (let i = 0; i < MAX_IMAGES_PER_USER; i++) await saveSignatureImage(U1, image(), { queryFn });
    await expect(saveSignatureImage(U1, image(), { queryFn }))
      .rejects.toMatchObject({ status: 409, code: SIGNATURE_IMAGE_QUOTA_CODE });
    await expect(saveSignatureImage(U2, image(), { queryFn }))
      .resolves.toMatchObject({ url: expect.stringMatching(/^\/api\/signature-images\//) });
    expect((await ids()).length).toBe(MAX_IMAGES_PER_USER + 1);
  });

  it('refuses an image that would take a user past the total size', async () => {
    const mb = 1024 * 1024;
    for (let i = 0; i < MAX_TOTAL_BYTES_PER_USER / mb; i++) await saveSignatureImage(U1, image(mb), { queryFn });
    await expect(saveSignatureImage(U1, image(1), { queryFn })).rejects.toMatchObject({ status: 409 });
  });

  it('deletes only week-old images that no account or alias signature names', async () => {
    const used = (await saveSignatureImage(U1, image(), { queryFn })).id;
    const byAlias = (await saveSignatureImage(U1, image(), { queryFn })).id;
    const unused = (await saveSignatureImage(U1, image(), { queryFn })).id;
    const recent = (await saveSignatureImage(U1, image(), { queryFn })).id;
    // An admin can put an image into another user's account signature; it is still in use.
    const elsewhere = (await saveSignatureImage(U2, image(), { queryFn })).id;
    for (const id of [used, byAlias, unused, elsewhere]) await age(id, 8);
    await age(recent, 6);
    const { rows: [acct] } = await database.query(
      'INSERT INTO email_accounts (user_id, signature) VALUES ($1, $2) RETURNING id',
      [U1, `<p>Jane</p><img src="/api/signature-images/${used.toUpperCase()}"><img src="/api/signature-images/${elsewhere}">`]);
    await database.query('INSERT INTO account_aliases (account_id, signature) VALUES ($1, $2)',
      [acct.id, `<img src="/api/signature-images/${byAlias}">`]);
    await database.query('INSERT INTO email_accounts (user_id, signature) VALUES ($1, NULL)', [U2]);

    expect(await deleteUnreferencedSignatureImages({ queryFn })).toBe(1);
    expect((await ids()).sort()).toEqual([used, byAlias, recent, elsewhere].sort());
  });

  it('keeps every image of a user with a scheduled send not yet settled', async () => {
    const id = (await saveSignatureImage(U1, image(), { queryFn })).id;
    await age(id, 30);
    for (const status of ['scheduled', 'editing', 'sending', 'paused', 'uncertain', 'failed']) {
      await database.query('TRUNCATE scheduled_messages');
      await database.query('INSERT INTO scheduled_messages (user_id, status) VALUES ($1, $2)', [U1, status]);
      expect(await deleteUnreferencedSignatureImages({ queryFn })).toBe(0);
    }
    await database.query("UPDATE scheduled_messages SET status = 'sent'");
    await database.query("INSERT INTO scheduled_messages (user_id, status) VALUES ($1, 'cancelled'), ($2, 'scheduled')", [U1, U2]);
    expect(await deleteUnreferencedSignatureImages({ queryFn })).toBe(1);
  });
});
