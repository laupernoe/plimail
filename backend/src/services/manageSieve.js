// A minimal ManageSieve client (RFC 5804): enough to read the server's capabilities, list, read,
// check, store and activate scripts. Written here rather than taken from a package because the
// protocol is small and the published clients either skip STARTTLS or make it optional.
//
// STARTTLS is mandatory: the password is sent only after the TLS upgrade, and a server that does
// not offer it is refused before anything secret leaves. Every read has a deadline, and a session
// that fails is destroyed rather than logged out, as a hung transport cannot be talked out of.

import net from 'node:net';
import tls from 'node:tls';

export const MANAGESIEVE_PORT = 4190;
const DEFAULT_TIMEOUT_MS = 15000;
// Largest response accepted: a script the user could store, with room to spare.
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export class SieveError extends Error {
  // code: unreachable | timeout | no_starttls | tls_failed | no_plain | auth_failed | rejected | protocol | closed
  constructor(code, message, { serverCode = null, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.code = code;
    this.serverCode = serverCode;
  }
}

const CR = 13;
const LF = 10;
const SP = 32;
const DQUOTE = 34;

// One line of a response, from `pos` in `buf`: its tokens and where the next line starts, or null
// when the line is not complete yet. A literal ({n}CRLF followed by n octets) is part of its line.
// Tokens: { type: 'atom' | 'string' | 'code', value }.
export function parseLine(buf, pos = 0) {
  const tokens = [];
  let i = pos;
  for (;;) {
    if (i >= buf.length) return null;
    const c = buf[i];
    if (c === SP) { i += 1; continue; }
    if (c === CR) {
      if (i + 1 >= buf.length) return null;
      if (buf[i + 1] !== LF) throw new SieveError('protocol', 'Malformed ManageSieve response');
      return { tokens, next: i + 2 };
    }
    if (c === LF) return { tokens, next: i + 1 };
    if (c === DQUOTE) {
      const bytes = [];
      let j = i + 1;
      for (;;) {
        if (j >= buf.length) return null;
        const d = buf[j];
        if (d === 92) { // backslash
          if (j + 1 >= buf.length) return null;
          bytes.push(buf[j + 1]);
          j += 2;
          continue;
        }
        if (d === DQUOTE) break;
        if (d === CR || d === LF) throw new SieveError('protocol', 'Malformed ManageSieve string');
        bytes.push(d);
        j += 1;
      }
      tokens.push({ type: 'string', value: Buffer.from(bytes).toString('utf8') });
      i = j + 1;
      continue;
    }
    if (c === 123) { // {n} or {n+} literal
      const close = buf.indexOf(125, i);
      if (close < 0) return null;
      const m = /^\{(\d{1,9})\+?\}$/.exec(buf.subarray(i, close + 1).toString('latin1'));
      if (!m) throw new SieveError('protocol', 'Malformed ManageSieve literal');
      const size = Number(m[1]);
      if (size > MAX_RESPONSE_BYTES) throw new SieveError('protocol', 'ManageSieve response too large');
      let start = close + 1;
      if (start + 1 >= buf.length) return null;
      if (buf[start] === CR && buf[start + 1] === LF) start += 2;
      else if (buf[start] === LF) start += 1;
      else throw new SieveError('protocol', 'Malformed ManageSieve literal');
      if (start + size > buf.length) return null;
      tokens.push({ type: 'string', value: buf.subarray(start, start + size).toString('utf8') });
      i = start + size;
      continue;
    }
    if (c === 40) { // ( response code ), quoted strings inside kept as written
      let j = i + 1;
      let depth = 1;
      let quoted = false;
      for (; j < buf.length && depth > 0; j += 1) {
        const d = buf[j];
        if (quoted) {
          if (d === 92) j += 1;
          else if (d === DQUOTE) quoted = false;
        } else if (d === DQUOTE) quoted = true;
        else if (d === 40) depth += 1;
        else if (d === 41) depth -= 1;
        else if (d === CR || d === LF) throw new SieveError('protocol', 'Malformed ManageSieve response code');
      }
      if (depth > 0) return null;
      tokens.push({ type: 'code', value: buf.subarray(i + 1, j - 1).toString('utf8') });
      i = j;
      continue;
    }
    let j = i;
    while (j < buf.length && buf[j] !== SP && buf[j] !== CR && buf[j] !== LF) j += 1;
    if (j >= buf.length) return null;
    tokens.push({ type: 'atom', value: buf.subarray(i, j).toString('utf8') });
    i = j;
  }
}

const STATUS = new Set(['OK', 'NO', 'BYE']);

// A full response: data lines until the OK, NO or BYE that ends it. Null when incomplete.
export function parseResponse(buf) {
  const lines = [];
  let pos = 0;
  for (;;) {
    const line = parseLine(buf, pos);
    if (!line) return null;
    pos = line.next;
    const first = line.tokens[0];
    if (first?.type === 'atom' && STATUS.has(first.value.toUpperCase())) {
      const rest = line.tokens.slice(1);
      const code = rest.find(t => t.type === 'code')?.value || null;
      const text = rest.find(t => t.type === 'string')?.value || '';
      return { status: first.value.toUpperCase(), code, text, lines, consumed: pos };
    }
    lines.push(line.tokens);
  }
}

// A string as the client sends it: quoted when short and plain, a non-synchronizing literal
// otherwise (RFC 5804 lets a client always use {n+}).
export function sieveString(value) {
  const s = String(value);
  const bytes = Buffer.from(s, 'utf8');
  const plain = bytes.length <= 1024 && ![...s].some(ch => ch === '"' || ch === '\\' || ch === '\r' || ch === '\n' || ch.charCodeAt(0) < 32);
  return plain ? `"${s}"` : `{${bytes.length}+}\r\n${s}`;
}

export function parseCapabilities(lines) {
  const caps = { implementation: null, sieve: [], sasl: [], starttls: false, version: null, raw: {} };
  for (const tokens of lines) {
    const name = tokens[0]?.value?.toUpperCase();
    if (!name) continue;
    const value = tokens[1]?.value ?? '';
    caps.raw[name] = value;
    if (name === 'IMPLEMENTATION') caps.implementation = value;
    else if (name === 'SIEVE') caps.sieve = value.split(/\s+/).filter(Boolean).map(s => s.toLowerCase());
    else if (name === 'SASL') caps.sasl = value.split(/\s+/).filter(Boolean).map(s => s.toUpperCase());
    else if (name === 'STARTTLS') caps.starttls = true;
    else if (name === 'VERSION') caps.version = value;
  }
  return caps;
}

class Connection {
  constructor(socket, timeoutMs) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.buffer = Buffer.alloc(0);
    this.waiter = null;
    this.failure = null;
    this.attach(socket);
  }

  attach(socket) {
    this.socket = socket;
    socket.on('data', chunk => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      if (this.buffer.length > MAX_RESPONSE_BYTES + 4096) this.fail(new SieveError('protocol', 'ManageSieve response too large'));
      else this.wake();
    });
    socket.on('error', err => this.fail(new SieveError('closed', `ManageSieve connection failed: ${err.message}`, { cause: err })));
    socket.on('close', () => this.fail(new SieveError('closed', 'ManageSieve connection closed')));
  }

  fail(err) {
    if (!this.failure) this.failure = err;
    this.wake();
  }

  wake() {
    const w = this.waiter;
    if (w) { this.waiter = null; w(); }
  }

  async read() {
    const deadline = Date.now() + this.timeoutMs;
    for (;;) {
      const response = parseResponse(this.buffer);
      if (response) {
        this.buffer = this.buffer.subarray(response.consumed);
        if (response.status === 'BYE') {
          this.destroy();
          throw new SieveError('closed', response.text || 'ManageSieve server closed the session', { serverCode: response.code });
        }
        return response;
      }
      if (this.failure) throw this.failure;
      const left = deadline - Date.now();
      if (left <= 0) {
        this.destroy();
        throw new SieveError('timeout', 'ManageSieve server did not answer in time');
      }
      await new Promise(resolve => {
        const timer = setTimeout(() => { this.waiter = null; resolve(); }, left);
        this.waiter = () => { clearTimeout(timer); resolve(); };
      });
    }
  }

  write(text) {
    if (this.failure) throw this.failure;
    this.socket.write(text);
  }

  async command(text) {
    this.write(`${text}\r\n`);
    return this.read();
  }

  destroy() {
    this.socket.destroy();
  }
}

function rejected(response, what) {
  return new SieveError('rejected', response.text || `${what} was refused`, { serverCode: response.code });
}

// A session: capabilities read after TLS, authenticated, ready for commands.
export class ManageSieveSession {
  constructor(conn, capabilities) {
    this.conn = conn;
    this.capabilities = capabilities;
  }

  async listScripts() {
    const r = await this.conn.command('LISTSCRIPTS');
    if (r.status !== 'OK') throw rejected(r, 'LISTSCRIPTS');
    return r.lines
      .filter(tokens => tokens[0]?.type === 'string')
      .map(tokens => ({ name: tokens[0].value, active: tokens[1]?.type === 'atom' && tokens[1].value.toUpperCase() === 'ACTIVE' }));
  }

  async getScript(name) {
    const r = await this.conn.command(`GETSCRIPT ${sieveString(name)}`);
    if (r.status !== 'OK') throw rejected(r, 'GETSCRIPT');
    return r.lines[0]?.[0]?.value ?? '';
  }

  // Resolves with the server's warnings (possibly empty); a script it refuses throws 'rejected'
  // with the server's explanation as the message.
  async checkScript(content) {
    const r = await this.conn.command(`CHECKSCRIPT ${sieveString(content)}`);
    if (r.status !== 'OK') throw rejected(r, 'CHECKSCRIPT');
    return { warnings: r.code && /^WARNINGS/i.test(r.code) ? r.text : '' };
  }

  async putScript(name, content) {
    const r = await this.conn.command(`PUTSCRIPT ${sieveString(name)} ${sieveString(content)}`);
    if (r.status !== 'OK') throw rejected(r, 'PUTSCRIPT');
  }

  // An empty name deactivates whichever script is active.
  async setActive(name) {
    const r = await this.conn.command(`SETACTIVE ${sieveString(name)}`);
    if (r.status !== 'OK') throw rejected(r, 'SETACTIVE');
  }

  async deleteScript(name) {
    const r = await this.conn.command(`DELETESCRIPT ${sieveString(name)}`);
    if (r.status !== 'OK') throw rejected(r, 'DELETESCRIPT');
  }

  async logout() {
    try {
      this.conn.write('LOGOUT\r\n');
      await this.conn.read().catch(() => {});
    } finally {
      this.conn.destroy();
    }
  }

  close() {
    this.conn.destroy();
  }
}

function connectPlain({ host, port, lookup, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port, ...(lookup ? { lookup, autoSelectFamily: true } : {}) });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new SieveError('unreachable', `No ManageSieve server answered on ${host}:${port}`));
    }, timeoutMs);
    socket.once('connect', () => { clearTimeout(timer); resolve(socket); });
    socket.once('error', err => {
      clearTimeout(timer);
      socket.destroy();
      reject(new SieveError('unreachable', `No ManageSieve server on ${host}:${port}: ${err.code || err.message}`, { cause: err }));
    });
  });
}

function upgrade(socket, { servername, tlsOptions, timeoutMs }) {
  return new Promise((resolve, reject) => {
    socket.removeAllListeners('data');
    socket.removeAllListeners('error');
    socket.removeAllListeners('close');
    const secure = tls.connect({ socket, ...(servername && !net.isIP(servername) ? { servername } : {}), ...tlsOptions });
    const timer = setTimeout(() => {
      secure.destroy();
      reject(new SieveError('timeout', 'The TLS handshake with the ManageSieve server timed out'));
    }, timeoutMs);
    secure.once('secureConnect', () => { clearTimeout(timer); resolve(secure); });
    secure.once('error', err => {
      clearTimeout(timer);
      secure.destroy();
      reject(new SieveError('tls_failed', `TLS with the ManageSieve server failed: ${err.message}`, { cause: err }));
    });
  });
}

// Opens a session: connect, STARTTLS (refused if the server does not offer it), read the
// capabilities again over TLS, then AUTHENTICATE PLAIN. The password is written only once TLS is
// up. Throws a SieveError; on any failure the socket is destroyed.
export async function openManageSieve({
  host, port = MANAGESIEVE_PORT, servername = null, lookup = null, tlsOptions = {},
  username, password, timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  const plain = await connectPlain({ host, port, lookup, timeoutMs });
  let conn = new Connection(plain, timeoutMs);
  try {
    const greeting = await conn.read();
    if (greeting.status !== 'OK') throw rejected(greeting, 'The connection');
    const before = parseCapabilities(greeting.lines);
    if (!before.starttls) throw new SieveError('no_starttls', 'The ManageSieve server does not offer STARTTLS');
    const started = await conn.command('STARTTLS');
    if (started.status !== 'OK') throw new SieveError('no_starttls', started.text || 'The ManageSieve server refused STARTTLS');
    if (conn.buffer.length) throw new SieveError('protocol', 'The ManageSieve server sent data before the TLS handshake');
    const secure = await upgrade(plain, { servername: servername || host, tlsOptions, timeoutMs });
    conn = new Connection(secure, timeoutMs);
    const afterTls = await conn.read();
    if (afterTls.status !== 'OK') throw rejected(afterTls, 'The connection');
    const capabilities = parseCapabilities(afterTls.lines);
    if (!capabilities.sasl.includes('PLAIN')) throw new SieveError('no_plain', 'The ManageSieve server does not accept a password login (SASL PLAIN)');
    const credentials = Buffer.from(`\0${username}\0${password}`, 'utf8').toString('base64');
    const auth = await conn.command(`AUTHENTICATE "PLAIN" "${credentials}"`);
    if (auth.status !== 'OK') {
      throw new SieveError('auth_failed', auth.text || 'The ManageSieve server refused the login', { serverCode: auth.code });
    }
    return new ManageSieveSession(conn, capabilities);
  } catch (err) {
    conn.destroy();
    plain.destroy();
    throw err;
  }
}

// Runs fn(session) and always closes the session, with a LOGOUT when fn succeeded.
export async function withManageSieve(options, fn, { open = openManageSieve } = {}) {
  const session = await open(options);
  let ok = false;
  try {
    const result = await fn(session);
    ok = true;
    return result;
  } finally {
    if (ok) await session.logout().catch(() => session.close());
    else session.close();
  }
}
