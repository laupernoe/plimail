import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: 'user-1' }; next(); },
}));
vi.mock('../index.js', () => ({ imapManager: { connectAccount: vi.fn().mockResolvedValue(undefined) } }));
vi.mock('../services/connectionPolicy.js', () => ({
  getConnectionPolicy: vi.fn().mockResolvedValue({ allowPrivateHosts: false, allowInsecureTls: false, allowNonstandardPorts: false }),
}));

import express from 'express';
import accountRoutes from './accounts.js';
import { query } from '../services/db.js';

const ID = '44444444-4444-4444-4444-444444444444';

describe('mailbox signature default', () => {
  let server, base;
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/accounts', accountRoutes);
    await new Promise(resolve => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}/api/accounts`;
  });
  afterAll(async () => { await new Promise(resolve => server.close(resolve)); });
  beforeEach(() => { query.mockReset(); });

  for (const enabled of [true, false]) {
    it(`saves and returns signature_enabled=${enabled}`, async () => {
      query.mockResolvedValueOnce({ rows: [{ id: ID }] });
      query.mockResolvedValueOnce({ rows: [{ id: ID, signature_enabled: enabled }] });
      const response = await fetch(`${base}/${ID}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ signature_enabled: enabled }),
      });
      expect(response.status).toBe(200);
      expect((await response.json()).signature_enabled).toBe(enabled);
      expect(query.mock.calls[1][0]).toContain('signature_enabled = $1');
      expect(query.mock.calls[1][1]).toEqual([enabled, ID]);
    });
  }

  for (const enabled of [undefined, false]) {
    it(`creates accounts with signature default ${enabled === undefined ? 'on' : 'off'}`, async () => {
      query.mockResolvedValueOnce({ rows: [{ id: ID, signature_enabled: enabled !== false }] });
      const response = await fetch(base, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Mailbox', email_address: 'me@example.com', signature_enabled: enabled }),
      });
      expect(response.status).toBe(200);
      expect((await response.json()).signature_enabled).toBe(enabled !== false);
      expect(query.mock.calls[0][0]).toContain('signature, signature_enabled');
      expect(query.mock.calls[0][1][18]).toBe(enabled !== false);
    });
  }

  it('rejects a non-boolean default before updating the account', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: ID }] });
    const response = await fetch(`${base}/${ID}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signature_enabled: 'false' }),
    });
    expect(response.status).toBe(400);
    expect(query).toHaveBeenCalledTimes(1);
  });

  // Signatures are assigned from the library now; a browser still running the old form sends
  // the signature back with every save.
  it('ignores an unchanged signature in an account update and never writes the column', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: ID }] });
    query.mockResolvedValueOnce({ rows: [{ signature: '<p>Jane</p>' }] });
    query.mockResolvedValueOnce({ rows: [{ id: ID, name: 'Work', signature: '<p>Jane</p>' }] });
    const response = await fetch(`${base}/${ID}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Work', signature: '<p>Jane</p>' }),
    });
    expect(response.status).toBe(200);
    expect(query.mock.calls[2][0]).toContain('SET name = $1 WHERE');
    expect(query.mock.calls[2][0]).not.toMatch(/\bsignature\b/);
  });

  it('refuses a changed signature in an account update instead of dropping it', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: ID }] });
    query.mockResolvedValueOnce({ rows: [{ signature: '<p>Jane</p>' }] });
    const response = await fetch(`${base}/${ID}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Work', signature: '<p>Jane Doe</p>' }),
    });
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('signature_moved');
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('rejects a non-boolean default before creating the account', async () => {
    const response = await fetch(base, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Mailbox', email_address: 'me@example.com', signature_enabled: 'false' }),
    });
    expect(response.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });
});
