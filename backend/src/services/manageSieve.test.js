import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { openManageSieve, parseLine, parseResponse, sieveString, withManageSieve } from './manageSieve.js';
import { startFakeManageSieve, testCertificate } from './manageSieve.fixtures.js';

const servers = [];
afterEach(async () => {
  while (servers.length) await servers.pop().close();
});

async function fake(options) {
  const server = await startFakeManageSieve(options);
  servers.push(server);
  return server;
}

const options = (server, extra = {}) => ({
  host: '127.0.0.1', port: server.port, servername: 'localhost',
  tlsOptions: { ca: testCertificate().cert },
  username: 'alice@example.test', password: 'correct horse', timeoutMs: 3000,
  ...extra,
});

describe('ManageSieve response parsing', () => {
  it('reads quoted strings with escapes, literals, atoms and a response code', () => {
    const buf = Buffer.from('"a \\"b\\" \\\\c" ACTIVE\r\n{4}\r\nhé!\r\nNO (QUOTA/MAXSIZE) "too big"\r\n');
    const r = parseResponse(buf);
    expect(r.status).toBe('NO');
    expect(r.code).toBe('QUOTA/MAXSIZE');
    expect(r.text).toBe('too big');
    expect(r.lines[0]).toEqual([{ type: 'string', value: 'a "b" \\c' }, { type: 'atom', value: 'ACTIVE' }]);
    expect(r.lines[1]).toEqual([{ type: 'string', value: 'hé!' }]);
    expect(r.consumed).toBe(buf.length);
  });

  it('waits for the rest of a literal or a line instead of reading a partial one', () => {
    expect(parseLine(Buffer.from('{10}\r\nabc'))).toBeNull();
    expect(parseLine(Buffer.from('"unterminated'))).toBeNull();
    expect(parseResponse(Buffer.from('"script"\r\nOK'))).toBeNull();
  });

  it('sends plain short strings quoted and anything else as a literal', () => {
    expect(sieveString('plimail')).toBe('"plimail"');
    expect(sieveString('a"b')).toBe('{3+}\r\na"b');
    expect(sieveString('é\r\n')).toBe('{4+}\r\né\r\n');
  });
});

describe('openManageSieve', () => {
  it('upgrades with STARTTLS, logs in over TLS only, and runs the script commands', async () => {
    const server = await fake({ scripts: { other: 'keep;' }, active: 'other' });
    await withManageSieve(options(server), async (session) => {
      expect(session.capabilities.sieve).toContain('vacation');
      expect(session.capabilities.implementation).toBe('Fake Sieve');
      expect(await session.listScripts()).toEqual([{ name: 'other', active: true }]);
      await session.checkScript('require "fileinto";\r\nfileinto "A";\r\n');
      await session.putScript('plimail', 'keep;\r\n');
      await session.setActive('plimail');
      expect(await session.getScript('plimail')).toBe('keep;\r\n');
      expect(await session.listScripts()).toEqual([{ name: 'other', active: false }, { name: 'plimail', active: true }]);
    });
    expect(server.state.authAttempts).toEqual([{ secure: true, username: 'alice@example.test', password: 'correct horse' }]);
    expect(server.state.commands[0]).toBe('STARTTLS');
    expect(server.state.commands.at(-1)).toBe('LOGOUT');
  });

  it('never sends the password to a server that does not offer STARTTLS', async () => {
    const server = await fake({ starttls: false });
    await expect(openManageSieve(options(server))).rejects.toMatchObject({ code: 'no_starttls' });
    expect(server.state.authAttempts).toEqual([]);
    expect(server.state.commands).toEqual([]);
  });

  it('refuses a certificate it cannot verify before any login', async () => {
    const server = await fake();
    await expect(openManageSieve(options(server, { tlsOptions: {} }))).rejects.toMatchObject({ code: 'tls_failed' });
    expect(server.state.authAttempts).toEqual([]);
  });

  it('reports a refused login as auth_failed, once', async () => {
    const server = await fake({ password: 'something else' });
    await expect(openManageSieve(options(server))).rejects.toMatchObject({ code: 'auth_failed' });
    expect(server.state.authAttempts).toHaveLength(1);
  });

  it('refuses a server without SASL PLAIN', async () => {
    const server = await fake({ sasl: ['GSSAPI'] });
    await expect(openManageSieve(options(server))).rejects.toMatchObject({ code: 'no_plain' });
    expect(server.state.authAttempts).toEqual([]);
  });

  it('passes the server explanation of a script it refuses', async () => {
    const server = await fake();
    await withManageSieve(options(server), async (session) => {
      await expect(session.checkScript('syntax-error')).rejects.toMatchObject({ code: 'rejected', message: 'line 1: syntax error' });
    });
  });

  it('reports a closed port as unreachable', async () => {
    const probe = net.createServer();
    await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const { port } = probe.address();
    await new Promise(resolve => probe.close(resolve));
    await expect(openManageSieve({ ...options({ port }) })).rejects.toMatchObject({ code: 'unreachable' });
  });

  it('gives up on a server that never answers', async () => {
    const silent = net.createServer(() => {});
    const sockets = [];
    silent.on('connection', s => sockets.push(s));
    await new Promise(resolve => silent.listen(0, '127.0.0.1', resolve));
    try {
      await expect(openManageSieve(options({ port: silent.address().port }, { timeoutMs: 200 }))).rejects.toMatchObject({ code: 'timeout' });
    } finally {
      sockets.forEach(s => s.destroy());
      await new Promise(resolve => silent.close(resolve));
    }
  });
});
