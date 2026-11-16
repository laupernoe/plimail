import { PgpFormatError, TAG, armor, emailFromUserId, parseKeyPacket, readPackets } from './pgpPackets.js';
import { minimalAutocryptKey, signatureInfo } from './autocrypt.js';
import { parseAuthenticationResults } from './mailSafetyInput.js';

// Reading the Autocrypt header of a received message (Autocrypt Level 1, 2.3 "Updating Autocrypt
// Peer State"): whether it carries a key worth keeping, and for which address and when. What is
// done with it is decided by pgpKeyring.js (storeAutocryptKey).

// Largest keydata taken from a received header, decoded. Far above what a sender should send
// (MAX_KEYDATA_BYTES in autocrypt.js) and well below the keyring's own limit.
const MAX_RECEIVED_KEYDATA_BYTES = 64 * 1024;

const SIG_KEY_REVOCATION = 0x20;
const SIG_CERT_REVOCATION = 0x30;
const SIG_DIRECT_KEY = 0x1F;

// The address of a From or addr value, compared exactly: trimmed, without angle brackets, lower case.
export const normalizeAddress = value => String(value || '').trim().replace(/^<|>$/g, '').trim().toLowerCase();

// The header's attributes, or null when it is not one to use: no addr or keydata, or an attribute
// this reader does not know that is not a non-critical one (starting with an underscore).
export function parseAutocryptValue(value) {
  const attrs = {};
  for (const part of String(value || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    attrs[part.slice(0, eq).trim().toLowerCase()] = part.slice(eq + 1).trim();
  }
  if (!attrs.addr || !attrs.keydata) return null;
  if (Object.keys(attrs).some(k => !['addr', 'keydata', 'prefer-encrypt'].includes(k) && !k.startsWith('_'))) return null;
  return { addr: normalizeAddress(attrs.addr), keydata: attrs.keydata.replace(/\s+/g, ''), preferEncrypt: attrs['prefer-encrypt'] || null };
}

// Sender authentication as the receiving server recorded it. Only a failure counts, and only to
// refuse a key: the topmost Authentication-Results header is the one the receiving server wrote,
// and a "pass" a sender writes itself, or a header it adds below, can only change nothing, never
// let in a key that would otherwise be kept out. No header, or no DKIM or DMARC result in it, is
// no verdict (there is no trusted-server setting to say whose header to believe).
const AUTH_FAILURES = new Set(['fail', 'softfail', 'hardfail', 'permerror', 'policy']);
export function authenticationFailed(headers) {
  const value = headers?.['authentication-results'];
  if (!value) return false;
  const results = parseAuthenticationResults(value);
  return AUTH_FAILURES.has(results.dmarc) || AUTH_FAILURES.has(results.dkim);
}

// Why a key cannot be kept, or null: no encryption subkey, revoked or expired. `bytes` is the key
// as minimalAutocryptKey cut it down. Signatures are not verified here (the server does no
// cryptography, see pgpPackets.js); the key the browser later encrypts to goes through OpenPGP.js,
// which does.
export function autocryptKeyProblem(bytes, email, now = new Date()) {
  const packets = readPackets(bytes);
  if (!packets.length || packets[0].tag !== TAG.PUBLIC_KEY) return 'unreadable';
  const primary = parseKeyPacket(packets[0]);
  const bySelf = info => info.issuers.has(primary.keyId) || info.issuers.has(primary.fingerprint);
  const want = normalizeAddress(email);
  const keySigs = [];
  const uidSigs = [];
  let section = 'key';
  let uidMatches = false;
  let subkeys = 0;
  for (const packet of packets.slice(1)) {
    if (packet.tag === TAG.USER_ID) {
      section = 'uid';
      uidMatches = emailFromUserId(packet.body.toString('utf8')) === want;
      continue;
    }
    if (packet.tag === TAG.PUBLIC_SUBKEY) { section = 'subkey'; subkeys++; continue; }
    if (packet.tag !== TAG.SIGNATURE) continue;
    let info;
    try { info = signatureInfo(packet.body); } catch { continue; }
    if (!bySelf(info)) continue;
    if (section === 'key') keySigs.push(info);
    else if (section === 'uid' && uidMatches) uidSigs.push(info);
  }
  if (!subkeys) return 'cannotEncrypt';
  if ([...keySigs, ...uidSigs].some(i => i.type === SIG_KEY_REVOCATION || i.type === SIG_CERT_REVOCATION)) return 'revoked';
  // The newest self-signature decides the expiry, as in RFC 9580 5.2.3.13.
  const certs = [...keySigs.filter(i => i.type === SIG_DIRECT_KEY), ...uidSigs.filter(i => i.type >= 0x10 && i.type <= 0x13)]
    .sort((a, b) => b.created - a.created);
  const expires = certs[0]?.keyExpires;
  if (expires && primary.created.getTime() + expires * 1000 <= now.getTime()) return 'expired';
  return null;
}

const validDate = (value) => {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

// What a received message's Autocrypt header offers, from its parsed headers (parseRawHeaders):
//   { ok: true, addr, armored, fingerprint, preferEncrypt, authFailed, timestamp }
// or { ok: false, reason }. The key is kept only when the header's addr is the message's From
// address exactly (after normalizing), a single Autocrypt header was sent, and the key can be
// read, can encrypt and is neither expired nor revoked. `timestamp` is the Date header, never
// later than `now` (a future date would keep a key the newest for good), or null when the message
// has no readable date.
export function readAutocryptHeader(headers, fromEmail, { now = new Date(), messageDate = null } = {}) {
  const raw = headers?.autocrypt;
  if (!raw) return { ok: false, reason: 'noHeader' };
  const parsed = String(raw).split('\n').map(parseAutocryptValue).filter(Boolean);
  if (parsed.length !== 1) return { ok: false, reason: parsed.length ? 'multiple' : 'invalidHeader' };
  const header = parsed[0];
  const from = normalizeAddress(fromEmail);
  if (!from || header.addr !== from) return { ok: false, reason: 'addrMismatch' };
  try {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(header.keydata)) return { ok: false, reason: 'unparseable' };
    const bytes = Buffer.from(header.keydata, 'base64');
    if (!bytes.length || bytes.length > MAX_RECEIVED_KEYDATA_BYTES) return { ok: false, reason: 'unparseable' };
    const block = armor('PGP PUBLIC KEY BLOCK', bytes);
    // First the key itself, with subkey expiry out of the way, so an expired key is reported as
    // that and not as one with nothing to encrypt to; then the subkey that can be used right now.
    const whole = minimalAutocryptKey(block, from, { now: new Date(0) });
    if (!whole) return { ok: false, reason: 'cannotEncrypt' };
    const problem = autocryptKeyProblem(whole, from, now);
    if (problem) return { ok: false, reason: problem };
    const minimal = minimalAutocryptKey(block, from, { now });
    if (!minimal) return { ok: false, reason: 'cannotEncrypt' };
    const primary = parseKeyPacket(readPackets(minimal)[0]);
    let stamp = validDate(String(headers.date || '').split('\n')[0]) || validDate(messageDate);
    if (stamp && stamp.getTime() > now.getTime()) stamp = now;
    return {
      ok: true,
      addr: from,
      armored: armor('PGP PUBLIC KEY BLOCK', minimal),
      fingerprint: primary.fingerprint,
      preferEncrypt: header.preferEncrypt,
      authFailed: authenticationFailed(headers),
      timestamp: stamp,
    };
  } catch (err) {
    if (err instanceof PgpFormatError || err instanceof RangeError) return { ok: false, reason: 'unparseable' };
    throw err;
  }
}
