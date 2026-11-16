import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';

// A stand-in for the two tables, answering the SQL services/secureMessages.js sends, with the
// same conditions (openable = not revoked, not locked, not expired).
const { db, rs } = vi.hoisted(() => ({
  db: { messages: new Map(), replies: [], accounts: new Map(), aliases: new Map(), seq: 0, sql: [] },
  rs: { store: new Map() },
}));
vi.mock('../services/db.js', () => {
  const now = () => Date.now();
  const openable = m => m && !m.revoked_at && !m.locked_at && new Date(m.expires_at).getTime() > now();
  const repliesOf = id => db.replies.filter(r => r.secure_message_id === id);
  const withCounts = m => ({
    ...m,
    reply_count: String(repliesOf(m.id).length),
    unread_reply_count: String(repliesOf(m.id).filter(r => !r.read_at).length),
  });
  const id = () => `00000000-0000-4000-8000-${String(++db.seq).padStart(12, '0')}`;
  return {
    query: vi.fn(async (sql, p = []) => {
      db.sql.push(sql);
      const s = sql.replace(/\s+/g, ' ').trim();
      if (s.startsWith('SELECT al.name, al.email FROM account_aliases')) {
        const a = db.aliases.get(p[0]);
        return { rows: a && a.account_id === p[1] && db.accounts.get(p[1])?.user_id === p[2] ? [a] : [] };
      }
      if (s.startsWith('SELECT name, sender_name, email_address FROM email_accounts')) {
        const a = db.accounts.get(p[0]);
        return { rows: a && a.user_id === p[1] ? [a] : [] };
      }
      if (s.startsWith('INSERT INTO secure_messages')) {
        const row = {
          id: id(), token: p[0], user_id: p[1], account_id: p[2], sender_name: p[3], sender_email: p[4],
          recipients: JSON.parse(p[5]), ciphertext: p[6], iv: p[7], salt: p[8], iterations: p[9],
          auth_verifier: p[10], expires_at: p[11], created_at: new Date(), revoked_at: null, locked_at: null,
          first_opened_at: null, last_opened_at: null, open_count: 0, failed_attempts: 0,
        };
        db.messages.set(row.id, row);
        return { rows: [{ id: row.id, expires_at: row.expires_at }] };
      }
      if (s.includes('FROM secure_messages m WHERE m.user_id = $1 ORDER BY')) {
        return { rows: [...db.messages.values()].filter(m => m.user_id === p[0]).map(withCounts) };
      }
      if (s.includes('m.salt, m.iterations FROM secure_messages m WHERE m.id = $1 AND m.user_id = $2')) {
        const m = db.messages.get(p[0]);
        return { rows: m && m.user_id === p[1] ? [withCounts(m)] : [] };
      }
      if (s.startsWith('SELECT id, ciphertext, iv, created_at, read_at FROM secure_message_replies')) {
        return { rows: repliesOf(p[0]) };
      }
      if (s.startsWith('WITH m AS (SELECT id FROM secure_messages WHERE id = $1 AND user_id = $2)')) {
        const m = db.messages.get(p[0]);
        if (!m || m.user_id !== p[1]) return { rows: [] };
        for (const r of repliesOf(m.id)) r.read_at ??= new Date();
        return { rows: [{ id: m.id }] };
      }
      if (s.startsWith('UPDATE secure_messages SET revoked_at')) {
        const m = db.messages.get(p[0]);
        if (!m || m.user_id !== p[1]) return { rows: [] };
        m.revoked_at ??= new Date();
        return { rows: [{ id: m.id }] };
      }
      if (s.startsWith('DELETE FROM secure_messages WHERE id = $1 AND user_id = $2')) {
        const m = db.messages.get(p[0]);
        if (!m || m.user_id !== p[1]) return { rows: [] };
        db.messages.delete(m.id);
        db.replies = db.replies.filter(r => r.secure_message_id !== m.id);
        return { rows: [{ id: m.id }] };
      }
      if (s.startsWith('DELETE FROM secure_messages WHERE expires_at <= NOW()')) {
        const gone = [...db.messages.values()].filter(m => new Date(m.expires_at).getTime() <= now());
        for (const m of gone) db.messages.delete(m.id);
        db.replies = db.replies.filter(r => db.messages.has(r.secure_message_id));
        return { rows: [], rowCount: gone.length };
      }
      if (s.startsWith('SELECT id, user_id, sender_name, sender_email, salt, iterations, expires_at, failed_attempts, auth_verifier FROM secure_messages WHERE token = $1')) {
        const m = [...db.messages.values()].find(x => x.token === p[0]);
        return { rows: openable(m) ? [m] : [] };
      }
      if (s.startsWith('UPDATE secure_messages SET failed_attempts')) {
        const m = db.messages.get(p[0]);
        if (!m || m.locked_at) return { rows: [] };
        m.failed_attempts += 1;
        if (m.failed_attempts >= p[1]) m.locked_at = new Date();
        return { rows: [{ failed_attempts: m.failed_attempts, locked_at: m.locked_at }] };
      }
      if (s.startsWith('UPDATE secure_messages SET open_count')) {
        const m = db.messages.get(p[0]);
        if (!openable(m)) return { rows: [] };
        m.open_count += 1;
        m.first_opened_at ??= new Date();
        m.last_opened_at = new Date();
        return { rows: [{ ciphertext: m.ciphertext, iv: m.iv }] };
      }
      if (s.startsWith('INSERT INTO secure_message_replies')) {
        if (!openable(db.messages.get(p[0])) || repliesOf(p[0]).length >= p[3]) return { rows: [] };
        const r = { id: id(), secure_message_id: p[0], ciphertext: p[1], iv: p[2], created_at: new Date(), read_at: null };
        db.replies.push(r);
        return { rows: [r] };
      }
      throw new Error(`unexpected SQL: ${s}`);
    }),
  };
});
vi.mock('../services/redis.js', () => ({
  redisClient: {
    async incr(k)        { const e = rs.store.get(k) || { v: 0, exp: 0 }; e.v++; rs.store.set(k, e); return e.v; },
    async pExpire(k, ms) { const e = rs.store.get(k); if (e) e.exp = Date.now() + ms; return true; },
    async pTTL(k)        { const e = rs.store.get(k); return e ? (e.exp - Date.now()) : -2; },
    async del(k)         { rs.store.delete(k); return 1; },
  },
}));
vi.mock('../services/pushNotifications.js', () => ({ sendPushToUser: vi.fn(async () => {}) }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, res, next) => {
    if (!req.headers['x-user']) return res.status(401).json({ error: 'Not authenticated' });
    req.session = { userId: req.headers['x-user'] };
    next();
  },
}));

import express from 'express';
import ownerRoutes from './secureMessages.js';
import publicRoutes from './secureMessagesPublic.js';
import { sendPushToUser } from '../services/pushNotifications.js';
import {
  MAX_CIPHERTEXT_BYTES, MAX_FAILED_ATTEMPTS, MAX_REPLIES, MAX_REPLY_BYTES, authKeyMatches, decodeBase64,
  deleteExpiredSecureMessages, parseCreateRequest,
} from '../services/secureMessages.js';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const OTHER_ACCOUNT = '22222222-2222-4222-8222-222222222222';
const ALIAS = '33333333-3333-4333-8333-333333333333';

const authKey = randomBytes(32).toString('hex');
const verifierOf = key => createHash('sha256').update(Buffer.from(key, 'hex')).digest('hex');
const CIPHERTEXT = randomBytes(200).toString('base64');
const createBody = (over = {}) => ({
  accountId: ACCOUNT,
  recipients: ['bob@example.com'],
  ciphertext: CIPHERTEXT,
  iv: randomBytes(12).toString('base64'),
  salt: randomBytes(32).toString('base64'),
  iterations: 600000,
  authVerifier: verifierOf(authKey),
  expiresInDays: 7,
  ...over,
});

const broadcasts = [];
let server, base;

beforeAll(async () => {
  const app = express();
  app.set('trust proxy', 1);
  app.set('imapManager', { broadcast: (event, userId) => broadcasts.push({ event, userId }) });
  app.use('/api/secure-messages', express.json({ limit: '36mb' }));
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/secure-messages', ownerRoutes);
  app.use('/api/s', publicRoutes);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => res.status(500).json({ error: err.message }));
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
});
beforeEach(() => {
  db.messages.clear();
  db.replies = [];
  db.sql.length = 0;
  db.accounts = new Map([
    [ACCOUNT, { id: ACCOUNT, user_id: 'u1', name: 'Maria', sender_name: 'Maria Rossi', email_address: 'maria@example.com' }],
    [OTHER_ACCOUNT, { id: OTHER_ACCOUNT, user_id: 'u2', name: 'Other', sender_name: null, email_address: 'other@example.com' }],
  ]);
  db.aliases = new Map([[ALIAS, { id: ALIAS, account_id: ACCOUNT, name: 'Support', email: 'support@example.com' }]]);
  rs.store.clear();
  broadcasts.length = 0;
  sendPushToUser.mockClear();
});

const json = (path, { method = 'GET', body, user, headers = {}, ip } = {}) => fetch(`${base}${path}`, {
  method,
  headers: {
    ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    ...(user ? { 'X-User': user } : {}),
    ...(ip ? { 'X-Forwarded-For': ip } : {}),
    ...headers,
  },
  body: body !== undefined ? JSON.stringify(body) : undefined,
});

async function create(over = {}, user = 'u1') {
  const res = await json('/api/secure-messages', { method: 'POST', body: createBody(over), user });
  expect(res.status).toBe(201);
  return res.json();
}

const open = (token, key = authKey, ip) => json(`/api/s/${token}/open`, { method: 'POST', body: { authKey: key }, ip });
const reply = (token, { key = authKey, bytes = randomBytes(64), iv = randomBytes(12).toString('base64'), ip } = {}) =>
  fetch(`${base}/api/s/${token}/reply`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream', 'X-Secure-Auth': key, 'X-Secure-IV': iv,
      ...(ip ? { 'X-Forwarded-For': ip } : {}),
    },
    body: bytes,
  });
const rowOf = id => db.messages.get(id);

describe('creating a protected message', () => {
  it('stores the ciphertext as sent and answers with a link, the sender coming from the account', async () => {
    const created = await create();
    expect(created.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(created.url).toMatch(new RegExp(`/s/${created.token}$`));
    expect(created).toMatchObject({ senderName: 'Maria Rossi', senderEmail: 'maria@example.com' });
    const row = rowOf(created.id);
    expect(Buffer.from(row.ciphertext).toString('base64')).toBe(CIPHERTEXT);
    expect(row).toMatchObject({ user_id: 'u1', sender_name: 'Maria Rossi', sender_email: 'maria@example.com', iterations: 600000 });
    const days = (new Date(created.expiresAt) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.99);
    expect(days).toBeLessThan(7.01);
  });

  it('goes out as an alias of the account when asked', async () => {
    const created = await create({ aliasId: ALIAS });
    expect(rowOf(created.id)).toMatchObject({ sender_name: 'Support', sender_email: 'support@example.com' });
  });

  it('refuses an account, or an alias of one, that is not the user\'s', async () => {
    expect((await json('/api/secure-messages', { method: 'POST', body: createBody({ accountId: OTHER_ACCOUNT }), user: 'u1' })).status).toBe(404);
    expect((await json('/api/secure-messages', { method: 'POST', body: createBody({ aliasId: ALIAS }), user: 'u2' })).status).toBe(404);
    expect(db.messages.size).toBe(0);
  });

  it('needs a signed-in user', async () => {
    expect((await json('/api/secure-messages', { method: 'POST', body: createBody() })).status).toBe(401);
  });

  it('allows 1, 7 or 30 days, 7 when not said', async () => {
    for (const d of [1, 30]) await create({ expiresInDays: d });
    const { expiresAt } = await create({ expiresInDays: undefined });
    expect(Math.round((new Date(expiresAt) - Date.now()) / 86_400_000)).toBe(7);
    expect((await json('/api/secure-messages', { method: 'POST', body: createBody({ expiresInDays: 365 }), user: 'u1' })).status).toBe(400);
  });

  it('refuses ciphertext over the cap, and fields that are not what they claim', () => {
    const over = Buffer.alloc(MAX_CIPHERTEXT_BYTES + 1).toString('base64');
    expect(() => parseCreateRequest(createBody({ ciphertext: over }))).toThrow(expect.objectContaining({ status: 413 }));
    expect(parseCreateRequest(createBody({ ciphertext: Buffer.alloc(MAX_CIPHERTEXT_BYTES).toString('base64') })).ciphertext.length)
      .toBe(MAX_CIPHERTEXT_BYTES);
    for (const bad of [
      { ciphertext: 'not base64!' }, { ciphertext: '' }, { iv: randomBytes(16).toString('base64') },
      { salt: randomBytes(4).toString('base64') }, { iterations: 1000 }, { iterations: 6e5 + 0.5 },
      { authVerifier: 'abc' }, { recipients: [] }, { recipients: ['x'.repeat(400)] }, { accountId: 'nope' },
    ]) {
      expect(() => parseCreateRequest(createBody(bad)), JSON.stringify(bad).slice(0, 60)).toThrow();
    }
  });
});

describe('the owner\'s view', () => {
  it('lists messages with their state and counts, never the ciphertext or the verifier', async () => {
    const { id, token } = await create();
    await open(token);
    await reply(token);
    const res = await json('/api/secure-messages', { user: 'u1' });
    expect(res.headers.get('cache-control')).toBe('no-store');
    const text = await res.text();
    expect(text).not.toContain(CIPHERTEXT);
    expect(text).not.toContain(verifierOf(authKey));
    expect(text).not.toContain(token);
    const [m] = JSON.parse(text).messages;
    expect(m).toMatchObject({ id, status: 'active', recipients: ['bob@example.com'], openCount: 1, replyCount: 1, unreadReplyCount: 1 });
    expect(m.firstOpenedAt).toBeTruthy();
  });

  it('shows one with its replies\' ciphertext and the salt to derive the key again, but not the message\'s own', async () => {
    const { id, token } = await create();
    const bytes = randomBytes(80);
    await reply(token, { bytes });
    const res = await json(`/api/secure-messages/${id}`, { user: 'u1' });
    const body = await res.json();
    expect(body).toMatchObject({ id, salt: rowOf(id).salt, iterations: 600000 });
    expect(body.replies).toHaveLength(1);
    expect(body.replies[0].ciphertext).toBe(bytes.toString('base64'));
    expect(JSON.stringify(body)).not.toContain(CIPHERTEXT);
    expect(JSON.stringify(body)).not.toContain(verifierOf(authKey));
    expect((await json(`/api/secure-messages/${id}/read`, { method: 'POST', user: 'u1' })).status).toBe(200);
    expect(db.replies[0].read_at).toBeTruthy();
  });

  it('answers 404 for another user\'s message, whatever is asked of it', async () => {
    const { id } = await create();
    expect((await json(`/api/secure-messages/${id}`, { user: 'u2' })).status).toBe(404);
    expect((await json(`/api/secure-messages/${id}/read`, { method: 'POST', user: 'u2' })).status).toBe(404);
    expect((await json(`/api/secure-messages/${id}/revoke`, { method: 'POST', user: 'u2' })).status).toBe(404);
    expect((await json(`/api/secure-messages/${id}`, { method: 'DELETE', user: 'u2' })).status).toBe(404);
    expect((await (await json('/api/secure-messages', { user: 'u2' })).json()).messages).toEqual([]);
    expect(rowOf(id).revoked_at).toBe(null);
    expect((await json('/api/secure-messages/not-a-uuid', { user: 'u1' })).status).toBe(404);
  });

  it('revoking closes the link; deleting removes the message and its replies', async () => {
    const { id, token } = await create();
    await reply(token);
    expect((await json(`/api/secure-messages/${id}/revoke`, { method: 'POST', user: 'u1' })).status).toBe(200);
    expect((await json(`/api/s/${token}/meta`)).status).toBe(404);
    expect((await open(token)).status).toBe(404);
    expect((await (await json(`/api/secure-messages/${id}`, { user: 'u1' })).json()).status).toBe('revoked');
    expect((await json(`/api/secure-messages/${id}`, { method: 'DELETE', user: 'u1' })).status).toBe(200);
    expect(db.messages.size).toBe(0);
    expect(db.replies).toEqual([]);
  });
});

describe('the recipient', () => {
  it('gets what deriving the key takes from the link, and nothing of the message', async () => {
    const { token, id } = await create();
    const res = await json(`/api/s/${token}/meta`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('x-robots-tag')).toContain('noindex');
    const text = await res.text();
    expect(text).not.toContain(CIPHERTEXT);
    expect(text).not.toContain(verifierOf(authKey));
    expect(JSON.parse(text)).toEqual({
      senderName: 'Maria Rossi', senderEmail: 'maria@example.com', salt: rowOf(id).salt, iterations: 600000,
      expiresAt: new Date(rowOf(id).expires_at).toISOString(), remainingAttempts: MAX_FAILED_ATTEMPTS,
    });
  });

  it('gets the ciphertext with the right key, which counts as an open', async () => {
    const { token, id } = await create();
    const res = await open(token);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ ciphertext: CIPHERTEXT, iv: rowOf(id).iv });
    expect(rowOf(id)).toMatchObject({ open_count: 1, failed_attempts: 0 });
  });

  it('gets no ciphertext with a wrong key, and is told how many tries are left', async () => {
    const { token, id } = await create();
    const res = await open(token, randomBytes(32).toString('hex'));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: 'Wrong password', code: 'wrong_password', remainingAttempts: MAX_FAILED_ATTEMPTS - 1 });
    expect(rowOf(id)).toMatchObject({ open_count: 0, failed_attempts: 1 });
    // A key that is not one is a wrong one too.
    expect((await open(token, 'zz')).status).toBe(401);
    expect((await open(token, null)).status).toBe(401);
  });

  it('locks the message for good at the 10th wrong key, even for the right one after', async () => {
    const { token, id } = await create();
    const wrong = randomBytes(32).toString('hex');
    // Spread over addresses, so the per-address limit is not what stops it.
    for (let i = 1; i < MAX_FAILED_ATTEMPTS; i++) {
      expect((await open(token, wrong, `10.0.0.${i}`)).status).toBe(401);
    }
    const last = await open(token, wrong, '10.0.1.1');
    expect(last.status).toBe(403);
    expect((await last.json()).code).toBe('locked');
    expect(rowOf(id).locked_at).toBeTruthy();
    rs.store.clear();
    expect((await open(token, authKey, '10.0.2.1')).status).toBe(404);
    expect((await json(`/api/s/${token}/meta`)).status).toBe(404);
    expect((await (await json(`/api/secure-messages/${id}`, { user: 'u1' })).json()).status).toBe('locked');
  });

  it('cannot tell an unknown, expired, revoked or locked link apart', async () => {
    const expired = await create();
    rowOf(expired.id).expires_at = new Date(Date.now() - 1000);
    const revoked = await create();
    rowOf(revoked.id).revoked_at = new Date();
    const locked = await create();
    rowOf(locked.id).locked_at = new Date();
    const answers = [];
    for (const token of ['B'.repeat(43), 'short', expired.token, revoked.token, locked.token]) {
      const meta = await json(`/api/s/${token}/meta`);
      answers.push([meta.status, await meta.text()]);
      const opened = await open(token);
      answers.push([opened.status, await opened.text()]);
    }
    expect(new Set(answers.map(a => JSON.stringify(a))).size).toBe(1);
    expect(answers[0][0]).toBe(404);
  });

  it('is rate limited per address and per message', async () => {
    const { token } = await create();
    let status;
    for (let i = 0; i < 30; i++) status = (await open(token, authKey, '10.9.9.9')).status;
    expect(status).toBe(429);
    // Another address still reaches it, until the message's own budget runs out.
    rs.store.clear();
    for (let i = 0; i < 20; i++) expect((await open(token, authKey, `10.8.0.${i}`)).status).toBe(200);
    const res = await open(token, authKey, '10.8.1.1');
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBeTruthy();
  });
});

describe('replies', () => {
  it('are stored with the right key, and the owner hears of it without any content', async () => {
    const { token, id } = await create();
    const bytes = randomBytes(100);
    const res = await reply(token, { bytes });
    expect(res.status).toBe(201);
    expect(Buffer.from(db.replies[0].ciphertext).equals(bytes)).toBe(true);
    expect(broadcasts).toEqual([{ event: { type: 'secure_message_reply', id }, userId: 'u1' }]);
    expect(sendPushToUser).toHaveBeenCalledWith('u1', expect.objectContaining({ body: expect.any(String) }));
  });

  it('are refused with a wrong key, which counts against the message', async () => {
    const { token, id } = await create();
    const res = await reply(token, { key: randomBytes(32).toString('hex') });
    expect(res.status).toBe(401);
    expect(db.replies).toEqual([]);
    expect(rowOf(id).failed_attempts).toBe(1);
    expect(broadcasts).toEqual([]);
  });

  it('are capped in size and in number', async () => {
    const { token } = await create();
    expect((await reply(token, { bytes: randomBytes(MAX_REPLY_BYTES + 1) })).status).toBe(413);
    expect((await reply(token, { bytes: randomBytes(8) })).status).toBe(400);
    expect((await reply(token, { iv: 'short' })).status).toBe(400);
    for (let i = 0; i < MAX_REPLIES; i++) {
      expect((await reply(token, { ip: `10.1.${i}.1` })).status).toBe(201);
      rs.store.clear();
    }
    expect((await reply(token)).status).toBe(409);
    expect(db.replies).toHaveLength(MAX_REPLIES);
  });

  it('are refused once the message has expired', async () => {
    const { token, id } = await create();
    rowOf(id).expires_at = new Date(Date.now() - 1);
    expect((await reply(token)).status).toBe(404);
  });
});

describe('expiry', () => {
  it('the cleanup deletes expired messages and their replies, and nothing else', async () => {
    const keep = await create();
    const gone = await create();
    await reply(gone.token);
    await reply(keep.token);
    rowOf(gone.id).expires_at = new Date(Date.now() - 1000);
    expect(await deleteExpiredSecureMessages()).toBe(1);
    expect([...db.messages.keys()]).toEqual([keep.id]);
    expect(db.replies.map(r => r.secure_message_id)).toEqual([keep.id]);
    expect(db.sql.at(-1)).toBe('DELETE FROM secure_messages WHERE expires_at <= NOW()');
  });
});

describe('helpers', () => {
  it('compare the key by its hash, and reject what is not a 32-byte hex key', () => {
    expect(authKeyMatches(authKey, verifierOf(authKey))).toBe(true);
    expect(authKeyMatches(authKey.toUpperCase(), verifierOf(authKey))).toBe(true);
    expect(authKeyMatches(verifierOf(authKey), verifierOf(authKey))).toBe(false);
    expect(authKeyMatches('', verifierOf(authKey))).toBe(false);
    expect(authKeyMatches(authKey, 'x')).toBe(false);
  });

  it('decode strict base64 only', () => {
    expect(decodeBase64('AAAA')).toEqual(Buffer.alloc(3));
    expect(decodeBase64('AA A=')).toBe(null);
    expect(decodeBase64('AAA')).toBe(null);
    expect(decodeBase64('AAAAAAAAAAAAAAAA', { exactBytes: 12 })).toEqual(Buffer.alloc(12));
    expect(decodeBase64('AAAA', { exactBytes: 12 })).toBe(null);
  });
});
