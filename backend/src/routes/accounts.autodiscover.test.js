// POST /api/accounts/autodiscover: the servers Add account suggests for an address.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: 'user-1' }; next(); },
}));
vi.mock('../index.js', () => ({ imapManager: {} }));
vi.mock('../services/connectionPolicy.js', () => ({
  getConnectionPolicy: async () => ({ allowPrivateHosts: false, allowNonstandardPorts: true }),
}));
vi.mock('../services/rateLimiter.js', () => ({ consume: vi.fn() }));
vi.mock('../services/accountAutodiscover.js', () => ({ discoverAccountSettings: vi.fn() }));

import express from 'express';
import accountRoutes from './accounts.js';
import { consume } from '../services/rateLimiter.js';
import { discoverAccountSettings } from '../services/accountAutodiscover.js';

let server, base;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/accounts', accountRoutes);
  await new Promise(resolve => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise(resolve => server.close(resolve)); });
beforeEach(() => {
  consume.mockReset().mockResolvedValue({ limited: false, resetMs: 60_000 });
  discoverAccountSettings.mockReset();
});

const post = body => fetch(`${base}/api/accounts/autodiscover`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

const FOUND = {
  source: 'ispdb', domain: 'example.org', username: 'a@example.org', smtpUsername: null, oauth: null, caldavUrl: null,
  imap: { host: 'imap.example.org', port: 993, tls: 'SSL' }, smtp: { host: 'smtp.example.org', port: 587, tls: 'STARTTLS' },
};

describe('POST /api/accounts/autodiscover', () => {
  it('answers with what was found, under the instance policy', async () => {
    discoverAccountSettings.mockResolvedValue(FOUND);
    const res = await post({ email: 'a@example.org' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(FOUND);
    expect(discoverAccountSettings).toHaveBeenCalledWith('a@example.org', { allowPrivate: false, allowNonstandardPorts: true });
    expect(consume).toHaveBeenCalledWith('autodiscover:user-1', expect.any(Number), 60_000);
  });

  it('never passes a password on', async () => {
    discoverAccountSettings.mockResolvedValue(FOUND);
    await post({ email: 'a@example.org', password: 'secret', auth_pass: 'secret' });
    expect(JSON.stringify(discoverAccountSettings.mock.calls)).not.toContain('secret');
  });

  it.each([[{}], [{ email: '' }], [{ email: 5 }], [{ email: `${'a'.repeat(250)}@example.org` }]])('refuses %j', async (body) => {
    expect((await post(body)).status).toBe(400);
    expect(discoverAccountSettings).not.toHaveBeenCalled();
  });

  it('refuses what is not an address', async () => {
    discoverAccountSettings.mockResolvedValue(null);
    expect((await post({ email: 'nobody' })).status).toBe(400);
  });

  it('limits how often one user looks up', async () => {
    consume.mockResolvedValue({ limited: true, resetMs: 30_000 });
    const res = await post({ email: 'a@example.org' });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('30');
    expect(discoverAccountSettings).not.toHaveBeenCalled();
  });

  it('answers 502 when the lookup fails', async () => {
    discoverAccountSettings.mockRejectedValue(new Error('boom'));
    expect((await post({ email: 'a@example.org' })).status).toBe(502);
  });
});
