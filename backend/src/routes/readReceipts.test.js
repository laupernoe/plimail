import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => { req.session = { userId: 'u1' }; next(); } }));
vi.mock('../services/ownership.js', () => ({ findOwnedMessage: vi.fn() }));
const imapManager = vi.hoisted(() => ({ fetchHeadersAndFlags: vi.fn(), setFlag: vi.fn(async () => {}) }));
vi.mock('../index.js', () => ({ imapManager }));
vi.mock('../services/smtpTransport.js', () => ({ createAccountSmtpTransport: vi.fn() }));
import express from 'express';
import routes from './readReceipts.js';
import { query } from '../services/db.js';
import { findOwnedMessage } from '../services/ownership.js';
import { createAccountSmtpTransport } from '../services/smtpTransport.js';

const ID = '11111111-1111-4111-8111-111111111111';
const account = { id: 'a1', email_address: 'bob@example.org', name: 'Bob', sender_name: null };
const message = { id: ID, account_id: 'a1', uid: 7, folder: 'INBOX', message_id: '<orig@example.com>', subject: 'Lunch?', date: '2026-01-02T10:00:00Z', is_bulk: false };
const HEADERS = [
  'Return-Path: <alice@example.com>', 'Message-ID: <orig@example.com>', 'From: Alice <alice@example.com>',
  'Disposition-Notification-To: alice@example.com', 'Subject: Lunch?',
].join('\r\n');

let prefs, sendMail, server, base;
const post = body => fetch(`${base}/api/mail/messages/${ID}/receipt`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const get = () => fetch(`${base}/api/mail/messages/${ID}/receipt`);

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/mail', routes);
  await new Promise(resolve => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise(resolve => server.close(resolve)); });

beforeEach(() => {
  vi.clearAllMocks();
  prefs = {};
  sendMail = vi.fn(async () => ({}));
  findOwnedMessage.mockResolvedValue(message);
  query.mockImplementation(async sql => {
    if (sql.includes('FROM users')) return { rows: [{ preferences: prefs }] };
    if (sql.includes('FROM email_accounts')) return { rows: [account] };
    return { rows: [{ special_use: null }] };
  });
  imapManager.fetchHeadersAndFlags.mockResolvedValue({ headers: HEADERS, flags: ['\\Seen'] });
  imapManager.setFlag.mockResolvedValue(undefined);
  createAccountSmtpTransport.mockResolvedValue({ account, transport: { sendMail } });
});

describe('looking up a receipt request', () => {
  it('offers the request and sends nothing, by default', async () => {
    const res = await get();
    expect(await res.json()).toEqual({ status: 'ok', mode: 'ask', address: 'alice@example.com' });
    expect(sendMail).not.toHaveBeenCalled();
    expect(imapManager.setFlag).not.toHaveBeenCalled();
  });

  it('does not even read the message for a user who never answers', async () => {
    prefs = { readReceiptReply: 'never' };
    expect(await (await get()).json()).toEqual({ status: 'none', mode: 'never' });
    expect(imapManager.fetchHeadersAndFlags).not.toHaveBeenCalled();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('says done for a message already marked $MDNSent', async () => {
    imapManager.fetchHeadersAndFlags.mockResolvedValue({ headers: HEADERS, flags: ['\\Seen', '$MDNSent'] });
    expect((await (await get()).json()).status).toBe('done');
  });

  it('refuses to answer for a uid that now holds another message', async () => {
    imapManager.fetchHeadersAndFlags.mockResolvedValue({ headers: HEADERS.replace('<orig@example.com>', '<other@example.com>'), flags: [] });
    const res = await get();
    expect(res.status).toBe(409);
  });
});

describe('answering a receipt request', () => {
  it('sends a multipart/report to the requested address and marks the message $MDNSent', async () => {
    const res = await post({ action: 'send' });
    expect(await res.json()).toEqual({ status: 'sent' });
    expect(imapManager.setFlag).toHaveBeenCalledWith(account, 7, 'INBOX', '$MDNSent', true);
    expect(sendMail).toHaveBeenCalledTimes(1);
    const { raw, envelope } = sendMail.mock.calls[0][0];
    expect(envelope.to).toEqual(['alice@example.com']);
    expect(raw.toString('latin1')).toMatch(/report-type=disposition-notification/);
    expect(raw.toString('latin1')).toMatch(/Disposition: manual-action\/MDN-sent-manually; displayed/);
  });

  it('does not send a second receipt once $MDNSent is on the message', async () => {
    imapManager.fetchHeadersAndFlags.mockResolvedValue({ headers: HEADERS, flags: ['$MDNSent'] });
    const res = await post({ action: 'send' });
    expect(await res.json()).toEqual({ status: 'done' });
    expect(sendMail).not.toHaveBeenCalled();
    expect(imapManager.setFlag).not.toHaveBeenCalled();
  });

  it('does not send twice when two answers arrive together', async () => {
    let release;
    sendMail.mockImplementation(() => new Promise(resolve => { release = () => resolve({}); }));
    const first = post({ action: 'send' });
    await vi.waitFor(() => expect(sendMail).toHaveBeenCalled());
    const second = await post({ action: 'send' });
    expect(second.status).toBe(409);
    release();
    expect((await first).status).toBe(200);
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it('holds a request from another address than the Return-Path until it is confirmed', async () => {
    imapManager.fetchHeadersAndFlags.mockResolvedValue({ headers: HEADERS.replace('<alice@example.com>', '<bounce@mailer.example.net>'), flags: [] });
    const refused = await post({ action: 'send' });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ status: 'confirm', reason: 'return_path_mismatch' });
    expect(sendMail).not.toHaveBeenCalled();
    expect(imapManager.setFlag).not.toHaveBeenCalled();
    expect((await post({ action: 'send', confirm: true })).status).toBe(200);
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it('never answers spam or a mailing list, even when asked to', async () => {
    imapManager.fetchHeadersAndFlags.mockResolvedValue({ headers: `${HEADERS}\r\nList-Id: <l.example.org>`, flags: [] });
    expect((await post({ action: 'send', confirm: true })).status).toBe(409);
    query.mockImplementation(async sql => (sql.includes('FROM users') ? { rows: [{ preferences: {} }] }
      : sql.includes('FROM email_accounts') ? { rows: [account] } : { rows: [{ special_use: '\\Junk' }] }));
    imapManager.fetchHeadersAndFlags.mockResolvedValue({ headers: HEADERS, flags: [] });
    expect((await post({ action: 'send', confirm: true })).status).toBe(409);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('ignoring marks the message and sends nothing', async () => {
    expect(await (await post({ action: 'ignore' })).json()).toEqual({ status: 'ignored' });
    expect(imapManager.setFlag).toHaveBeenCalledWith(account, 7, 'INBOX', '$MDNSent', true);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('sends nothing when the keyword cannot be stored', async () => {
    imapManager.setFlag.mockRejectedValue(new Error('no flag'));
    expect((await post({ action: 'send' })).status).toBe(502);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('takes the keyword back off when the send fails, so it can be tried again', async () => {
    sendMail.mockRejectedValue(new Error('smtp down'));
    expect((await post({ action: 'send' })).status).toBe(500);
    await vi.waitFor(() => expect(imapManager.setFlag).toHaveBeenLastCalledWith(account, 7, 'INBOX', '$MDNSent', false));
  });

  it('rejects an unknown action', async () => {
    expect((await post({ action: 'auto' })).status).toBe(400);
  });
});
