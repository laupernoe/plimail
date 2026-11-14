import { X509Certificate, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import path from 'node:path';
import { createSecureContext } from 'node:tls';

// The certificate of the built-in HTTPS listener. An operator who wants their own puts cert.pem and
// key.pem in the directory; otherwise a self-signed one is generated there at the first start and
// reused after, so a browser exception granted once keeps working across restarts. A real,
// trusted certificate is the job of the reverse proxy or tunnel in front, not of this listener.
//
// Node can make keys and signatures but not certificates, so the few DER structures a self-signed
// X.509 v3 certificate needs are written out below rather than pulling in a dependency or openssl.

const VALIDITY_YEARS = 10;

function der(tag, content) {
  const len = content.length;
  let header;
  if (len < 0x80) header = Buffer.from([tag, len]);
  else if (len < 0x100) header = Buffer.from([tag, 0x81, len]);
  else if (len < 0x10000) header = Buffer.from([tag, 0x82, len >> 8, len & 0xff]);
  else throw new Error('DER value too long');
  return Buffer.concat([header, content]);
}

const seq = (...items) => der(0x30, Buffer.concat(items));
const set = (...items) => der(0x31, Buffer.concat(items));
const explicit = (n, value) => der(0xa0 + n, value);
// A DER INTEGER is minimal: no leading zero byte unless the next byte has its top bit set, which
// would read as negative. A random serial starting 0x00 0x0X was otherwise refused as padding.
export function derInteger(bytes) {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0 && !(bytes[start + 1] & 0x80)) start += 1;
  const minimal = bytes.subarray(start);
  return der(0x02, minimal[0] & 0x80 ? Buffer.concat([Buffer.from([0]), minimal]) : minimal);
}
const integer = derInteger;
const octetString = bytes => der(0x04, bytes);
const utf8 = s => der(0x0c, Buffer.from(s, 'utf8'));

function oid(dotted) {
  const [a, b, ...rest] = dotted.split('.').map(Number);
  const bytes = [40 * a + b];
  for (const n of rest) {
    const chunk = [n & 0x7f];
    for (let v = n >> 7; v > 0; v >>= 7) chunk.unshift((v & 0x7f) | 0x80);
    bytes.push(...chunk);
  }
  return der(0x06, Buffer.from(bytes));
}

// UTCTime until 2049, GeneralizedTime from 2050 on, as RFC 5280 requires.
function time(date) {
  const iso = date.toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z';
  return date.getUTCFullYear() < 2050 ? der(0x17, Buffer.from(iso.slice(2))) : der(0x18, Buffer.from(iso));
}

function ipBytes(ip) {
  if (isIP(ip) === 4) return Buffer.from(ip.split('.').map(Number));
  // IPv6: expand "::" and write the eight 16-bit groups.
  const [head, tail = ''] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
  return Buffer.concat(groups.map(g => { const b = Buffer.alloc(2); b.writeUInt16BE(parseInt(g, 16)); return b; }));
}

// localhost, the loopback addresses and APP_URL's host, so the certificate at least names the
// address people open.
export function subjectAltNames(appUrl) {
  const names = ['localhost', '127.0.0.1', '::1'];
  try {
    const host = new URL(appUrl).hostname.replace(/^\[|\]$/g, '');
    if (host && !names.includes(host)) names.push(host);
  } catch { /* APP_URL unset or unparseable */ }
  return names;
}

export function generateSelfSignedCertificate(altNames, now = new Date()) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const ecdsaWithSha256 = seq(oid('1.2.840.10045.4.3.2'));
  const name = seq(set(seq(oid('2.5.4.3'), utf8('Plimail self-signed'))));
  const notAfter = new Date(now);
  notAfter.setUTCFullYear(notAfter.getUTCFullYear() + VALIDITY_YEARS);
  const serial = randomBytes(16);
  serial[0] &= 0x7f;

  const generalNames = altNames.map(n => (isIP(n) ? der(0x87, ipBytes(n)) : der(0x82, Buffer.from(n, 'ascii'))));
  const extensions = seq(
    seq(oid('2.5.29.17'), octetString(seq(...generalNames))),
    // basicConstraints: not a CA.
    seq(oid('2.5.29.19'), octetString(seq())),
    // extKeyUsage: TLS server authentication.
    seq(oid('2.5.29.37'), octetString(seq(oid('1.3.6.1.5.5.7.3.1')))),
  );

  const tbs = seq(
    explicit(0, integer(Buffer.from([2]))),
    integer(serial),
    ecdsaWithSha256,
    name,
    seq(time(now), time(notAfter)),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
    explicit(3, extensions),
  );
  const signature = sign('sha256', tbs, privateKey);
  const cert = seq(tbs, ecdsaWithSha256, der(0x03, Buffer.concat([Buffer.from([0]), signature])));

  const b64 = cert.toString('base64').match(/.{1,64}/g).join('\n');
  return {
    cert: `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`,
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}

// The certificate and key the HTTPS listener serves, from `dir`: the pair found there, or a new
// self-signed pair written there. A pair that cannot be used throws, so a broken mounted
// certificate stops the start instead of serving something else in its place.
export function loadOrCreateCertificate(dir, { appUrl, log = console } = {}) {
  const certFile = path.join(dir, 'cert.pem');
  const keyFile = path.join(dir, 'key.pem');
  const hasCert = existsSync(certFile);
  const hasKey = existsSync(keyFile);

  if (hasCert !== hasKey) {
    throw new Error(`${dir} holds ${hasCert ? 'cert.pem but no key.pem' : 'key.pem but no cert.pem'}; provide both or neither`);
  }

  if (hasCert) {
    const pair = { cert: readFileSync(certFile, 'utf8'), key: readFileSync(keyFile, 'utf8') };
    // Throws on an unparseable file or a key that does not match the certificate.
    createSecureContext(pair);
    const x509 = new X509Certificate(pair.cert);
    if (new Date(x509.validTo) < new Date()) {
      log.warn(`WARNING: the HTTPS certificate in ${certFile} expired on ${x509.validTo}`);
    }
    return { ...pair, source: 'file' };
  }

  const pair = generateSelfSignedCertificate(subjectAltNames(appUrl));
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(keyFile, pair.key, { mode: 0o600 });
    writeFileSync(certFile, pair.cert, { mode: 0o644 });
    log.log(`Generated a self-signed HTTPS certificate in ${dir}`);
  } catch (err) {
    log.warn(`WARNING: could not save the self-signed HTTPS certificate in ${dir} (${err.message}); a new one will be generated on every start`);
  }
  return { ...pair, source: 'generated' };
}
