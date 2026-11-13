import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// A stand-in for the table: rows by id, each with its owner, answering the SQL the service sends.
const rows = vi.hoisted(() => new Map());
vi.mock('../services/db.js', () => ({
  query: vi.fn(async (sql, params) => {
    if (sql.startsWith('INSERT INTO signature_images')) {
      const id = `00000000-0000-4000-8000-${String(rows.size + 1).padStart(12, '0')}`;
      const [user_id, content_type, data, width, height] = params;
      rows.set(id, { id, user_id, content_type, data, width, height });
      return { rows: [{ id }] };
    }
    if (sql.startsWith('SELECT content_type, data FROM signature_images')) {
      const row = rows.get(params[0]);
      return { rows: row && row.user_id === params[1] ? [row] : [] };
    }
    throw new Error(`unexpected query: ${sql}`);
  }),
}));
vi.mock('../services/rateLimiter.js', () => ({ consume: vi.fn(async () => ({ limited: false, resetMs: 0 })) }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: req.headers['x-user'] }; next(); },
}));

import express from 'express';
import sharp from 'sharp';
import routes from './signatureImages.js';
import { consume } from '../services/rateLimiter.js';

describe('/api/signature-images', () => {
  let server, base;
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/signature-images', routes);
    await new Promise(resolve => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}/api/signature-images`;
  });
  afterAll(async () => { await new Promise(resolve => server.close(resolve)); });
  beforeEach(() => { rows.clear(); });

  const upload = (body, user = 'user-1', type = 'image/png') => fetch(base, {
    method: 'POST', headers: { 'Content-Type': type, 'X-User': user }, body,
  });
  const logo = () => sharp({ create: { width: 900, height: 300, channels: 3, background: '#224466' } }).png().toBuffer();

  it('stores an upload for its owner, scaled down, and serves it back to them as an image only', async () => {
    const res = await upload(await logo());
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ url: `/api/signature-images/${body.id}`, width: 600, height: 200 });
    expect([...rows.values()][0].user_id).toBe('user-1');

    const got = await fetch(`${base}/${body.id}`, { headers: { 'X-User': 'user-1' } });
    expect(got.status).toBe(200);
    expect(got.headers.get('content-type')).toBe('image/png');
    expect(got.headers.get('x-content-type-options')).toBe('nosniff');
    expect(got.headers.get('content-security-policy')).toContain('sandbox');
    expect(got.headers.get('cache-control')).toContain('private');
    expect((await sharp(Buffer.from(await got.arrayBuffer())).metadata()).width).toBe(600);
  });

  it('answers another user as if the image did not exist', async () => {
    const { id } = await (await upload(await logo())).json();
    const res = await fetch(`${base}/${id}`, { headers: { 'X-User': 'user-2' } });
    expect(res.status).toBe(404);
    expect((await res.arrayBuffer()).byteLength).toBe(0);
  });

  it('answers 404 for an id that is not one', async () => {
    expect((await fetch(`${base}/not-an-id`, { headers: { 'X-User': 'user-1' } })).status).toBe(404);
  });

  it('refuses a file that is not an image by its bytes, whatever type it is sent as', async () => {
    const res = await upload('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>', 'user-1', 'image/svg+xml');
    expect(res.status).toBe(415);
    expect(rows.size).toBe(0);
    expect((await upload('{"a":1}', 'user-1', 'application/json')).status).toBe(415);
  });

  it('refuses a file over 5 MB', async () => {
    const res = await upload(Buffer.alloc(5 * 1024 * 1024 + 1), 'user-1');
    expect(res.status).toBe(413);
    expect(rows.size).toBe(0);
  });

  it('refuses uploads beyond the rate limit', async () => {
    consume.mockResolvedValueOnce({ limited: true, resetMs: 30_000 });
    const res = await upload(await logo());
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('30');
    expect(rows.size).toBe(0);
  });
});
