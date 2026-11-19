import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => { req.session = { userId: 'user-1' }; next(); } }));
vi.mock('../index.js', () => ({ imapManager: { fetchMultipleAttachments: vi.fn() } }));

import express from 'express';
import mailRoutes from './mail.js';
import { query } from '../services/db.js';
import { imapManager } from '../index.js';
import { _resetReactionState } from '../services/reactions.js';

const ID = '11111111-1111-4111-8111-111111111111';
const parts = [{ type: 'json', part: '2', encoding: '7bit', charset: 'utf-8' }];
let server, base, rows;

beforeAll(async () => {
  const app = express();
  app.use('/api/mail', mailRoutes);
  await new Promise(resolve => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise(resolve => server.close(resolve)); });
beforeEach(() => {
  vi.clearAllMocks();
  _resetReactionState();
  rows = [
    { id: 'r1', uid: 3, folder: 'INBOX', account_id: 'a1', message_id: '<r1@x>', in_reply_to: '<t@x>', from_email: 'bob@x', reaction_parts: parts, reaction_emoji: '👍' },
    { id: 'r2', uid: 4, folder: 'INBOX', account_id: 'a1', message_id: '<r2@x>', in_reply_to: '<t@x>', from_email: 'kim@x', reaction_parts: parts, reaction_emoji: null },
    { id: 'r3', uid: 5, folder: 'INBOX', account_id: 'a1', message_id: '<r3@x>', in_reply_to: '<t@x>', from_email: 'lee@x', reaction_parts: parts, reaction_emoji: '' },
  ];
  query.mockImplementation(async sql => {
    if (sql.includes('JOIN email_accounts a')) return { rows: [{ id: ID, account_id: 'a1', message_id: '<t@x>' }] };
    if (sql.includes('reaction_parts IS NOT NULL')) return { rows };
    if (sql.includes('FROM email_accounts')) return { rows: [{ id: 'a1' }] };
    return { rows: [] };
  });
});

describe('GET /api/mail/messages/:id/reactions', () => {
  it('lists the valid reactions in the message\'s account, reading an unread one first', async () => {
    imapManager.fetchMultipleAttachments.mockResolvedValue(new Map([['2', Buffer.from('{"version":1,"emoji":"🎉"}')]]));
    const res = await fetch(`${base}/api/mail/messages/${ID}/reactions`);
    expect(res.status).toBe(200);
    const { reactions } = await res.json();
    expect(reactions.map(r => [r.id, r.reaction_emoji])).toEqual([['r1', '👍'], ['r2', '🎉']]);
    expect(reactions[0]).not.toHaveProperty('reaction_parts');
    const lookup = query.mock.calls.find(([sql]) => sql.includes('reaction_parts IS NOT NULL'));
    expect(lookup[1]).toEqual(['a1', '<t@x>']);
  });

  it('refuses an id that is not a UUID, and answers 404 for a message the user does not own', async () => {
    expect((await fetch(`${base}/api/mail/messages/nope/reactions`)).status).toBe(400);
    query.mockImplementation(async () => ({ rows: [] }));
    expect((await fetch(`${base}/api/mail/messages/${ID}/reactions`)).status).toBe(404);
  });
});
