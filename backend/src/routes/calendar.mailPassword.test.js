import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const MAIL_ID = '44444444-4444-4444-8444-444444444444';
const state = vi.hoisted(() => ({ mail: null, ownerSeen: null }));
vi.mock('../services/db.js', () => ({
  query: vi.fn(async (sql, params) => {
    if (/FROM email_accounts WHERE id = \$1 AND user_id = \$2/.test(sql)) {
      state.ownerSeen = params[1];
      return { rows: state.mail && params[1] === state.mail.user_id && params[0] === state.mail.id ? [state.mail] : [] };
    }
    if (/INSERT INTO caldav_accounts/.test(sql)) {
      return { rows: [{ id: 'a1', name: params[1], server_url: params[2], username: params[3], password: params[4], interval_min: 15 }] };
    }
    return { rows: [], rowCount: 1 };
  }),
}));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _r, n) => { req.session = { userId: 'u1' }; n(); } }));
vi.mock('../services/encryption.js', () => ({ decrypt: v => v.replace(/^enc:/, ''), encrypt: v => `enc:${v}` }));
vi.mock('../services/connectionPolicy.js', () => ({ getConnectionPolicy: async () => ({ allowPrivateHosts: false }) }));
vi.mock('../services/hostValidation.js', () => ({ validateHost: async () => null }));
vi.mock('../services/caldavSync.js', () => ({ syncAccount: vi.fn(async () => ({ ok: true })), credentialsFor: vi.fn(), isSyncing: vi.fn() }));
vi.mock('../services/caldavClient.js', () => ({ discoverCalendars: vi.fn(async () => []), findCalDavServer: vi.fn() }));
vi.mock('../services/calendarInvites.js', () => ({ forgetScheduling: vi.fn(), knownAddresses: vi.fn(async () => []), mailLabels: () => ({}) }));

const express = (await import('express')).default;
const router = (await import('./calendar.js')).default;
const { discoverCalendars, findCalDavServer } = await import('../services/caldavClient.js');

let server;
let base;
const post = async (body) => {
  const r = await fetch(`${base}/c/accounts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, text: await r.text() };
};
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/c', router);
  await new Promise(r => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise(r => server.close(r)));
beforeEach(() => {
  state.mail = { id: MAIL_ID, user_id: 'u1', auth_user: 'noe@example.com', auth_pass: 'enc:s3cret-pass', oauth_provider: null };
  discoverCalendars.mockClear();
});

describe('adding a calendar account with a mail account password', () => {
  it('uses the stored password server side and never returns it', async () => {
    const r = await post({ serverUrl: 'https://dav.example.com/', mailAccountId: MAIL_ID });
    expect(r.status).toBe(200);
    expect(r.text).not.toContain('s3cret-pass');
    expect(r.text).not.toContain('enc:');
    expect(JSON.parse(r.text)).toMatchObject({ serverUrl: 'https://dav.example.com/', username: 'noe@example.com' });
    expect(discoverCalendars).toHaveBeenCalledWith(expect.objectContaining({ serverUrl: 'https://dav.example.com/', username: 'noe@example.com', password: 's3cret-pass' }));
  });

  it('keeps a username the user typed over the mail login', async () => {
    const r = await post({ serverUrl: 'https://dav.example.com/', username: 'other', mailAccountId: MAIL_ID });
    expect(r.status).toBe(200);
    expect(discoverCalendars).toHaveBeenCalledWith(expect.objectContaining({ username: 'other', password: 's3cret-pass' }));
  });

  it("does not use another user's mail account", async () => {
    state.mail.user_id = 'u2';
    const r = await post({ serverUrl: 'https://dav.example.com/', mailAccountId: MAIL_ID });
    expect(r.status).toBe(404);
    expect(state.ownerSeen).toBe('u1');
    expect(discoverCalendars).not.toHaveBeenCalled();
    expect(r.text).not.toContain('s3cret-pass');
  });

  it('refuses an OAuth account', async () => {
    state.mail.oauth_provider = 'google';
    const r = await post({ serverUrl: 'https://dav.example.com/', mailAccountId: MAIL_ID });
    expect(r.status).toBe(400);
    expect(JSON.parse(r.text).error).toMatch(/no password/);
    expect(discoverCalendars).not.toHaveBeenCalled();
  });

  it('refuses an account without a stored password', async () => {
    state.mail.auth_pass = null;
    expect((await post({ serverUrl: 'https://dav.example.com/', mailAccountId: MAIL_ID })).status).toBe(400);
  });

  it('validates the id and the combination', async () => {
    expect((await post({ serverUrl: 'https://dav.example.com/', mailAccountId: 'nope' })).status).toBe(404);
    expect((await post({ serverUrl: 'https://dav.example.com/', mailAccountId: 5 })).status).toBe(404);
    expect((await post({ serverUrl: 'https://dav.example.com/', mailAccountId: MAIL_ID, password: 'x' })).status).toBe(400);
    expect((await post({ mailAccountId: MAIL_ID })).status).toBe(400);
    expect(discoverCalendars).not.toHaveBeenCalled();
  });

  it('does not leak the password when the server rejects it', async () => {
    discoverCalendars.mockRejectedValueOnce(new Error('Login refused'));
    const r = await post({ serverUrl: 'https://dav.example.com/', mailAccountId: MAIL_ID });
    expect(r.status).toBe(400);
    expect(r.text).not.toContain('s3cret-pass');
  });
});

describe('adding the calendars of a mail account', () => {
  const fromMail = async (body) => {
    const r = await fetch(`${base}/c/accounts/from-mail`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, text: await r.text() };
  };
  beforeEach(() => {
    Object.assign(state.mail, { email_address: 'noe@example.com', imap_host: 'imap.example.com', smtp_host: 'smtp.example.com' });
    findCalDavServer.mockReset().mockResolvedValue({ serverUrl: 'https://imap.example.com/', calendars: [] });
  });

  it('tries the mail hosts', async () => {
    const r = await fromMail({ accountId: MAIL_ID });
    expect(r.status).toBe(200);
    expect(findCalDavServer).toHaveBeenCalledWith(['imap.example.com', 'smtp.example.com'], expect.objectContaining({ password: 's3cret-pass' }));
    expect(JSON.parse(r.text)).toMatchObject({ serverUrl: 'https://imap.example.com/' });
  });

  it('tries the server Add account found first', async () => {
    const r = await fromMail({ accountId: MAIL_ID, serverUrl: 'https://dav.example.com/cal/' });
    expect(r.status).toBe(200);
    expect(discoverCalendars).toHaveBeenCalledWith(expect.objectContaining({ serverUrl: 'https://dav.example.com/cal/', password: 's3cret-pass' }));
    expect(findCalDavServer).not.toHaveBeenCalled();
    expect(JSON.parse(r.text)).toMatchObject({ serverUrl: 'https://dav.example.com/cal/' });
  });

  it('falls back to the mail hosts when that server has no calendars', async () => {
    discoverCalendars.mockRejectedValueOnce(new Error('No calendars found for this account'));
    const r = await fromMail({ accountId: MAIL_ID, serverUrl: 'https://dav.example.com/' });
    expect(r.status).toBe(200);
    expect(findCalDavServer).toHaveBeenCalled();
  });

  it('refuses a server URL it would refuse when typed', async () => {
    for (const serverUrl of ['http://dav.example.com/', 'ftp://dav.example.com/', 5]) {
      const r = await fromMail({ accountId: MAIL_ID, serverUrl });
      expect(r.status).toBe(400);
    }
    expect(discoverCalendars).not.toHaveBeenCalled();
  });
});
