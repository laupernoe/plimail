import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compress, mountWebApp, securityHeaders } from './webApp.js';

// Mounted the way index.js mounts it, over a built app laid out as Vite lays it out.
let dir, server, base;
beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'plimail-webapp-'));
  mkdirSync(path.join(dir, 'assets'));
  mkdirSync(path.join(dir, 'pdfjs', '6.3.289', 'wasm'), { recursive: true });
  writeFileSync(path.join(dir, 'index.html'), '<!doctype html><div id="root"></div>');
  writeFileSync(path.join(dir, 'assets', 'index-abc123.js'), `console.log(${JSON.stringify('x'.repeat(4096))});`);
  writeFileSync(path.join(dir, 'pdfjs', '6.3.289', 'wasm', 'jbig2_nowasm_fallback.js'), '//');
  writeFileSync(path.join(dir, 'sw.js'), 'self.addEventListener("push", () => {});');
  writeFileSync(path.join(dir, 'favicon.svg'), '<svg/>');

  const app = express();
  app.set('trust proxy', 1);
  app.use(securityHeaders);
  app.use(compress);
  app.get('/api/health', (_req, res) => res.json({ status: 'ok', pad: 'x'.repeat(4096) }));
  app.get('/api/ai/stream', (_req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('X-Accel-Buffering', 'no');
    res.end(`data: ${'x'.repeat(4096)}\n\n`);
  });
  app.get('/api/attachment', (_req, res) => {
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.end('file');
  });
  expect(mountWebApp(app, dir)).toBe(true);
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  await new Promise(resolve => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

const get = (urlPath, headers = {}) => fetch(base + urlPath, { headers });

describe('the built web app', () => {
  it('answers a client-side route with index.html, never cached', async () => {
    const res = await get('/mail/inbox/42');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('id="root"');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN');
  });

  it('caches fingerprinted files for a year and gzips them', async () => {
    for (const p of ['/assets/index-abc123.js', '/pdfjs/6.3.289/wasm/jbig2_nowasm_fallback.js']) {
      const res = await get(p, { 'Accept-Encoding': 'gzip' });
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    }
    const res = await get('/assets/index-abc123.js', { 'Accept-Encoding': 'gzip' });
    expect(res.headers.get('content-encoding')).toBe('gzip');
    expect(res.headers.get('content-type')).toMatch(/javascript/);
  });

  it('never caches the service worker, and keeps unversioned files for a day', async () => {
    expect((await get('/sw.js')).headers.get('cache-control')).toBe('no-store');
    expect((await get('/favicon.svg')).headers.get('cache-control')).toBe('public, max-age=86400');
  });

  it('answers a missing script with a 404, not index.html', async () => {
    expect((await get('/assets/index-old999.js')).status).toBe(404);
    expect((await get('/missing.css')).status).toBe(404);
  });

  it('leaves backend paths to the backend', async () => {
    for (const p of ['/api/nope', '/oauth/nope', '/auth/oidc/x/callback', '/carddav/', '/.well-known/carddav', '/ws']) {
      const res = await get(p);
      expect(res.status, p).toBe(404);
      expect(await res.text(), p).not.toContain('id="root"');
    }
  });
});

describe('security headers and compression', () => {
  it('sends the CSP and the rest on API responses too, with DENY framing', async () => {
    const res = await get('/api/health', { 'Accept-Encoding': 'gzip' });
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('permissions-policy')).toBe('camera=(), microphone=(), geolocation=()');
    expect(res.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(res.headers.get('content-encoding')).toBe('gzip');
  });

  it('allows ws: and sends no HSTS over plain HTTP', async () => {
    const res = await get('/');
    expect(res.headers.get('content-security-policy')).toContain("connect-src 'self' wss: ws:;");
    expect(res.headers.get('strict-transport-security')).toBeNull();
  });

  it('sends HSTS and drops ws: once a trusted proxy says the browser used HTTPS', async () => {
    const res = await get('/', { 'X-Forwarded-Proto': 'https' });
    expect(res.headers.get('content-security-policy')).toContain("connect-src 'self' wss:;");
    expect(res.headers.get('strict-transport-security')).toBe('max-age=63072000');
  });

  it("lets a route's own CSP replace the default", async () => {
    const res = await get('/api/attachment');
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
  });

  it('does not compress a stream that has to arrive as it is written', async () => {
    const res = await get('/api/ai/stream', { 'Accept-Encoding': 'gzip' });
    expect(res.headers.get('content-encoding')).toBeNull();
  });
});

describe('mountWebApp', () => {
  it('mounts nothing where there is no built app (development)', () => {
    expect(mountWebApp(express(), path.join(dir, 'nowhere'))).toBe(false);
  });
});
