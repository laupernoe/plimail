import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('./db.js', () => ({ query: vi.fn(async () => ({ rows: [] })) }));
vi.mock('./ownership.js', () => ({ findOwnedAccount: vi.fn(), findOwnedMessages: vi.fn() }));
vi.mock('../index.js', () => ({
  imapManager: {
    appendToSent: vi.fn(async () => ({ uid: 5 })),
    upsertSentMessageRecord: vi.fn(async () => {}),
    syncFolderOnDemand: vi.fn(async () => {}),
  },
}));
vi.mock('./smtpTransport.js', () => ({ createAccountSmtpTransport: vi.fn() }));
vi.mock('../utils/mailUtils.js', () => ({ resolveSentFolder: vi.fn(async () => 'Sent') }));
vi.mock('./draftCopies.js', () => ({ deleteSentDraft: vi.fn(async () => true) }));
import nodemailer from 'nodemailer';
import { imapManager } from '../index.js';
import { createAccountSmtpTransport } from './smtpTransport.js';
import {
  SendError, buildMailOptions, deliverAndRecord, prepareDelivery, renderPgpMime, renderRawMessage, validateSendInput,
} from './outgoingMail.js';

const ARMORED = '-----BEGIN PGP MESSAGE-----\n\nwV4DR2b2udXyHrYSAQdAO6w9yEmS1wxDsLAtYdp7xd1Gs7zR1Ve4YqvNC5o+lG4w\n=hYZ0\n-----END PGP MESSAGE-----\n';
const account = { id: 'a1', email_address: 'me@example.com', name: 'Me', sender_name: null, oauth_provider: null, smtp_host: 'smtp.example.com' };
const identity = { account, plaintextEmail: false, fromName: 'Zoë Me', fromEmail: 'me@example.com', replyTo: null, signature: '<b>Signature in the clear</b>' };
const send = extra => validateSendInput({
  accountId: 'a1', to: ['Bob <bob@example.net>'], cc: ['carol@example.org'], bcc: ['hidden@example.com'],
  subject: 'Réunion', pgp: { encrypted: ARMORED }, inReplyTo: '<prev@example.net>', references: '<root@example.net> <prev@example.net>', ...extra,
});
const thrown = fn => { try { fn(); } catch (err) { return err; } return null; };

beforeEach(() => vi.clearAllMocks());

describe('validateSendInput with pgp', () => {
  it('keeps the armored ciphertext, with CRLF line ends', () => {
    const input = send();
    expect(input.pgp.encrypted.startsWith('-----BEGIN PGP MESSAGE-----\r\n\r\nwV4D')).toBe(true);
    expect(input.pgp.encrypted).not.toMatch(/[^\r]\n/);
  });

  it('refuses anything that is not an armored message', () => {
    for (const bad of ['hello', { encrypted: 'plain text' }, { encrypted: `${ARMORED}é` }, { encrypted: 42 }, []]) {
      const err = thrown(() => send({ pgp: bad }));
      expect(err, JSON.stringify(bad)).toBeInstanceOf(SendError);
      expect(err.status).toBe(400);
    }
  });

  it('refuses files the server would add next to the ciphertext, in the clear', () => {
    expect(thrown(() => send({ attachments: [{ filename: 'a.pdf', content: 'AAAA' }] }))?.status).toBe(400);
    expect(thrown(() => send({ forwardedMessages: ['11111111-1111-4111-8111-111111111111'] }))?.status).toBe(400);
  });
});

describe('PGP/MIME assembly', () => {
  it('puts nothing of its own in the message: no text, no HTML, no signature, no files', () => {
    const options = buildMailOptions(send({ body: 'leaked?', bodyIsHtml: false }), identity);
    expect(options.text).toBeUndefined();
    expect(options.html).toBeUndefined();
    expect(options.attachments).toBeUndefined();
    expect(options.inReplyTo).toBe('<prev@example.net>');
  });

  it('builds RFC 3156 multipart/encrypted with the outer headers, Bcc only on the Sent copy', async () => {
    const options = buildMailOptions(send(), identity);
    const { smtpRaw, sentRaw } = await renderPgpMime(options, send().pgp.encrypted);
    const smtp = smtpRaw.toString('latin1');
    const sent = sentRaw.toString('latin1');
    const cut = smtp.indexOf('\r\n\r\n');
    const head = smtp.slice(0, cut);
    const body = smtp.slice(cut + 4);
    expect(head).toMatch(/^Content-Type: multipart\/encrypted; protocol="application\/pgp-encrypted";\r\n boundary="([^"]+)"$/m);
    const boundary = /boundary="([^"]+)"/.exec(head)[1];
    expect(head).toMatch(/^Subject: =\?UTF-8\?/m); // the subject, encoded as nodemailer encodes any
    expect(head).toMatch(/^From: =\?UTF-8\?Q\?Zo=C3=AB_Me\?= <me@example\.com>$/m);
    expect(head).toMatch(/^To: Bob <bob@example\.net>$/m);
    expect(head).toMatch(/^Cc: carol@example\.org$/m);
    expect(head).toMatch(/^In-Reply-To: <prev@example\.net>$/m);
    expect(head).toMatch(/^References: <root@example\.net> <prev@example\.net>$/m);
    expect(head).toMatch(new RegExp(`^Message-ID: ${options.messageId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
    expect(head).toMatch(/^MIME-Version: 1\.0$/m);
    expect(head).not.toMatch(/^Content-Transfer-Encoding/m);
    expect(head).not.toMatch(/^Bcc:/m);
    expect(sent).toMatch(/^Bcc: hidden@example\.com$/m);
    // Two parts: the version, then the ciphertext as it came.
    const parts = body.split(`--${boundary}`);
    expect(parts).toHaveLength(4);
    expect(parts[1]).toBe('\r\nContent-Type: application/pgp-encrypted\r\nContent-Description: PGP/MIME version identification\r\n\r\nVersion: 1\r\n\r\n');
    expect(parts[2]).toContain('Content-Type: application/octet-stream; name="encrypted.asc"');
    expect(parts[2]).toContain(send().pgp.encrypted.replace(/\r\n$/, ''));
    expect(parts[3]).toBe('--\r\n');
    // Nothing of the signature or a body went out.
    expect(smtp).not.toContain('Signature in the clear');
    expect(smtp).not.toMatch(/[^\r]\n/);
  });

  it('is sent exactly as built: nodemailer adds nothing to a raw message', async () => {
    const options = buildMailOptions(send(), identity);
    const { smtpRaw } = await renderPgpMime(options, send().pgp.encrypted);
    const out = await renderRawMessage({ ...options, raw: smtpRaw });
    expect(Buffer.compare(out, smtpRaw)).toBe(0);
  });

  it('delivers to every recipient, Bcc included, and keeps the readable Sent copy', async () => {
    const sendMail = vi.fn(async () => ({ accepted: [], rejected: [] }));
    createAccountSmtpTransport.mockResolvedValue({ account, transport: { sendMail } });
    const input = send();
    const delivery = await prepareDelivery(input, identity, { attachments: [], messages: [] });
    expect(delivery.mailOptions.envelope).toEqual({ from: 'me@example.com', to: ['bob@example.net', 'carol@example.org', 'hidden@example.com'] });
    expect(delivery.rawMessage.toString('latin1')).toMatch(/^Bcc: hidden@example\.com$/m);
    // The Sent copy is still an encrypted message to whoever reads it, the sender included.
    expect(delivery.rawMessage.toString('latin1')).toMatch(/^Content-Type: multipart\/encrypted; protocol="application\/pgp-encrypted";/m);

    // Through a real (stream) transport, what goes on the wire is the raw message, without Bcc.
    const wire = await nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'windows' }).sendMail(delivery.mailOptions);
    expect(wire.message.toString('latin1')).not.toMatch(/^Bcc:/m);
    expect(wire.envelope.to).toEqual(['bob@example.net', 'carol@example.org', 'hidden@example.com']);

    const result = await deliverAndRecord({ userId: 'u1', input, identity, delivery });
    expect(result.ok).toBe(true);
    expect(sendMail).toHaveBeenCalledWith(delivery.mailOptions);
    expect(imapManager.appendToSent).toHaveBeenCalledWith(account, 'Sent', delivery.rawMessage);
    // The Sent row's snippet says "encrypted", never any text.
    const meta = imapManager.upsertSentMessageRecord.mock.calls[0][3];
    expect(meta.snippet).toBe('-----BEGIN PGP MESSAGE-----');
  });
});
