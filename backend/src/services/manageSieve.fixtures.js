// A local ManageSieve server for tests: STARTTLS with a self-signed certificate, SASL PLAIN, and
// the script commands, keeping its scripts in memory. Nothing here talks to a real server.

import net from 'node:net';
import tls from 'node:tls';
import { parseLine } from './manageSieve.js';
import { generateSelfSignedCertificate } from './tlsCertificate.js';

const quote = s => `"${String(s).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
const literal = s => `{${Buffer.byteLength(s)}}\r\n${s}`;

let certificate;
export function testCertificate() {
  certificate ||= generateSelfSignedCertificate(['localhost', '127.0.0.1']);
  return certificate;
}

// options: username, password, extensions (the SIEVE capability), starttls (offered),
// sasl (mechanisms), checkScript(content) -> null | error text, scripts { name: content }, active.
export async function startFakeManageSieve(options = {}) {
  const state = {
    username: options.username ?? 'alice@example.test',
    password: options.password ?? 'correct horse',
    extensions: options.extensions ?? ['fileinto', 'imap4flags', 'vacation', 'date', 'relational'],
    starttls: options.starttls ?? true,
    sasl: options.sasl ?? ['PLAIN'],
    checkScript: options.checkScript ?? (content => (content.includes('syntax-error') ? 'line 1: syntax error' : null)),
    scripts: new Map(Object.entries(options.scripts ?? {})),
    active: options.active ?? null,
    // What the server saw: commands in order (secrets masked), auth attempts, whether each
    // AUTHENTICATE arrived over TLS.
    commands: [],
    authAttempts: [],
    connections: 0,
  };
  const { cert, key } = testCertificate();

  const capabilities = secure => [
    `"IMPLEMENTATION" "Fake Sieve"`,
    `"SIEVE" ${quote(state.extensions.join(' '))}`,
    ...(secure ? [`"SASL" ${quote(state.sasl.join(' '))}`] : ['"SASL" ""']),
    ...(!secure && state.starttls ? ['"STARTTLS"'] : []),
    '"VERSION" "1.0"',
    'OK "ready"',
  ].join('\r\n') + '\r\n';

  const sockets = new Set();
  const server = net.createServer(raw => {
    state.connections += 1;
    sockets.add(raw);
    raw.on('close', () => sockets.delete(raw));
    let socket = raw;
    let secure = false;
    let authed = false;
    let buffer = Buffer.alloc(0);
    const send = text => socket.write(text);

    const handle = tokens => {
      const verb = tokens[0]?.value?.toUpperCase();
      const arg = n => tokens[n]?.value;
      state.commands.push(verb === 'AUTHENTICATE' ? 'AUTHENTICATE ***' : [verb, ...tokens.slice(1).map(t => t.value)].join(' '));
      if (verb === 'STARTTLS') {
        if (!state.starttls || secure) return send('NO "no"\r\n');
        send('OK "Begin TLS"\r\n');
        raw.removeAllListeners('data');
        socket = new tls.TLSSocket(raw, { isServer: true, cert, key });
        secure = true;
        buffer = Buffer.alloc(0);
        socket.on('data', onData);
        socket.on('error', () => {});
        socket.once('secure', () => send(capabilities(true)));
        return undefined;
      }
      if (verb === 'AUTHENTICATE') {
        const decoded = Buffer.from(arg(2) || '', 'base64').toString('utf8').split('\0');
        state.authAttempts.push({ secure, username: decoded[1], password: decoded[2] });
        if (decoded[1] === state.username && decoded[2] === state.password) {
          authed = true;
          return send('OK "Logged in"\r\n');
        }
        return send('NO "Authentication failed"\r\n');
      }
      if (verb === 'LOGOUT') { send('OK "Bye"\r\n'); return socket.end(); }
      if (verb === 'CAPABILITY') return send(capabilities(secure));
      if (!authed) return send('NO "Authenticate first"\r\n');
      if (verb === 'LISTSCRIPTS') {
        const lines = [...state.scripts.keys()].map(name => `${quote(name)}${state.active === name ? ' ACTIVE' : ''}\r\n`);
        return send(`${lines.join('')}OK\r\n`);
      }
      if (verb === 'GETSCRIPT') {
        if (!state.scripts.has(arg(1))) return send('NO (NONEXISTENT) "No such script"\r\n');
        return send(`${literal(state.scripts.get(arg(1)))}\r\nOK\r\n`);
      }
      if (verb === 'CHECKSCRIPT' || verb === 'PUTSCRIPT') {
        const content = verb === 'CHECKSCRIPT' ? arg(1) : arg(2);
        const error = state.checkScript(content);
        if (error) return send(`NO ${literal(error)}\r\n`);
        if (verb === 'PUTSCRIPT') state.scripts.set(arg(1), content);
        return send('OK\r\n');
      }
      if (verb === 'SETACTIVE') {
        if (arg(1) === '') { state.active = null; return send('OK\r\n'); }
        if (!state.scripts.has(arg(1))) return send('NO (NONEXISTENT) "No such script"\r\n');
        state.active = arg(1);
        return send('OK\r\n');
      }
      if (verb === 'DELETESCRIPT') {
        if (state.active === arg(1)) return send('NO (ACTIVE) "Script is active"\r\n');
        state.scripts.delete(arg(1));
        return send('OK\r\n');
      }
      return send('NO "Unknown command"\r\n');
    };

    function onData(chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const line = parseLine(buffer);
        if (!line) return;
        buffer = buffer.subarray(line.next);
        if (line.tokens.length) handle(line.tokens);
      }
    }

    raw.on('data', onData);
    raw.on('error', () => {});
    send(capabilities(false));
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    state,
    port: server.address().port,
    close: () => new Promise(resolve => {
      for (const s of sockets) s.destroy();
      server.close(resolve);
    }),
  };
}
