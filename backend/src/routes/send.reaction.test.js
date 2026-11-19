import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => { req.session = { userId: 'u1' }; next(); } }));
vi.mock('../services/redis.js', () => ({ redisClient: { get: vi.fn(async () => null), set: vi.fn(async () => 'OK'), del: vi.fn(async () => 1) } }));
vi.mock('../index.js', () => ({
  imapManager: {
    appendToSent: vi.fn(async () => ({ uid: 77 })),
    upsertSentMessageRecord: vi.fn(async () => {}),
    syncFolderOnDemand: vi.fn(async () => {}),
  },
}));
vi.mock('../services/smtpTransport.js', () => ({ createAccountSmtpTransport: vi.fn() }));
vi.mock('../services/autocrypt.js', () => ({ autocryptFor: vi.fn(async () => null) }));
vi.mock('../utils/mailUtils.js', () => ({ resolveSentFolder: vi.fn(async () => 'Sent'), draftMessageSql: () => 'false' }));
import express from 'express';
import routes from './send.js';
import { query } from '../services/db.js';
import { imapManager } from '../index.js';
import { redisClient } from '../services/redis.js';
import { createAccountSmtpTransport } from '../services/smtpTransport.js';

const TARGET_ID = '11111111-2222-4333-8444-555555555555';
const account = { id: 'a1', email_address: 'maya@example.com', name: 'Work', sender_name: 'Maya Lindqvist', oauth_provider: null, signature: '<b>sig</b>' };
let target;
let sendMail;
let server, base;

function dbAnswer(sql) {
  if (sql.includes('FROM messages m JOIN email_accounts a')) return [target];
  if (sql.includes('AS is_draft')) return [{ is_draft: false }];
  if (sql.includes('UNION ALL SELECT lower(email), id FROM account_aliases')) return [{ email: 'maya@example.com', alias_id: null }];
  if (sql.includes('COUNT(DISTINCT reaction_emoji)')) return [{ n: 0, same: false }];
  if (sql.includes('FROM email_accounts')) return [account];
  return [{ preferences: {}, id: 'book1' }];
}

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
  target = {
    id: TARGET_ID, account_id: 'a1', message_id: '<orig@example.org>', subject: 'Q4 roadmap', from_name: 'Jonas', from_email: 'jonas@example.org',
    to_addresses: [{ name: 'Maya', email: 'maya@example.com' }], cc_addresses: [{ name: 'Priya', email: 'priya@example.org' }],
    reply_to: [], thread_references: '<root@example.org>', is_bulk: false, list_unsubscribe: null, reaction_emoji: null,
  };
  query.mockImplementation(async sql => ({ rows: dbAnswer(sql) }));
  sendMail = vi.fn(async () => ({}));
  createAccountSmtpTransport.mockResolvedValue({ account, transport: { sendMail } });
});

const react = body => fetch(`${base}/api/mail/send/reaction`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

// The raw MIME's header block and its parts, each as { headers, content }.
function parseMime(raw) {
  const text = raw.toString('latin1');
  const [head, ...rest] = text.split('\r\n\r\n');
  const body = rest.join('\r\n\r\n');
  const boundary = head.match(/boundary="([^"]+)"/)[1];
  const parts = body.split(`--${boundary}`).slice(1, -1).map(chunk => {
    const [h, ...c] = chunk.replace(/^\r\n/, '').split('\r\n\r\n');
    return { headers: h, content: Buffer.from(c.join('').replace(/\r\n/g, ''), 'base64').toString('utf8') };
  });
  return { head, parts };
}

describe('POST /send/reaction', () => {
  it('sends a reply in both reaction formats, with a readable fallback, and saves it to Sent', async () => {
    const res = await react({ messageId: TARGET_ID, emoji: '👍' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, emoji: '👍' });

    const mail = sendMail.mock.calls[0][0];
    expect(mail.envelope).toEqual({ from: 'maya@example.com', to: ['jonas@example.org', 'priya@example.org'] });
    const { head, parts } = parseMime(mail.raw);
    expect(head).toMatch(/^In-Reply-To: <orig@example\.org>$/m);
    expect(head).toMatch(/^References: <root@example\.org> <orig@example\.org>$/m);
    expect(head).toMatch(/^Subject: Re: Q4 roadmap$/m);
    expect(head).toMatch(/^From: Maya Lindqvist <maya@example\.com>$/m);
    expect(head).toMatch(/^To: "?Jonas"? <jonas@example\.org>$/m);
    expect(head).toMatch(/^Cc: "?Priya"? <priya@example\.org>$/m);
    expect(head).toMatch(/^Content-Type: multipart\/alternative;/m);
    expect(head).not.toMatch(/^Bcc:/m);

    expect(parts).toHaveLength(3);
    // RFC 9078: the first part, text/plain, disposition reaction, the emoji alone.
    expect(parts[0].headers).toMatch(/Content-Type: text\/plain; charset=utf-8/);
    expect(parts[0].headers).toMatch(/Content-Disposition: reaction/);
    expect(parts[0].content).toBe('👍\r\n');
    // Gmail's part, between the text and the HTML.
    expect(parts[1].headers).toMatch(/Content-Type: text\/vnd\.google\.email-reaction\+json/);
    expect(JSON.parse(parts[1].content)).toEqual({ version: 1, emoji: '👍' });
    // What any other client shows, and nothing of the original message, signature included.
    expect(parts[2].headers).toMatch(/Content-Type: text\/html/);
    expect(parts[2].content).toContain('Maya Lindqvist reacted 👍 to your message');
    expect(mail.raw.toString('latin1')).not.toContain('sig');

    expect(imapManager.appendToSent).toHaveBeenCalledWith(account, 'Sent', expect.any(Buffer));
    const own = query.mock.calls.find(([sql]) => sql.includes('reaction_emoji = $5'));
    expect(own[1]).toEqual(['a1', 'Sent', 77, expect.stringContaining('"rfc9078"'), '👍']);
  });

  it('refuses something that is not a single emoji, before anything is looked up', async () => {
    for (const emoji of ['ok', '👍👍', '', null]) {
      const res = await react({ messageId: TARGET_ID, emoji });
      expect(res.status).toBe(400);
    }
    expect(sendMail).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it('refuses a mailing list message, as Gmail does', async () => {
    target.list_unsubscribe = '<https://list.example.org/u>';
    const res = await react({ messageId: TARGET_ID, emoji: '👍' });
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('mailing_list');
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('sends one reaction for a double click', async () => {
    redisClient.set.mockResolvedValueOnce(null);
    const res = await react({ messageId: TARGET_ID, emoji: '👍' });
    expect(res.status).toBe(409);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('answers 404 for a message the user does not own', async () => {
    target = undefined;
    const res = await react({ messageId: TARGET_ID, emoji: '👍' });
    expect(res.status).toBe(404);
  });
});
