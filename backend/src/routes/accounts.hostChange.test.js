import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: 'user-1' }; next(); },
}));
vi.mock('../index.js', () => ({ imapManager: { connectAccount: vi.fn().mockResolvedValue(undefined), disconnectAccount: vi.fn().mockResolvedValue(undefined), clearConnectCooldown: vi.fn() } }));
vi.mock('../services/connectionPolicy.js', () => ({
  getConnectionPolicy: vi.fn().mockResolvedValue({ allowPrivateHosts: true, allowInsecureTls: false, allowNonstandardPorts: false }),
}));
vi.mock('../services/encryption.js', () => ({ encrypt: (v) => v }));
vi.mock('../services/hostValidation.js', () => ({ validateHost: vi.fn(async () => null) }));

import express from 'express';
import accountRoutes from './accounts.js';
import { query } from '../services/db.js';

const ID = '44444444-4444-4444-4444-444444444444';

// The stored password goes wherever the account's host points. Moving the host without typing
// the password would let a session alone send it to a server of its choosing.
describe('PUT /api/accounts/:id changing a server', () => {
  let server;
  let base;
  let stored;
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/accounts', accountRoutes);
    await new Promise(resolve => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}/api/accounts`;
  });
  afterAll(async () => { await new Promise(resolve => server.close(resolve)); });
  beforeEach(() => {
    stored = { id: ID, oauth_provider: null, imap_host: 'imap.example.com', smtp_host: 'smtp.example.com', smtp_auth_pass: null };
    query.mockReset().mockImplementation(async (sql) => {
      if (/^SELECT id, oauth_provider, imap_host, smtp_host, smtp_auth_pass FROM email_accounts/.test(sql)) return { rows: [stored] };
      if (/^UPDATE email_accounts/.test(sql)) return { rows: [{ id: ID, protocol: 'imap', enabled: false }] };
      return { rows: [] };
    });
  });

  const put = async (body) => {
    const res = await fetch(`${base}/${ID}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const updated = () => query.mock.calls.some(([sql]) => /^UPDATE email_accounts/.test(sql));
  const same = { name: 'Work', imap_host: 'imap.example.com', imap_port: 993, smtp_host: 'smtp.example.com', smtp_port: 587 };

  it('refuses a new IMAP host without the password, and writes nothing', async () => {
    const r = await put({ ...same, imap_host: 'imap.attacker.example' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('password_required_for_host');
    expect(updated()).toBe(false);
  });

  it('refuses a new SMTP host without the password it logs in with', async () => {
    expect((await put({ ...same, smtp_host: 'smtp.attacker.example' })).status).toBe(400);
    // With its own SMTP password stored, the IMAP one does not stand in for it.
    stored.smtp_auth_pass = 'enc-smtp';
    expect((await put({ ...same, smtp_host: 'smtp.attacker.example', auth_pass: 'imap-pw' })).status).toBe(400);
    expect(updated()).toBe(false);
  });

  it('takes a new host with the password typed', async () => {
    expect((await put({ ...same, imap_host: 'imap.new.example', smtp_host: 'smtp.new.example', auth_pass: 'pw' })).status).toBe(200);
    stored.smtp_auth_pass = 'enc-smtp';
    expect((await put({ ...same, smtp_host: 'smtp.new.example', smtp_auth_user: 'u', smtp_auth_pass: 'smtp-pw' })).status).toBe(200);
    // Clearing the SMTP login falls back to the IMAP password, which is then the one needed.
    expect((await put({ ...same, smtp_host: 'smtp.new.example', smtp_auth_user: null, smtp_auth_pass: null, auth_pass: 'pw' })).status).toBe(200);
  });

  it('saves other settings without the password when the hosts stay the same', async () => {
    expect((await put({ ...same, imap_host: 'IMAP.example.com.', name: 'Renamed' })).status).toBe(200);
    expect((await put({ name: 'Renamed' })).status).toBe(200);
    expect(updated()).toBe(true);
  });
});
