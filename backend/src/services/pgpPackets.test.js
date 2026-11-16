import { describe, expect, it } from 'vitest';
import { KEYS } from './pgp.fixtures.js';
import {
  PgpFormatError, TAG, armor, crc24, dearmor, emailFromUserId, parseOwnKeyPair, parsePublicKeys, readPackets, splitKeys,
} from './pgpPackets.js';

describe('armor', () => {
  it('computes the RFC 9580 CRC-24', () => {
    // The CRC of no data is the initial value.
    expect(crc24(Buffer.alloc(0))).toBe(0xB704CE);
  });

  it('round-trips bytes through armor and dearmor', () => {
    const bytes = Buffer.from(KEYS.bobBinaryBase64, 'base64');
    const text = armor('PGP PUBLIC KEY BLOCK', bytes);
    const back = dearmor(text);
    expect(back.type).toBe('PGP PUBLIC KEY BLOCK');
    expect(Buffer.compare(back.bytes, bytes)).toBe(0);
  });

  it('reads blocks with armor headers and CRLF line ends', () => {
    const bytes = Buffer.from(KEYS.bobBinaryBase64, 'base64');
    const text = armor('PGP PUBLIC KEY BLOCK', bytes).replace('\n\n', '\nVersion: Test 1.0\nComment: hello\n\n').replace(/\n/g, '\r\n');
    expect(Buffer.compare(dearmor(text).bytes, bytes)).toBe(0);
  });

  it('refuses a block whose checksum does not match', () => {
    const lines = KEYS.alicePublic.split('\n');
    const i = lines.findIndex(l => /^=[A-Za-z0-9+/]{4}$/.test(l));
    lines[i] = lines[i] === '=AAAA' ? '=BBBB' : '=AAAA';
    expect(() => dearmor(lines.join('\n'))).toThrow(/checksum/);
  });

  it('refuses text that is not armored OpenPGP', () => {
    expect(() => dearmor('hello')).toThrow(PgpFormatError);
    expect(() => dearmor('-----BEGIN PGP PUBLIC KEY BLOCK-----\n\nAAAA\n')).toThrow(/not complete/);
  });
});

describe('key parsing', () => {
  it('computes v4 fingerprints as OpenPGP.js does (curve25519 and RSA)', () => {
    expect(parsePublicKeys(KEYS.alicePublic)[0].primary.fingerprint).toBe(KEYS.aliceFingerprint);
    expect(parsePublicKeys(KEYS.carolPublic)[0].primary.fingerprint).toBe(KEYS.carolFingerprint);
  });

  it('computes v6 fingerprints', () => {
    const [key] = parsePublicKeys(KEYS.davePublic);
    expect(key.primary.version).toBe(6);
    expect(key.primary.fingerprint).toBe(KEYS.daveFingerprint);
  });

  it('reads user IDs and their addresses, lower-cased', () => {
    const [bob] = parsePublicKeys(KEYS.bobPublic);
    expect(bob.userIds).toEqual(['Bob <Bob@Example.net>', '<bob.work@example.com>']);
    expect(bob.emails).toEqual(['bob@example.net', 'bob.work@example.com']);
  });

  it('reads binary keys too', () => {
    const [bob] = parsePublicKeys(Buffer.from(KEYS.bobBinaryBase64, 'base64'));
    expect(bob.primary.fingerprint).toBe(KEYS.bobFingerprint);
  });

  it('splits a block holding several keys', () => {
    const bytes = Buffer.concat([dearmor(KEYS.alicePublic).bytes, dearmor(KEYS.bobPublic).bytes]);
    const keys = parsePublicKeys(armor('PGP PUBLIC KEY BLOCK', bytes));
    expect(keys.map(k => k.primary.fingerprint)).toEqual([KEYS.aliceFingerprint, KEYS.bobFingerprint]);
    // Each key is armored on its own.
    expect(parsePublicKeys(keys[1].armored)[0].primary.fingerprint).toBe(KEYS.bobFingerprint);
  });

  it('never takes a private key for a public one', () => {
    expect(() => parsePublicKeys(KEYS.bobUnprotectedPrivate)).toThrow(/private key/);
    // Not even re-armored under the public header.
    const disguised = armor('PGP PUBLIC KEY BLOCK', dearmor(KEYS.alicePrivate).bytes);
    expect(() => parsePublicKeys(disguised)).toThrow(/private key/);
  });

  it('refuses data that does not start with a key', () => {
    const packets = readPackets(dearmor(KEYS.alicePublic).bytes);
    const sig = packets.find(p => p.tag === TAG.SIGNATURE);
    const bytes = dearmor(KEYS.alicePublic).bytes.subarray(sig.start, sig.end);
    expect(() => splitKeys(bytes)).toThrow(/not an OpenPGP key/);
  });

  it('refuses truncated data', () => {
    const bytes = dearmor(KEYS.alicePublic).bytes;
    expect(() => parsePublicKeys(bytes.subarray(0, bytes.length - 10))).toThrow(PgpFormatError);
  });
});

describe('parseOwnKeyPair', () => {
  it('accepts a passphrase-protected key with its public key', () => {
    const pair = parseOwnKeyPair(KEYS.alicePrivate, KEYS.alicePublic);
    expect(pair.fingerprint).toBe(KEYS.aliceFingerprint);
    expect(pair.emails).toEqual(['alice@example.org']);
    expect(dearmor(pair.armoredPrivate).type).toBe('PGP PRIVATE KEY BLOCK');
  });

  it('accepts protected RSA and v6 keys', () => {
    expect(parseOwnKeyPair(KEYS.carolPrivate, KEYS.carolPublic).fingerprint).toBe(KEYS.carolFingerprint);
    expect(parseOwnKeyPair(KEYS.davePrivate, KEYS.davePublic).fingerprint).toBe(KEYS.daveFingerprint);
  });

  it('refuses a private key without a passphrase', () => {
    expect(() => parseOwnKeyPair(KEYS.bobUnprotectedPrivate, KEYS.bobPublic)).toThrow(/passphrase/);
  });

  it('refuses a public key that belongs to another key', () => {
    expect(() => parseOwnKeyPair(KEYS.alicePrivate, KEYS.carolPublic)).toThrow(/does not belong/);
  });

  it('refuses a public key where the private key goes', () => {
    expect(() => parseOwnKeyPair(KEYS.alicePublic, KEYS.alicePublic)).toThrow(/private key block/);
  });
});

describe('emailFromUserId', () => {
  it('takes the address from the usual forms', () => {
    expect(emailFromUserId('Alice <Alice@Example.org>')).toBe('alice@example.org');
    expect(emailFromUserId('alice@example.org')).toBe('alice@example.org');
    expect(emailFromUserId('Alice (work)')).toBe(null);
    expect(emailFromUserId('<not an address>')).toBe(null);
  });
});
