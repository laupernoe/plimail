import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import { request as httpsRequest, createServer as createHttpsServer } from 'node:https';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadOrCreateCertificate } from '../services/tlsCertificate.js';
import { directRequestHandler, stripForwardedOnUpgrade } from './directListener.js';

const SPOOFED = {
  'X-Forwarded-For': '6.6.6.6',
  'X-Forwarded-Proto': 'http',
  'X-Forwarded-Host': 'evil.example',
  'X-Forwarded-Port': '1',
  Forwarded: 'for=6.6.6.6;proto=http;host=evil.example',
};

let dir;
let server;
afterEach(() => {
  server?.close();
  server = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

// The built-in TLS listener as index.js builds it: the app with the one trusted hop the HTTP
// listener behind the tunnel needs.
async function tlsListener(wrap) {
  dir = mkdtempSync(path.join(tmpdir(), 'plimail-direct-'));
  const { cert, key } = loadOrCreateCertificate(dir, { log: { log() {}, warn() {} } });
  const app = express();
  app.set('trust proxy', 1);
  app.get('/', (req, res) => res.json({
    ip: req.ip, protocol: req.protocol, hostname: req.hostname, forwarded: req.get('forwarded') ?? null,
  }));
  server = createHttpsServer({ cert, key }, wrap ? directRequestHandler(app) : app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

function get(port, headers) {
  return new Promise((resolve, reject) => {
    const req = httpsRequest({ host: '127.0.0.1', port, path: '/', headers, rejectUnauthorized: false }, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => resolve(JSON.parse(body)));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('the built-in HTTPS listener', () => {
  it('takes req.ip, the protocol and the host from the socket, whatever the client forwards', async () => {
    const port = await tlsListener(true);
    expect(await get(port, SPOOFED)).toEqual({
      ip: '127.0.0.1', protocol: 'https', hostname: '127.0.0.1', forwarded: null,
    });
  });

  it('would otherwise let a client pick its own address', async () => {
    const port = await tlsListener(false);
    expect((await get(port, SPOOFED)).ip).toBe('6.6.6.6');
  });

  it('strips the headers from a WebSocket upgrade before any other listener sees it', async () => {
    const port = await tlsListener(true);
    stripForwardedOnUpgrade(server);
    const seen = new Promise(resolve => server.on('upgrade', (req, socket) => {
      resolve({ ...req.headers });
      socket.destroy();
    }));
    const req = httpsRequest({
      host: '127.0.0.1', port, path: '/ws', rejectUnauthorized: false,
      headers: { ...SPOOFED, Connection: 'Upgrade', Upgrade: 'websocket' },
    });
    req.on('error', () => {});
    req.end();
    const headers = await seen;
    for (const name of Object.keys(SPOOFED)) expect(headers[name.toLowerCase()]).toBeUndefined();
  });
});
