import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: 'user-1' }; next(); },
}));
const imapManager = vi.hoisted(() => ({
  appendToFolder: vi.fn(),
  findUidByMessageId: vi.fn(),
  upsertDraftMessageRecord: vi.fn(),
  permanentDeleteMessage: vi.fn(),
  syncFolderOnDemand: vi.fn(),
  broadcast: vi.fn(),
  scheduleCountRefresh: vi.fn(),
}));
vi.mock('../index.js', () => ({ imapManager }));

import express from 'express';
import draftRoutes from './draft.js';
import { query } from '../services/db.js';

// A draft of a message that goes encrypted is encrypted in the browser to the user's own key. The
// server stores the ciphertext under the draft's headers, on IMAP and in its row, and nothing of
// the text: it used to append it in the clear to Drafts and keep its body in the row.

const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const ACCOUNT_ROW = {
  id: ACCOUNT_ID, email_address: 'me@example.com', name: 'Me',
  sender_name: null, signature: '<b>Account signature in the clear</b>', folder_mappings: {},
};
const ARMORED = '-----BEGIN PGP MESSAGE-----\n\nwV4DR2b2udXyHrYSAQdAO6w9yEmS1wxDsLAtYdp7xd1Gs7zR1Ve4YqvNC5o+lG4w\n=hYZ0\n-----END PGP MESSAGE-----\n';

describe('POST /api/mail/draft with pgp', () => {
  let server, base;
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/mail', draftRoutes);
    await new Promise(r => { server = app.listen(0, r); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => { await new Promise(r => server.close(r)); });
  beforeEach(() => {
    vi.clearAllMocks();
    query.mockReset();
    query.mockResolvedValueOnce({ rows: [{ id: ACCOUNT_ID }] });
    query.mockResolvedValueOnce({ rows: [ACCOUNT_ROW] });
    query.mockResolvedValueOnce({ rows: [{ path: 'Drafts' }] });
    imapManager.appendToFolder.mockResolvedValue({ uid: 7, folder: 'Drafts' });
    imapManager.upsertDraftMessageRecord.mockResolvedValue(undefined);
  });

  const save = body => fetch(`${base}/api/mail/draft`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accountId: ACCOUNT_ID, to: ['Bob <bob@example.net>'], bcc: ['hidden@example.com'], subject: 'Plans', ...body }),
  });

  it('appends the ciphertext as PGP/MIME, with the headers and the Bcc, and no text of its own', async () => {
    const res = await save({ pgp: { encrypted: ARMORED }, inReplyTo: '<prev@example.net>' });
    expect(res.status).toBe(200);
    const [, folder, raw, flags] = imapManager.appendToFolder.mock.calls[0];
    expect(folder).toBe('Drafts');
    expect(flags).toEqual(['\\Draft', '\\Seen']);
    const text = raw.toString('latin1');
    expect(text).toMatch(/^Content-Type: multipart\/encrypted; protocol="application\/pgp-encrypted";/m);
    expect(text).toContain('-----BEGIN PGP MESSAGE-----\r\n\r\nwV4D');
    expect(text).toMatch(/^Subject: Plans\r$/m);
    expect(text).toMatch(/^Bcc: hidden@example\.com\r$/m);
    expect(text).toMatch(/^In-Reply-To: <prev@example\.net>\r$/m);
    expect(text).not.toContain('Account signature');
    expect(text).not.toMatch(/^Content-Type: text\//m);
  });

  it('keeps no body in the row, only the encrypted marker', async () => {
    expect((await save({ pgp: { encrypted: ARMORED } })).status).toBe(200);
    const [, , uid, meta] = imapManager.upsertDraftMessageRecord.mock.calls[0];
    expect(uid).toBe(7);
    expect(meta.bodyHtml).toBeNull();
    expect(meta.bodyText).toBeNull();
    expect(meta.snippet).toBe('-----BEGIN PGP MESSAGE-----');
    expect(meta.bcc).toEqual([{ name: '', email: 'hidden@example.com' }]);
  });

  it('refuses content next to the ciphertext rather than store it in the clear', async () => {
    query.mockReset().mockResolvedValue({ rows: [{ id: ACCOUNT_ID }] });
    for (const extra of [{ body: 'leaked' }, { quotedBody: '> leaked' }, { editedSignature: 'leaked' },
      { attachments: [{ filename: 'a.txt', contentBase64: 'QUFB' }] }]) {
      const res = await save({ pgp: { encrypted: ARMORED }, ...extra });
      expect(res.status, JSON.stringify(extra)).toBe(400);
    }
    expect(imapManager.appendToFolder).not.toHaveBeenCalled();
  });

  it('refuses a pgp field that is not an armored message', async () => {
    const res = await save({ pgp: { encrypted: 'plain text' } });
    expect(res.status).toBe(400);
    expect(imapManager.appendToFolder).not.toHaveBeenCalled();
  });
});
