import { createHash } from 'node:crypto';

// Just enough of OpenPGP (RFC 9580, and RFC 4880 for v4 keys) for the server to check the keys it
// is asked to store, without doing any cryptography itself: armor, the packet framing, and the
// public part of key packets, for fingerprints, user IDs and whether secret key material is
// protected by a passphrase. Every operation on the keys themselves happens in the browser.

export class PgpFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PgpFormatError';
    this.status = 400;
  }
}

export const TAG = Object.freeze({
  SIGNATURE: 2, SECRET_KEY: 5, PUBLIC_KEY: 6, SECRET_SUBKEY: 7, USER_ID: 13, PUBLIC_SUBKEY: 14, USER_ATTRIBUTE: 17,
});

// Larger than any ordinary key with its signatures, small enough to keep a pasted keyring or a
// directory's answer from becoming a memory problem.
export const MAX_KEY_BYTES = 256 * 1024;

const ARMOR_TYPES = new Set(['PGP PUBLIC KEY BLOCK', 'PGP PRIVATE KEY BLOCK', 'PGP MESSAGE', 'PGP SIGNATURE']);

// CRC-24 of RFC 9580 6.1, the armor checksum.
export function crc24(bytes) {
  let crc = 0xB704CE;
  for (const byte of bytes) {
    crc ^= byte << 16;
    for (let i = 0; i < 8; i++) {
      crc <<= 1;
      if (crc & 0x1000000) crc ^= 0x1864CFB;
    }
  }
  return crc & 0xFFFFFF;
}

// The first armored block in `text`: { type, bytes }. Armor headers (Version:, Comment:) are
// skipped; a checksum, when present, must match.
export function dearmor(text) {
  if (typeof text !== 'string') throw new PgpFormatError('Not an armored OpenPGP block');
  const begin = /-----BEGIN ([A-Z ]+?)-----\r?\n/.exec(text);
  if (!begin || !ARMOR_TYPES.has(begin[1])) throw new PgpFormatError('Not an armored OpenPGP block');
  const type = begin[1];
  const endMarker = `-----END ${type}-----`;
  const end = text.indexOf(endMarker, begin.index + begin[0].length);
  if (end < 0) throw new PgpFormatError('The armored block is not complete');
  const lines = text.slice(begin.index + begin[0].length, end).split(/\r?\n/);
  // Headers run up to the first empty line. A block without headers may start with the data at
  // once (some tools omit the empty line), which never contains a colon.
  let i = 0;
  if (lines.some(l => l.trim() === '')) {
    while (i < lines.length && lines[i].trim() !== '') {
      if (!/^[A-Za-z][A-Za-z0-9-]*: /.test(lines[i])) break;
      i++;
    }
    if (i < lines.length && lines[i].trim() === '') i++;
  }
  let checksum = null;
  const data = [];
  for (const raw of lines.slice(i)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^=[A-Za-z0-9+/]{4}$/.test(line)) { checksum = line.slice(1); continue; }
    if (!/^[A-Za-z0-9+/=]+$/.test(line)) throw new PgpFormatError('The armored block is not valid base64');
    data.push(line);
  }
  const bytes = Buffer.from(data.join(''), 'base64');
  if (!bytes.length) throw new PgpFormatError('The armored block is empty');
  if (checksum !== null) {
    const expected = Buffer.from(checksum, 'base64');
    const sum = (expected[0] << 16) | (expected[1] << 8) | expected[2];
    if (sum !== crc24(bytes)) throw new PgpFormatError('The armored block is damaged (checksum mismatch)');
  }
  return { type, bytes };
}

// `bytes` as an armored block of `type`, with a checksum (RFC 9580 6.2: optional, and harmless).
export function armor(type, bytes) {
  if (!ARMOR_TYPES.has(type)) throw new TypeError(`Unknown armor type ${type}`);
  const b64 = Buffer.from(bytes).toString('base64');
  const lines = b64.match(/.{1,64}/g) || [];
  const crc = crc24(bytes);
  const sum = Buffer.from([(crc >> 16) & 0xFF, (crc >> 8) & 0xFF, crc & 0xFF]).toString('base64');
  return `-----BEGIN ${type}-----\n\n${lines.join('\n')}\n=${sum}\n-----END ${type}-----\n`;
}

// The packets in `bytes`, each { tag, body, start, end } where start..end is the whole packet,
// header included. Partial body lengths are joined.
export function readPackets(bytes) {
  const buf = Buffer.from(bytes);
  const packets = [];
  let pos = 0;
  const need = n => { if (pos + n > buf.length) throw new PgpFormatError('Truncated OpenPGP packet'); };
  while (pos < buf.length) {
    const start = pos;
    const header = buf[pos++];
    if (!(header & 0x80)) throw new PgpFormatError('Not OpenPGP data');
    let tag;
    const chunks = [];
    if (header & 0x40) {
      tag = header & 0x3F;
      for (;;) {
        need(1);
        const o1 = buf[pos++];
        let len;
        let partial = false;
        if (o1 < 192) len = o1;
        else if (o1 < 224) { need(1); len = ((o1 - 192) << 8) + buf[pos++] + 192; }
        else if (o1 === 255) { need(4); len = buf.readUInt32BE(pos); pos += 4; }
        else { len = 1 << (o1 & 0x1F); partial = true; }
        need(len);
        chunks.push(buf.subarray(pos, pos + len));
        pos += len;
        if (!partial) break;
      }
    } else {
      tag = (header >> 2) & 0x0F;
      const lengthType = header & 0x03;
      let len;
      if (lengthType === 0) { need(1); len = buf[pos]; pos += 1; }
      else if (lengthType === 1) { need(2); len = buf.readUInt16BE(pos); pos += 2; }
      else if (lengthType === 2) { need(4); len = buf.readUInt32BE(pos); pos += 4; }
      else len = buf.length - pos;
      need(len);
      chunks.push(buf.subarray(pos, pos + len));
      pos += len;
    }
    packets.push({ tag, body: chunks.length === 1 ? chunks[0] : Buffer.concat(chunks), start, end: pos });
  }
  return packets;
}

// Length of an MPI at `pos` (two octets of bit count, then the bytes).
function mpiLength(body, pos) {
  if (pos + 2 > body.length) throw new PgpFormatError('Truncated key material');
  return 2 + Math.ceil(body.readUInt16BE(pos) / 8);
}

// Length of a curve OID field at `pos` (one octet of length, then the OID).
function oidLength(body, pos) {
  if (pos + 1 > body.length) throw new PgpFormatError('Truncated key material');
  return 1 + body[pos];
}

// Where the public key material of a v3/v4 key packet ends, from `pos` just past the algorithm.
function v4MaterialEnd(body, pos, algorithm) {
  const mpis = n => { for (let i = 0; i < n; i++) pos += mpiLength(body, pos); };
  switch (algorithm) {
    case 1: case 2: case 3: mpis(2); break; // RSA: n, e
    case 16: case 20: mpis(3); break; // Elgamal: p, g, y
    case 17: mpis(4); break; // DSA: p, q, g, y
    case 18: // ECDH: OID, point, KDF parameters
      pos += oidLength(body, pos);
      mpis(1);
      if (pos + 1 > body.length) throw new PgpFormatError('Truncated key material');
      pos += 1 + body[pos];
      break;
    case 19: case 22: // ECDSA, EdDSA (legacy): OID, point
      pos += oidLength(body, pos);
      mpis(1);
      break;
    case 25: pos += 32; break; // X25519
    case 26: pos += 56; break; // X448
    case 27: pos += 32; break; // Ed25519
    case 28: pos += 57; break; // Ed448
    default: throw new PgpFormatError(`Unsupported public key algorithm ${algorithm}`);
  }
  if (pos > body.length) throw new PgpFormatError('Truncated key material');
  return pos;
}

// The public part of a key packet (tags 5, 6, 7, 14): { version, algorithm, created, publicEnd,
// fingerprint (hex, lower case), keyId (hex) }. For a secret key packet, `secretProtected` says
// whether its secret material is encrypted (S2K usage octet other than 0).
export function parseKeyPacket(packet) {
  const body = packet.body;
  if (body.length < 6) throw new PgpFormatError('Truncated key packet');
  const version = body[0];
  let pos;
  let algorithm;
  const created = new Date(body.readUInt32BE(1) * 1000);
  if (version === 4) {
    algorithm = body[5];
    pos = v4MaterialEnd(body, 6, algorithm);
  } else if (version === 3 || version === 2) {
    if (body.length < 8) throw new PgpFormatError('Truncated key packet');
    algorithm = body[7];
    pos = v4MaterialEnd(body, 8, algorithm);
  } else if (version === 5 || version === 6) {
    if (body.length < 10) throw new PgpFormatError('Truncated key packet');
    algorithm = body[5];
    pos = 10 + body.readUInt32BE(6);
    if (pos > body.length) throw new PgpFormatError('Truncated key material');
  } else {
    throw new PgpFormatError(`Unsupported key version ${version}`);
  }
  const publicBody = body.subarray(0, pos);
  let fingerprint;
  let keyId;
  if (version === 4) {
    const head = Buffer.from([0x99, (publicBody.length >> 8) & 0xFF, publicBody.length & 0xFF]);
    fingerprint = createHash('sha1').update(head).update(publicBody).digest('hex');
    keyId = fingerprint.slice(-16);
  } else if (version === 5 || version === 6) {
    const head = Buffer.alloc(5);
    head[0] = version === 6 ? 0x9B : 0x9A;
    head.writeUInt32BE(publicBody.length, 1);
    fingerprint = createHash('sha256').update(head).update(publicBody).digest('hex');
    keyId = fingerprint.slice(0, 16);
  } else {
    // v3 fingerprints are MD5 over the RSA modulus; such keys are long obsolete and only listed.
    fingerprint = createHash('md5').update(publicBody).digest('hex');
    keyId = fingerprint.slice(-16);
  }
  const info = { version, algorithm, created, publicEnd: pos, fingerprint, keyId };
  if (packet.tag === TAG.SECRET_KEY || packet.tag === TAG.SECRET_SUBKEY) {
    if (pos >= body.length) throw new PgpFormatError('Truncated secret key packet');
    info.secretProtected = body[pos] !== 0;
  }
  return info;
}

// The address in a user ID such as "Alice <alice@example.org>" or a bare address, lower-cased.
export function emailFromUserId(userId) {
  const s = String(userId || '');
  const angle = /<([^<>\s]+@[^<>\s]+)>/.exec(s);
  const candidate = angle ? angle[1] : (/^\s*([^<>\s]+@[^<>\s]+)\s*$/.exec(s) || [])[1];
  if (!candidate || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(candidate)) return null;
  return candidate.toLowerCase();
}

// The transferable keys in `bytes`, split at each primary key packet: [{ primary, secret,
// userIds, emails, subkeys, packets, bytes }]. `secret` says the key carries secret packets.
export function splitKeys(bytes) {
  const buf = Buffer.from(bytes);
  if (buf.length > MAX_KEY_BYTES) throw new PgpFormatError('The key is too large');
  const packets = readPackets(buf);
  const keys = [];
  let current = null;
  for (const packet of packets) {
    if (packet.tag === TAG.PUBLIC_KEY || packet.tag === TAG.SECRET_KEY) {
      current = { primary: parseKeyPacket(packet), secret: packet.tag === TAG.SECRET_KEY, userIds: [], subkeys: [], packets: [packet] };
      keys.push(current);
      continue;
    }
    if (!current) {
      // Signatures or markers ahead of any key mean this is not a key.
      throw new PgpFormatError('This is not an OpenPGP key');
    }
    current.packets.push(packet);
    if (packet.tag === TAG.USER_ID) current.userIds.push(packet.body.toString('utf8'));
    else if (packet.tag === TAG.PUBLIC_SUBKEY || packet.tag === TAG.SECRET_SUBKEY) {
      if (packet.tag === TAG.SECRET_SUBKEY) current.secret = true;
      current.subkeys.push({ ...parseKeyPacket(packet), secret: packet.tag === TAG.SECRET_SUBKEY });
    } else if (![TAG.SIGNATURE, TAG.USER_ATTRIBUTE, 12 /* trust */, 10 /* marker */, 21 /* padding */].includes(packet.tag)) {
      throw new PgpFormatError(`Unexpected packet in a key (tag ${packet.tag})`);
    }
  }
  if (!keys.length) throw new PgpFormatError('This is not an OpenPGP key');
  for (const key of keys) {
    key.emails = [...new Set(key.userIds.map(emailFromUserId).filter(Boolean))];
    key.bytes = Buffer.concat(key.packets.map(p => buf.subarray(p.start, p.end)));
  }
  return keys;
}

// A public key block someone gave us (pasted, a file, a directory, an attachment), armored or
// binary: the keys in it, each with its armored form. Anything carrying secret key material is
// refused, so a private key pasted in the wrong place is never stored as if it were public.
export function parsePublicKeys(input) {
  let bytes;
  if (typeof input === 'string') {
    const block = dearmor(input);
    if (block.type !== 'PGP PUBLIC KEY BLOCK') {
      throw new PgpFormatError(block.type === 'PGP PRIVATE KEY BLOCK'
        ? 'This is a private key. Only public keys belong in the keyring.'
        : 'This is not a public key');
    }
    bytes = block.bytes;
  } else {
    bytes = Buffer.from(input);
  }
  const keys = splitKeys(bytes);
  if (keys.some(k => k.secret)) throw new PgpFormatError('This is a private key. Only public keys belong in the keyring.');
  return keys.map(k => ({ ...k, armored: armor('PGP PUBLIC KEY BLOCK', k.bytes) }));
}

// The user's own key pair as the browser sends it: one private key whose every secret packet is
// protected by a passphrase, and its public key. Returns { fingerprint, emails, userIds,
// created, armoredPublic, armoredPrivate }, both re-armored from the parsed bytes.
export function parseOwnKeyPair(armoredPrivate, armoredPublic) {
  const priv = dearmor(armoredPrivate);
  if (priv.type !== 'PGP PRIVATE KEY BLOCK') throw new PgpFormatError('The private key is not an armored private key block');
  const privKeys = splitKeys(priv.bytes);
  if (privKeys.length !== 1) throw new PgpFormatError('Import one key at a time');
  const secret = privKeys[0];
  const secretPackets = secret.packets.filter(p => p.tag === TAG.SECRET_KEY || p.tag === TAG.SECRET_SUBKEY);
  if (!secretPackets.length) throw new PgpFormatError('This key has no secret part');
  // The rule this whole feature rests on: no secret key reaches the database unencrypted.
  if (secretPackets.some(p => !parseKeyPacket(p).secretProtected)) {
    throw Object.assign(new PgpFormatError('The private key must be protected by a passphrase'), { code: 'unprotected_key' });
  }
  const [pub] = parsePublicKeys(armoredPublic);
  if (!pub || pub.primary.fingerprint !== secret.primary.fingerprint) {
    throw new PgpFormatError('The public key does not belong to this private key');
  }
  return {
    fingerprint: secret.primary.fingerprint,
    emails: pub.emails,
    userIds: pub.userIds,
    created: secret.primary.created,
    algorithm: secret.primary.algorithm,
    armoredPublic: pub.armored,
    armoredPrivate: armor('PGP PRIVATE KEY BLOCK', secret.bytes),
  };
}
