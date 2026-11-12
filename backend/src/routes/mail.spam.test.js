import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => {
    req.session = { userId: 'user-1' };
    next();
  },
}));
vi.mock('../index.js', () => ({
  imapManager: {
    _guardMoveUid: vi.fn(),
    _unguardMoveUid: vi.fn(),
    moveMessage: vi.fn(),
    syncFolderOnDemand: vi.fn(),
    broadcast: vi.fn(),
  },
}));

import express from 'express';
import mailRoutes from './mail.js';
import { query } from '../services/db.js';
import { imapManager } from '../index.js';
import { takeCarry } from '../services/movedRowCarry.js';

const ACCOUNT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MESSAGE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/mail', mailRoutes);
  return app;
}

function startServer() {
  return new Promise(resolve => {
    const server = buildApp().listen(0, () => {
      resolve({ server, base: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

// Full message row as returned by the moveForSpamLabel SELECT (m.*).
function messageRow(overrides = {}) {
  return {
    id: MESSAGE_ID,
    account_id: ACCOUNT_ID,
    uid: 42,
    folder: 'Junk',
    message_id: '<abc123@example.com>',
    subject: 'Cheap Viagra',
    body_text: 'Click here to buy now',
    body_html: '<p>Click here</p>',
    from_name: 'Spammer',
    from_email: 'spammer@spoof.net',
    attachments: [{ filename: 'invoice.pdf.exe' }],
    is_read: false,
    ...overrides,
  };
}

beforeEach(() => {
  query.mockReset();
  imapManager._guardMoveUid.mockReset();
  imapManager._unguardMoveUid.mockReset();
  imapManager.moveMessage.mockReset();
  imapManager.syncFolderOnDemand.mockReset();
  imapManager.broadcast.mockReset();
});

describe('POST /api/mail/messages/:id/spam — no-op path (already in spam folder)', () => {
  let server;
  let base;

  beforeAll(async () => {
    ({ server, base } = await startServer());
  });
  afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
  });

  it('answers without moving or writing anything', async () => {
    // 1. Route lookup (account + folder_mappings)
    query.mockResolvedValueOnce({ rows: [{ account_id: ACCOUNT_ID, folder_mappings: { spam: 'Junk' } }] });
    // 2. resolveSpamFolder → mappedFolderUsable
    query.mockResolvedValueOnce({ rows: [{}] }); // folder exists
    // 3. moveForSpamLabel SELECT m.* — message already in 'Junk'
    query.mockResolvedValueOnce({ rows: [messageRow()] });
    query.mockResolvedValue({ rows: [] });

    const res = await fetch(`${base}/api/mail/messages/${MESSAGE_ID}/spam`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, alreadyInFolder: true, folder: 'Junk' });

    expect(imapManager.moveMessage).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(3);
  });
});

describe('POST /api/mail/messages/:id/ham — move path (message leaves spam)', () => {
  let server;
  let base;
  beforeAll(async () => {
    ({ server, base } = await startServer());
  });
  afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
  });

  it('moves the message to the inbox', async () => {
    // 1. Route lookup for /ham
    query.mockResolvedValueOnce({ rows: [{ account_id: ACCOUNT_ID, folder: 'Junk', folder_mappings: { spam: 'Junk', inbox: 'INBOX' } }] });
    // 2. resolveAllSpamPaths → mapped folder check for 'Junk'
    query.mockResolvedValueOnce({ rows: [{}] });
    // 3. moveForSpamLabel SELECT m.*
    query.mockResolvedValueOnce({ rows: [messageRow()] });
    // 4. account row
    query.mockResolvedValueOnce({ rows: [{ id: ACCOUNT_ID }] });
    // 5. DELETE stale row, UPDATE messages
    query.mockResolvedValue({ rows: [] });

    imapManager.moveMessage.mockResolvedValue(100);

    const res = await fetch(`${base}/api/mail/messages/${MESSAGE_ID}/ham`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.folder).toBe('INBOX');

    expect(imapManager.moveMessage).toHaveBeenCalled();
    const update = query.mock.calls.find(([sql]) => sql.startsWith('UPDATE messages SET folder'));
    expect(update).toEqual(['UPDATE messages SET folder = $1, uid = $2 WHERE id = $3', ['INBOX', 100, MESSAGE_ID]]);
  });

  // The source uid can belong to another message in the inbox (#665), so the row is not kept on it.
  it('without a new uid, drops the row and pulls the inbox instead of keeping the source uid', async () => {
    query.mockResolvedValueOnce({ rows: [{ account_id: ACCOUNT_ID, folder: 'Junk', folder_mappings: { spam: 'Junk', inbox: 'INBOX' } }] });
    query.mockResolvedValueOnce({ rows: [{}] });
    query.mockResolvedValueOnce({ rows: [messageRow()] });
    query.mockResolvedValueOnce({ rows: [{ id: ACCOUNT_ID }] });
    const date = '2026-11-04T10:00:00.000Z';
    query.mockImplementation(async (sql) => (sql === 'DELETE FROM messages WHERE id = $1 RETURNING *'
      ? { rows: [messageRow({ date, category: 'promotions' })] }
      : { rows: [] }));
    imapManager.moveMessage.mockResolvedValue(null);
    imapManager.syncFolderOnDemand.mockResolvedValue(undefined);

    const res = await fetch(`${base}/api/mail/messages/${MESSAGE_ID}/ham`, { method: 'POST' });
    expect(res.status).toBe(200);
    const sqls = query.mock.calls.map(([sql, params]) => [sql.replace(/\s+/g, ' ').trim(), params]);
    expect(sqls.filter(([sql]) => sql.startsWith('UPDATE messages'))).toEqual([]);
    expect(sqls).toContainEqual(['DELETE FROM messages WHERE id = $1 RETURNING *', [MESSAGE_ID]]);
    expect(imapManager.syncFolderOnDemand).toHaveBeenCalledWith({ id: ACCOUNT_ID }, 'INBOX');
    // The inbox's sync files it again with what MailFlow knew about it, not as new mail.
    expect(takeCarry(ACCOUNT_ID, 'INBOX', '<abc123@example.com>', date)).toMatchObject({ category: 'promotions' });
  });
});