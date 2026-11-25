import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import pg from 'pg';

vi.mock('./db.js', () => ({ query: vi.fn() }));
import { query } from './db.js';
import { invitationMail, recordInviteParts } from './mailInvites.js';

// The SQL behind invitations received by mail, against the tables of migration 0106. Uses only
// connection-local temporary tables in an explicitly supplied database.
describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('mail invitations PostgreSQL', () => {
  let database;
  const ACCOUNT = '00000000-0000-4000-8000-000000000001';
  const OTHER = '00000000-0000-4000-8000-000000000002';
  const msg = n => `00000000-0000-4000-8000-1000000000${String(n).padStart(2, '0')}`;

  beforeAll(async () => {
    database = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL });
    await database.connect();
    await database.query(`
      CREATE TEMP TABLE users (id uuid PRIMARY KEY);
      CREATE TEMP TABLE email_accounts (id uuid PRIMARY KEY, user_id uuid, enabled boolean, name text, email_address text);
      CREATE TEMP TABLE folders (account_id uuid, path text, special_use text);
      CREATE TEMP TABLE messages (id uuid PRIMARY KEY, account_id uuid, folder text, uid bigint, date timestamptz,
        subject text, is_deleted boolean DEFAULT false)`);
    // The migration's own statements, on temporary tables of the same names.
    const ddl = fs.readFileSync(new URL('../../migrations/0106_calendar_invitations.sql', import.meta.url), 'utf8')
      .replace(/CREATE TABLE IF NOT EXISTS/g, 'CREATE TEMP TABLE');
    await database.query(ddl);
    query.mockImplementation((sql, values) => database.query(sql, values));
  });
  afterAll(async () => { await database?.end(); });
  beforeEach(async () => {
    await database.query('TRUNCATE mail_invites, calendar_invite_replies, messages, folders, email_accounts, users CASCADE');
    await database.query(`INSERT INTO users VALUES ('${ACCOUNT}'), ('${OTHER}')`);
    await database.query(`INSERT INTO email_accounts VALUES ($1, $1, true, 'Work', 'noe@example.com'), ($2, $2, true, 'Else', 'x@example.com')`, [ACCOUNT, OTHER]);
    await database.query(`INSERT INTO folders VALUES ($1, 'INBOX', NULL), ($1, 'Trash', '\\Trash')`, [ACCOUNT]);
  });

  const message = (n, extra = {}) => database.query(
    'INSERT INTO messages (id, account_id, folder, uid, date, is_deleted) VALUES ($1,$2,$3,$4,$5,$6)',
    [msg(n), extra.account || ACCOUNT, extra.folder || 'INBOX', n, extra.date || new Date(), extra.deleted || false],
  );
  const read = (n, extra = {}) => database.query(
    `UPDATE mail_invites SET ical = $2, uid = 'meet', method = 'REQUEST', sequence = 0, range_end = $3 WHERE message_id = $1`,
    [msg(n), extra.ical ?? 'BEGIN:VCALENDAR', extra.rangeEnd === undefined ? new Date(Date.now() + 86400000) : extra.rangeEnd],
  );

  it('records the parts sync found once, on the message row it just wrote', async () => {
    await message(1);
    const parts = [{ part: '2', type: 'text/calendar' }];
    await recordInviteParts(ACCOUNT, 'INBOX', 1, parts);
    await database.query(`UPDATE mail_invites SET ical = 'kept'`);
    await recordInviteParts(ACCOUNT, 'INBOX', 1, [{ part: '3' }]);
    const { rows } = await database.query('SELECT message_id, account_id, parts, ical FROM mail_invites');
    expect(rows).toEqual([{ message_id: msg(1), account_id: ACCOUNT, parts, ical: 'kept' }]);
  });

  it('lists the user\'s read invitations still to come, with the folder they are in', async () => {
    for (const n of [1, 2, 3, 4, 5, 6, 7]) await message(n, {
      ...(n === 2 ? { deleted: true } : {}), ...(n === 3 ? { date: new Date(Date.now() - 200 * 86400000) } : {}),
      ...(n === 6 ? { folder: 'Trash' } : {}), ...(n === 7 ? { account: OTHER } : {}),
    });
    for (const n of [1, 2, 3, 4, 5, 6, 7]) {
      await recordInviteParts(n === 7 ? OTHER : ACCOUNT, n === 6 ? 'Trash' : 'INBOX', n, [{ part: '2' }]);
      if (n === 4) await read(n, { rangeEnd: new Date(Date.now() - 1000) });
      else if (n === 5) await read(n, { ical: '' });
      else await read(n);
    }
    const rows = await invitationMail(ACCOUNT);
    expect(rows.map(r => [r.message_id, r.special_use]).sort()).toEqual([[msg(1), null], [msg(6), '\\Trash']]);
    expect(rows[0]).toMatchObject({ account_email: 'noe@example.com', account_name: 'Work', uid: 'meet', method: 'REQUEST' });
  });

  it('goes with its message', async () => {
    await message(1);
    await recordInviteParts(ACCOUNT, 'INBOX', 1, [{ part: '2' }]);
    await database.query('DELETE FROM messages');
    expect((await database.query('SELECT 1 FROM mail_invites')).rowCount).toBe(0);
  });
});
