import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'crypto';

// Send later for a message encrypted in the browser (RFC 3156): the server stores the ciphertext
// as it came, as the message's one attachment, and nothing of the text. It used to refuse it, since
// a scheduled message stored only its plain content.
vi.mock('../services/db.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => { req.session = { userId: 'u1' }; next(); } }));
vi.mock('../index.js', () => ({ imapManager: { broadcast: vi.fn() } }));
vi.mock('../services/ownership.js', () => ({
  findOwnedAccount: vi.fn(), findOwnedAlias: vi.fn(), findOwnedScheduledMessage: vi.fn(),
}));
vi.mock('../services/rateLimiter.js', () => ({ consume: vi.fn() }));
vi.mock('../services/draftCopies.js', () => ({ deleteSentDraft: vi.fn() }));
vi.mock('../services/outgoingMail.js', async importOriginal => ({
  ...(await importOriginal()),
  resolveIdentity: vi.fn(async (_u, input) => ({ account: { id: input.accountId }, fromEmail: 'me@example.com', signature: '<b>sig in the clear</b>', plaintextEmail: false })),
  resolveForwarded: vi.fn(async () => ({ attachments: [], messages: [] })),
}));

import 'express-async-errors';
import express from 'express';
import routes from './scheduled.js';
import { query, withTransaction } from '../services/db.js';
import { findOwnedAccount, findOwnedScheduledMessage } from '../services/ownership.js';
import { consume } from '../services/rateLimiter.js';
import { aad, openJson } from '../services/scheduledSend.js';
import { decryptBytes } from '../services/encryption.js';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const ARMORED = '-----BEGIN PGP MESSAGE-----\n\nwV4DR2b2udXyHrYSAQdAO6w9yEmS1wxDsLAtYdp7xd1Gs7zR1Ve4YqvNC5o+lG4w\n=hYZ0\n-----END PGP MESSAGE-----\n';
let server, base;
beforeAll(async () => {
  const app = express();
  app.use(express.json({ limit: '35mb' }));
  app.use('/api/mail', routes);
  await new Promise(resolve => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}/api/mail/scheduled`;
});
afterAll(() => new Promise(resolve => server.close(resolve)));

// What the transaction writes, for the test to read back.
let writes;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('ENCRYPTION_KEY', '6e'.repeat(32));
  query.mockResolvedValue({ rows: [] });
  consume.mockResolvedValue({ limited: false });
  findOwnedAccount.mockResolvedValue({ id: ACCOUNT, enabled: true });
  findOwnedScheduledMessage.mockResolvedValue(null);
  writes = [];
  const client = {
    query: vi.fn(async (sql, params) => {
      writes.push({ sql, params });
      if (sql.includes('COUNT(*)')) return { rows: [{ pending: 0, bytes: 0 }] };
      if (sql.startsWith('\n    INSERT INTO scheduled_messages') || sql.includes('INSERT INTO scheduled_messages')) return { rows: [{ id: params[0] }] };
      return { rows: [] };
    }),
  };
  withTransaction.mockImplementation(async fn => fn(client));
});

const create = extra => fetch(base, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    accountId: ACCOUNT, to: ['you@example.net'], bcc: ['hidden@example.org'], subject: 'Hi', body: '',
    sendAt: new Date(Date.now() + 3_600_000).toISOString(), clientKey: randomUUID(), pgp: { encrypted: ARMORED }, ...extra,
  }),
}).then(async res => ({ status: res.status, body: await res.json().catch(() => null) }));

describe('POST /scheduled with pgp', () => {
  it('stores the ciphertext as it came, and no text, signature or quote of its own', async () => {
    const r = await create({ quotedBody: '> what was said' });
    expect(r.status).toBe(201);
    const insert = writes.find(w => w.sql.includes('INSERT INTO scheduled_messages'));
    const [id, userId] = insert.params;
    const row = { id, user_id: userId, version: 1 };
    const payload = openJson(insert.params[7], aad.payload(row));
    expect(payload).toMatchObject({ v: 1, pgp: true, body: '', quotedBody: null, signature: null, bcc: ['hidden@example.org'] });
    expect(JSON.stringify(payload)).not.toContain('what was said');
    const summary = openJson(insert.params[6], aad.summary(row));
    expect(summary).toMatchObject({ subject: 'Hi', snippet: '-----BEGIN PGP MESSAGE-----', bccCount: 1, attachmentCount: 1 });

    const chunks = writes.filter(w => w.sql.includes('INSERT INTO scheduled_message_attachments'));
    expect(chunks).toHaveLength(1);
    const [, attachmentIndex, chunkIndex, metaEnc, dataEnc] = chunks[0].params;
    expect(openJson(metaEnc, aad.meta(id, attachmentIndex, 1))).toMatchObject({ kind: 'pgp', contentType: 'application/pgp-encrypted' });
    const data = decryptBytes(dataEnc, { purpose: 'scheduled-send', aad: aad.chunk(id, attachmentIndex, chunkIndex, 1) });
    expect(data.toString('latin1')).toBe(ARMORED.trim().replace(/\n/g, '\r\n') + '\r\n');
  });

  it('refuses a pgp field that is not an armored message', async () => {
    const r = await create({ pgp: { encrypted: 'hello' } });
    expect(r.status).toBe(400);
    expect(withTransaction).not.toHaveBeenCalled();
  });
});
