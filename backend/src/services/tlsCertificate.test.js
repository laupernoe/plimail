import { afterEach, describe, expect, it, vi } from 'vitest';
import { X509Certificate, createPrivateKey } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { generateSelfSignedCertificate, loadOrCreateCertificate, subjectAltNames } from './tlsCertificate.js';

const quiet = { log: vi.fn(), warn: vi.fn() };
const dirs = [];
function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), 'plimail-certs-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('generateSelfSignedCertificate', () => {
  it('produces a self-signed X.509 certificate that verifies against its own key', () => {
    const now = new Date('2026-11-13T00:00:00Z');
    const { cert, key } = generateSelfSignedCertificate(['localhost', '127.0.0.1', '::1', 'mail.example.com'], now);
    const x509 = new X509Certificate(cert);
    expect(x509.verify(x509.publicKey)).toBe(true);
    expect(x509.checkPrivateKey(createPrivateKey(key))).toBe(true);
    expect(x509.subject).toBe('CN=Plimail self-signed');
    expect(x509.issuer).toBe(x509.subject);
    expect(new Date(x509.validFrom).toISOString()).toBe('2026-11-13T00:00:00.000Z');
    expect(new Date(x509.validTo).toISOString()).toBe('2036-11-13T00:00:00.000Z');
    expect(x509.subjectAltName).toBe('DNS:localhost, IP Address:127.0.0.1, IP Address:0:0:0:0:0:0:0:1, DNS:mail.example.com');
    expect(x509.ca).toBe(false);
    expect(x509.keyUsage).toEqual(['1.3.6.1.5.5.7.3.1']);
    expect(x509.checkHost('mail.example.com')).toBe('mail.example.com');
  });

  it('writes validity past 2049 as GeneralizedTime', () => {
    const x509 = new X509Certificate(generateSelfSignedCertificate(['localhost'], new Date('2045-01-01T00:00:00Z')).cert);
    expect(new Date(x509.validTo).toISOString()).toBe('2055-01-01T00:00:00.000Z');
  });

  it('serves a TLS handshake', async () => {
    const pair = generateSelfSignedCertificate(['localhost']);
    const server = https.createServer(pair, (_req, res) => res.end('ok'));
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    try {
      const body = await new Promise((resolve, reject) => {
        https.get({ host: '127.0.0.1', port: server.address().port, servername: 'localhost', ca: pair.cert }, res => {
          let data = '';
          res.on('data', c => { data += c; });
          res.on('end', () => resolve(data));
        }).on('error', reject);
      });
      expect(body).toBe('ok');
    } finally {
      server.close();
    }
  });
});

describe('subjectAltNames', () => {
  it('adds the host APP_URL names', () => {
    expect(subjectAltNames('https://mail.example.com')).toEqual(['localhost', '127.0.0.1', '::1', 'mail.example.com']);
    expect(subjectAltNames('http://192.168.1.10:3000')).toEqual(['localhost', '127.0.0.1', '::1', '192.168.1.10']);
    expect(subjectAltNames('http://[fd00::1]:3000')).toEqual(['localhost', '127.0.0.1', '::1', 'fd00::1']);
  });
  it('keeps the loopback names alone without a usable APP_URL', () => {
    expect(subjectAltNames(undefined)).toEqual(['localhost', '127.0.0.1', '::1']);
    expect(subjectAltNames('not a url')).toEqual(['localhost', '127.0.0.1', '::1']);
    expect(subjectAltNames('http://localhost:3000')).toEqual(['localhost', '127.0.0.1', '::1']);
  });
});

describe('loadOrCreateCertificate', () => {
  it('generates a pair at the first start, saves it, and reuses it after', () => {
    const dir = tempDir();
    const first = loadOrCreateCertificate(dir, { appUrl: 'https://mail.example.com', log: quiet });
    expect(first.source).toBe('generated');
    expect(readFileSync(path.join(dir, 'cert.pem'), 'utf8')).toBe(first.cert);
    expect(statSync(path.join(dir, 'key.pem')).mode & 0o777).toBe(0o600);
    expect(new X509Certificate(first.cert).subjectAltName).toContain('DNS:mail.example.com');

    const second = loadOrCreateCertificate(dir, { log: quiet });
    expect(second.source).toBe('file');
    expect(second.cert).toBe(first.cert);
    expect(second.key).toBe(first.key);
  });

  it('serves an operator-provided pair as it is', () => {
    const dir = tempDir();
    const own = generateSelfSignedCertificate(['mail.example.com']);
    writeFileSync(path.join(dir, 'cert.pem'), own.cert);
    writeFileSync(path.join(dir, 'key.pem'), own.key);
    expect(loadOrCreateCertificate(dir, { log: quiet })).toMatchObject({ ...own, source: 'file' });
  });

  it('refuses half a pair rather than replacing it', () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, 'cert.pem'), generateSelfSignedCertificate(['localhost']).cert);
    expect(() => loadOrCreateCertificate(dir, { log: quiet })).toThrow(/cert\.pem but no key\.pem/);
    expect(existsSync(path.join(dir, 'key.pem'))).toBe(false);
  });

  it('refuses a key that does not match the certificate', () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, 'cert.pem'), generateSelfSignedCertificate(['localhost']).cert);
    writeFileSync(path.join(dir, 'key.pem'), generateSelfSignedCertificate(['localhost']).key);
    expect(() => loadOrCreateCertificate(dir, { log: quiet })).toThrow();
  });

  it('warns about an expired certificate but still serves it', () => {
    const dir = tempDir();
    const old = generateSelfSignedCertificate(['localhost'], new Date('2000-01-01T00:00:00Z'));
    writeFileSync(path.join(dir, 'cert.pem'), old.cert);
    writeFileSync(path.join(dir, 'key.pem'), old.key);
    const log = { log: vi.fn(), warn: vi.fn() };
    expect(loadOrCreateCertificate(dir, { log }).cert).toBe(old.cert);
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/expired/));
  });

  it('still serves a generated pair, and says so, when the directory is not writable', () => {
    if (process.getuid?.() === 0) return; // root writes regardless of the mode
    const dir = tempDir();
    chmodSync(dir, 0o500);
    const log = { log: vi.fn(), warn: vi.fn() };
    const pair = loadOrCreateCertificate(dir, { log });
    chmodSync(dir, 0o700);
    expect(pair.source).toBe('generated');
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/could not save/));
  });
});
