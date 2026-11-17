import { beforeEach, describe, expect, it, vi } from 'vitest';

// The sender for a scheduled message encrypted in the browser: what it sends is the stored
// ciphertext, as Send sends an encrypted message, and the Sent copy a recovery makes is that
// ciphertext too, never a message of the server's making.
vi.mock('../index.js', () => ({ imapManager: { broadcast: vi.fn() } }));
vi.mock('./db.js', () => ({ query: vi.fn(), pool: { connect: vi.fn() } }));
vi.mock('./pushNotifications.js', () => ({ sendPushToUser: vi.fn() }));
vi.mock('../utils/mailUtils.js', () => ({ resolveSentFolder: vi.fn(async () => 'Sent') }));
vi.mock('./ownership.js', () => ({ findOwnedAccount: vi.fn() }));

import { ScheduledSender, attachmentRows, sealJson, aad } from './scheduledSend.js';
import { findOwnedAccount } from './ownership.js';

const ARMORED = '-----BEGIN PGP MESSAGE-----\r\n\r\nwV4DR2b2udXyHrYSAQdAO6w9yEmS1wxDsLAtYdp7xd1Gs7zR1Ve4YqvNC5o+lG4w\r\n=hYZ0\r\n-----END PGP MESSAGE-----\r\n';
const account = { id: 'a1', user_id: 'u1', enabled: true, email_address: 'me@example.com', name: 'Me', smtp_host: 'smtp.example.com', folder_mappings: {} };

function stored({ payload, attachments }) {
  const row = { id: '22222222-2222-4222-8222-222222222222', user_id: 'u1', account_id: 'a1', version: 1, claim_token: 't1', status: 'sending', send_at: new Date(), smtp_started_at: new Date(), smtp_accepted_at: new Date() };
  row.payload_enc = sealJson(payload, aad.payload(row));
  const chunks = attachmentRows(row.id, 1, attachments);
  return { row, chunks };
}

function fakeDb(chunks) {
  const client = { query: vi.fn(async () => ({ rows: [], rowCount: 1 })), release: vi.fn() };
  return {
    client,
    query: vi.fn(async (sql) => {
      if (sql.includes('FROM scheduled_message_attachments')) return { rows: chunks };
      if (sql.startsWith('SELECT 1 FROM scheduled_messages')) return { rows: [{ '?column?': 1 }] };
      return { rows: [], rowCount: 1 };
    }),
    connect: vi.fn(async () => client),
  };
}

const PAYLOAD = {
  v: 1, messageId: '<abc@example.com>', aliasId: null, to: ['bob@example.net'], cc: [], bcc: ['hidden@example.org'],
  subject: 'Plans', body: '', bodyIsHtml: false, quotedBody: null, quotedBodyHtml: null, signature: null,
  plaintextEmail: false, inReplyTo: null, references: null, priority: 'normal', pgp: true,
};
const CIPHER = { filename: 'encrypted.asc', contentType: 'application/pgp-encrypted', kind: 'pgp', content: Buffer.from(ARMORED, 'latin1') };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('ENCRYPTION_KEY', '7a'.repeat(32));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  findOwnedAccount.mockResolvedValue(account);
});

describe('an encrypted scheduled message', () => {
  it('is built from its stored ciphertext, with nothing next to it', async () => {
    const { row, chunks } = stored({ payload: PAYLOAD, attachments: [CIPHER] });
    const sender = new ScheduledSender({ db: fakeDb(chunks) });
    const built = await sender.build(row, account);
    expect(built.input.pgp.encrypted).toBe(ARMORED);
    expect(built.input.bcc).toEqual(['hidden@example.org']);
    expect(built.forwarded.attachments).toEqual([]);
  });

  it('is refused when its ciphertext is missing or has company, rather than sent some other way', async () => {
    for (const attachments of [[], [CIPHER, { filename: 'a.txt', contentType: 'text/plain', kind: 'upload', content: Buffer.from('x') }]]) {
      const { row, chunks } = stored({ payload: PAYLOAD, attachments });
      await expect(new ScheduledSender({ db: fakeDb(chunks) }).build(row, account)).rejects.toMatchObject({ scheduledCode: 'decrypt_failed' });
    }
    const { row, chunks } = stored({ payload: { ...PAYLOAD, pgp: undefined }, attachments: [CIPHER] });
    await expect(new ScheduledSender({ db: fakeDb(chunks) }).build(row, account)).rejects.toMatchObject({ scheduledCode: 'decrypt_failed' });
  });

  it('gets the ciphertext, Bcc kept, as the Sent copy a recovery makes', async () => {
    const { row, chunks } = stored({ payload: PAYLOAD, attachments: [CIPHER] });
    const imap = { findUidByMessageId: vi.fn(async () => null), appendToSent: vi.fn(async () => ({ uid: 9 })), broadcast: vi.fn() };
    const sender = new ScheduledSender({ db: fakeDb(chunks), imap: () => imap, sleep: async () => {}, sentLookupDelaysMs: [0] });
    await sender.finishAccepted(row);
    expect(imap.appendToSent).toHaveBeenCalledTimes(1);
    const raw = imap.appendToSent.mock.calls[0][2].toString('latin1');
    expect(raw).toMatch(/^Content-Type: multipart\/encrypted; protocol="application\/pgp-encrypted";/m);
    expect(raw).toContain(ARMORED.trim());
    expect(raw).toMatch(/^Bcc: hidden@example\.org\r$/m);
    expect(raw).not.toMatch(/^Content-Type: text\//m);
  });
});
