import { describe, it, expect, vi } from 'vitest';
vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('./ownership.js', () => ({ findOwnedAccount: vi.fn(), findOwnedMessages: vi.fn() }));
vi.mock('../index.js', () => ({ imapManager: {} }));
vi.mock('./smtpTransport.js', () => ({ createAccountSmtpTransport: vi.fn() }));
vi.mock('../utils/mailUtils.js', () => ({ resolveSentFolder: vi.fn() }));
vi.mock('./draftCopies.js', () => ({ deleteSentDraft: vi.fn(async () => true) }));
import { validateSendInput, buildMailOptions, renderRawMessage, renderPgpMime } from './outgoingMail.js';

const account = { id: 'a1', email_address: 'me@example.com', name: 'Me' };
const identity = { account, plaintextEmail: false, fromName: 'Me', fromEmail: 'me@example.com', replyTo: null, signature: null };
const input = extra => validateSendInput({ accountId: 'a1', to: ['you@example.com'], subject: 'Hi', body: 'Hello', ...extra });
const render = async extra => (await renderRawMessage(buildMailOptions(input(extra), identity))).toString('utf8');

describe('Disposition-Notification-To on a sent message', () => {
  it('is added with the sender address when a receipt is requested', async () => {
    expect(await render({ readReceipt: true })).toMatch(/^Disposition-Notification-To: me@example\.com\r?$/m);
  });

  it('is absent unless requested', async () => {
    expect(await render({})).not.toMatch(/Disposition-Notification-To/i);
    expect(await render({ readReceipt: 'true' })).not.toMatch(/Disposition-Notification-To/i);
  });

  it('goes next to the Autocrypt header, not instead of it', () => {
    const options = buildMailOptions(input({ readReceipt: true }), { ...identity, autocrypt: 'addr=me@example.com; keydata=AAAA' });
    expect(Object.keys(options.headers).sort()).toEqual(['Autocrypt', 'Disposition-Notification-To']);
  });

  it('stays in the clear, outside the ciphertext, of an encrypted message', async () => {
    const armored = '-----BEGIN PGP MESSAGE-----\r\n\r\nAAAA\r\n-----END PGP MESSAGE-----\r\n';
    const options = buildMailOptions(input({ readReceipt: true }), identity);
    const { smtpRaw } = await renderPgpMime(options, armored);
    const text = smtpRaw.toString('latin1');
    const head = text.slice(0, text.indexOf('\r\n\r\n'));
    expect(head).toMatch(/^Disposition-Notification-To: me@example\.com$/m);
    expect(head).toMatch(/multipart\/encrypted/);
  });
});
