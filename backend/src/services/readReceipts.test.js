import { describe, it, expect } from 'vitest';
import {
  readReceiptHeaders, readReceiptAlways, receiptReplyMode, assessReceiptRequest, buildMdn, MDN_SENT_FLAG, folderRole,
} from './readReceipts.js';

const asking = extra => ({ 'disposition-notification-to': 'Alice <alice@example.com>', 'return-path': '<alice@example.com>', ...extra });

describe('requesting a receipt', () => {
  it('names the sender as the address to notify, and only when asked', () => {
    expect(readReceiptHeaders(true, 'me@example.com')).toEqual({ 'Disposition-Notification-To': 'me@example.com' });
    expect(readReceiptHeaders(false, 'me@example.com')).toEqual({});
    expect(readReceiptHeaders(undefined, 'me@example.com')).toEqual({});
    // Only a real boolean true counts: a stored "false" string must not turn it on.
    expect(readReceiptHeaders('false', 'me@example.com')).toEqual({});
  });

  it('is off by default for "always ask", and a receipt reply defaults to asking', () => {
    expect(readReceiptAlways({})).toBe(false);
    expect(readReceiptAlways({ readReceiptRequestAlways: true })).toBe(true);
    expect(receiptReplyMode({})).toBe('ask');
    expect(receiptReplyMode({ readReceiptReply: 'bogus' })).toBe('ask');
    expect(receiptReplyMode({ readReceiptReply: 'always' })).toBe('always');
    expect(receiptReplyMode({ readReceiptReply: 'never' })).toBe('never');
  });
});

describe('assessReceiptRequest', () => {
  it('has nothing to say about a message that asks for nothing', () => {
    expect(assessReceiptRequest({ headers: { subject: 'Hi' } }).status).toBe('none');
  });

  it('allows a request whose address is the Return-Path', () => {
    expect(assessReceiptRequest({ headers: asking() })).toEqual({ status: 'ok', address: 'alice@example.com' });
  });

  it('is done once $MDNSent is on the message, whatever the case of the keyword', () => {
    expect(assessReceiptRequest({ headers: asking(), flags: ['\\Seen', MDN_SENT_FLAG] }).status).toBe('done');
    expect(assessReceiptRequest({ headers: asking(), flags: ['$mdnsent'] }).status).toBe('done');
  });

  it('needs confirmation when the address differs from the Return-Path', () => {
    const r = assessReceiptRequest({ headers: asking({ 'return-path': '<bounce@mailer.example.net>' }) });
    expect(r).toEqual({ status: 'confirm', address: 'alice@example.com', reason: 'return_path_mismatch' });
  });

  it('needs confirmation when the Return-Path is empty or several addresses are named', () => {
    expect(assessReceiptRequest({ headers: asking({ 'return-path': '<>' }) }).status).toBe('confirm');
    const many = assessReceiptRequest({ headers: asking({ 'disposition-notification-to': 'a@example.com, b@example.com', 'return-path': '<a@example.com>' }) });
    expect(many).toMatchObject({ status: 'confirm', reason: 'multiple_addresses', address: 'a@example.com' });
  });

  it('compares addresses without regard to case', () => {
    expect(assessReceiptRequest({ headers: asking({ 'return-path': '<ALICE@Example.com>' }) }).status).toBe('ok');
  });

  it('never answers spam, mailing lists or automatic messages', () => {
    for (const extra of [
      { 'x-spam-flag': 'YES' },
      { 'x-spam-status': 'Yes, score=9.1' },
      { 'list-id': '<dev.lists.example.org>' },
      { 'list-unsubscribe': '<mailto:u@example.org>' },
      { precedence: 'bulk' },
      { 'content-type': 'multipart/report; report-type=disposition-notification' },
      { 'auto-submitted': 'auto-generated' },
    ]) {
      expect(assessReceiptRequest({ headers: asking(extra) }).status, JSON.stringify(extra)).toBe('blocked');
    }
    expect(assessReceiptRequest({ headers: asking(), message: { is_bulk: true } }).status).toBe('blocked');
    expect(assessReceiptRequest({ headers: asking({ 'x-spam-status': 'No, score=0.1' }) }).status).toBe('ok');
  });

  it('never answers from the spam folder, drafts or sent mail', () => {
    for (const special of ['\\Junk', '\\Spam', '\\Drafts', '\\Sent']) {
      expect(assessReceiptRequest({ headers: asking(), role: folderRole(special) }).status, special).toBe('blocked');
    }
    expect(assessReceiptRequest({ headers: asking(), role: folderRole('\\Trash') }).status).toBe('ok');
  });
});

describe('buildMdn', () => {
  const build = (overrides = {}) => buildMdn({
    fromName: 'Bob', fromEmail: 'bob@example.org', to: 'alice@example.com',
    original: { messageId: '<orig-1@example.com>', subject: 'Lunch?', date: '2026-01-02T10:00:00Z' },
    now: new Date('2026-01-03T00:00:00Z'), ...overrides,
  });
  const text = async o => (await build(o)).raw.toString('latin1');

  it('is a multipart/report of the disposition-notification type', async () => {
    const raw = await text();
    const head = raw.slice(0, raw.indexOf('\r\n\r\n'));
    expect(head).toMatch(/^Content-Type: multipart\/report; report-type=disposition-notification;\r\n boundary="[^"]+"$/mi);
    expect(head.match(/^content-type:/gim)).toHaveLength(1);
    expect(head).toMatch(/^From: Bob <bob@example.org>$/m);
    expect(head).toMatch(/^To: alice@example.com$/m);
    expect(head).toMatch(/^Subject: Read: Lunch\?$/m);
    expect(head).toMatch(/^In-Reply-To: <orig-1@example.com>$/m);
    expect(head).toMatch(/^References: <orig-1@example.com>$/m);
    expect(head).toMatch(/^MIME-Version: 1.0$/m);
  });

  it('carries a readable part and a message/disposition-notification part', async () => {
    const raw = await text();
    const boundary = /boundary="([^"]+)"/.exec(raw)[1];
    const parts = raw.split(`--${boundary}`).slice(1, -1);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatch(/Content-Type: text\/plain; charset=utf-8/);
    const readable = Buffer.from(parts[0].split('\r\n\r\n')[1].replace(/\s+/g, ''), 'base64').toString('utf8');
    expect(readable).toContain('Lunch?');
    expect(parts[1]).toMatch(/^\r\nContent-Type: message\/disposition-notification\r\n\r\n/);
    const fields = parts[1].split('\r\n\r\n')[1];
    expect(fields).toMatch(/^Reporting-UA: example\.org; .+$/m);
    expect(fields).toMatch(/^Final-Recipient: rfc822; bob@example\.org$/m);
    expect(fields).toMatch(/^Original-Message-ID: <orig-1@example.com>$/m);
    expect(fields).toMatch(/^Disposition: manual-action\/MDN-sent-manually; displayed$/m);
    expect(raw.trimEnd().endsWith(`--${boundary}--`)).toBe(true);
  });

  it('goes to the requested address only, from the account address', async () => {
    const mdn = await build();
    expect(mdn.envelope).toEqual({ from: 'bob@example.org', to: ['alice@example.com'] });
    expect(mdn.messageId).toMatch(/^<[0-9a-f]{32}@example\.org>$/);
  });

  it('cannot be given extra headers or lines through the original subject', async () => {
    const raw = await text({ original: { messageId: '<a@b>', subject: 'Hi\r\nBcc: evil@example.net', date: null } });
    const head = raw.slice(0, raw.indexOf('\r\n\r\n'));
    expect(head).not.toMatch(/^Bcc:/mi);
  });

  it('encodes a non-ASCII subject as an encoded word', async () => {
    const raw = await text({ original: { messageId: '<a@b>', subject: 'Déjeuner ?', date: null } });
    expect(raw.slice(0, raw.indexOf('\r\n\r\n'))).toMatch(/^Subject: =\?UTF-8\?/m);
  });
});
