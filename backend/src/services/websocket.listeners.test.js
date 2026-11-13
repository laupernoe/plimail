import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { generateSelfSignedCertificate } from './tlsCertificate.js';
vi.mock('./diagnosticsRing.js', () => ({ recordWsConnect: vi.fn(), recordWsDisconnect: vi.fn() }));

// One WebSocket server behind both listeners, as index.js builds it, with APP_URL naming the
// public origin behind a proxy.
let httpServer, httpsServer, wss, ca;
beforeAll(async () => {
  vi.stubEnv('APP_URL', 'https://mail.example.com');
  const { createWebSocketServer, setupWebSocket } = await import('./websocket.js');
  const pair = generateSelfSignedCertificate(['localhost', '127.0.0.1']);
  ca = pair.cert;
  httpServer = createServer();
  httpsServer = createHttpsServer(pair);
  wss = createWebSocketServer(httpServer, httpsServer);
  setupWebSocket(wss, (req, _res, next) => { req.session = { userId: 'u1' }; next(); },
    { connectAllForUser: vi.fn().mockResolvedValue() });
  await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve));
  await new Promise(resolve => httpsServer.listen(0, '127.0.0.1', resolve));
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await new Promise(resolve => wss.close(resolve));
  await new Promise(resolve => httpServer.close(resolve));
  await new Promise(resolve => httpsServer.close(resolve));
});

function open(scheme, origin) {
  const server = scheme === 'wss' ? httpsServer : httpServer;
  const client = new WebSocket(`${scheme}://127.0.0.1:${server.address().port}/ws`, { origin, ca });
  return new Promise(resolve => {
    client.once('message', data => { resolve(JSON.parse(data).type); client.terminate(); });
    client.once('close', code => resolve(code));
  });
}
const port = s => s.address().port;

describe('WebSocket over the HTTP and HTTPS listeners', () => {
  it('accepts APP_URL\'s origin over either', async () => {
    expect(await open('ws', 'https://mail.example.com')).toBe('connected');
    expect(await open('wss', 'https://mail.example.com')).toBe('connected');
  });

  it('accepts the built-in HTTPS listener\'s own origin', async () => {
    expect(await open('wss', `https://127.0.0.1:${port(httpsServer)}`)).toBe('connected');
  });

  it('refuses any other origin', async () => {
    expect(await open('wss', 'https://evil.example')).toBe(1008);
    expect(await open('wss', `http://127.0.0.1:${port(httpsServer)}`)).toBe(1008);
    expect(await open('ws', 'https://evil.example')).toBe(1008);
    // Plain HTTP keeps APP_URL as the only browser origin.
    expect(await open('ws', `http://127.0.0.1:${port(httpServer)}`)).toBe(1008);
  });
});
