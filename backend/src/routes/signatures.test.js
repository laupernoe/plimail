import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: req.headers['x-user'] }; next(); },
}));

import express from 'express';
import routes from './signatures.js';
import { query, withTransaction } from '../services/db.js';

const SIG = '55555555-5555-4555-8555-555555555555';
const ACCOUNT = '44444444-4444-4444-4444-444444444444';

// The routes against a mocked database: the user id comes from the session and goes into every
// statement, and a miss is a 404, never another user's row.
describe('/api/signatures', () => {
  let server, base;
  const client = { query: vi.fn() };
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/signatures', routes);
    await new Promise(resolve => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}/api/signatures`;
  });
  afterAll(async () => { await new Promise(resolve => server.close(resolve)); });
  beforeEach(() => {
    query.mockReset();
    client.query.mockReset();
    withTransaction.mockReset().mockImplementation(fn => fn(client));
  });
  const send = (method, path, body, user = 'user-1') => fetch(base + path, {
    method, headers: { 'Content-Type': 'application/json', 'X-User': user }, body: body && JSON.stringify(body),
  });

  it("lists the session user's signatures, sanitized", async () => {
    query.mockResolvedValueOnce({ rows: [{ id: SIG, name: 'Formal', html: '<p>Hi</p><script>x()</script>' }] });
    const res = await send('GET', '');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ id: SIG, name: 'Formal', html: '<p>Hi</p>' }]);
    expect(query.mock.calls[0][0]).toContain('WHERE user_id = $1');
    expect(query.mock.calls[0][1]).toEqual(['user-1']);
  });

  it('creates a signature for the session user with a name and sanitized html', async () => {
    client.query.mockResolvedValueOnce({ rows: [{ id: SIG, name: 'Formal', html: '<p>Hi</p>' }] });
    const res = await send('POST', '', { name: '  Formal ', html: '<p onclick="x()">Hi</p>' });
    expect(res.status).toBe(201);
    expect(client.query.mock.calls[0][1].slice(0, 3)).toEqual(['user-1', 'Formal', '<p>Hi</p>']);
  });

  it('refuses a signature without a name', async () => {
    const res = await send('POST', '', { name: ' ', html: '<p>Hi</p>' });
    expect(res.status).toBe(400);
    expect(client.query).not.toHaveBeenCalled();
  });

  it('answers 404 for an id that is not one of the user’s signatures', async () => {
    client.query.mockResolvedValueOnce({ rows: [] });
    expect((await send('PUT', `/${SIG}`, { html: '<p>x</p>' }, 'user-2')).status).toBe(404);
    expect(client.query.mock.calls[0][0]).toContain('WHERE id = $1 AND user_id = $2');
    expect(client.query.mock.calls[0][1].slice(0, 2)).toEqual([SIG, 'user-2']);
    expect(client.query).toHaveBeenCalledTimes(1);

    client.query.mockReset().mockResolvedValueOnce({ rows: [] });
    expect((await send('DELETE', `/${SIG}`, undefined, 'user-2')).status).toBe(404);
    expect(client.query).toHaveBeenCalledTimes(1);

    expect((await send('PUT', '/not-a-uuid', { name: 'x' })).status).toBe(404);
  });

  it('assigns only a signature and an account of the session user', async () => {
    client.query.mockResolvedValueOnce({ rows: [] });
    const res = await send('PUT', '/assignment', { accountId: ACCOUNT, signatureId: SIG }, 'user-2');
    expect(res.status).toBe(404);
    expect(client.query.mock.calls[0][1]).toEqual([SIG, 'user-2']);

    client.query.mockReset()
      .mockResolvedValueOnce({ rows: [{ html: '<p>Hi</p>' }] })
      .mockResolvedValueOnce({ rowCount: 0 });
    expect((await send('PUT', '/assignment', { accountId: ACCOUNT, signatureId: SIG })).status).toBe(404);
    expect(client.query.mock.calls[1][0]).toContain('WHERE id = $3 AND user_id = $4');
    expect(client.query.mock.calls[1][1]).toEqual([SIG, '<p>Hi</p>', ACCOUNT, 'user-1']);

    client.query.mockReset().mockResolvedValueOnce({ rowCount: 1 });
    const none = await send('PUT', '/assignment', { accountId: ACCOUNT, signatureId: null });
    expect(none.status).toBe(200);
    expect(await none.json()).toMatchObject({ accountId: ACCOUNT, signatureId: null, signature: null });
    expect(client.query.mock.calls[0][1]).toEqual([null, null, ACCOUNT, 'user-1']);
  });
});
