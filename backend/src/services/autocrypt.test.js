import { describe, expect, it, vi } from 'vitest';
vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('../index.js', () => ({ imapManager: {} }));
vi.mock('./smtpTransport.js', () => ({ createAccountSmtpTransport: vi.fn() }));
import { KEYS } from './pgp.fixtures.js';
import { splitKeys, TAG } from './pgpPackets.js';
import { MAX_KEYDATA_BYTES, autocryptFor, autocryptHeaderValue, minimalAutocryptKey } from './autocrypt.js';
import { buildMailOptions, renderPgpMime, renderRawMessage, validateSendInput } from './outgoingMail.js';

const tags = bytes => splitKeys(bytes)[0].packets.map(p => p.tag);
const userIdsOf = bytes => splitKeys(bytes)[0].userIds;

// The header as a reader sees it: unfolded, attributes split at ';'.
function parseHeader(value) {
  const attrs = {};
  for (const part of value.replace(/\r\n[ \t]/g, ' ').split(';')) {
    const at = part.indexOf('=');
    if (at > 0) attrs[part.slice(0, at).trim()] = part.slice(at + 1).trim();
  }
  return attrs;
}

describe('minimalAutocryptKey', () => {
  it('keeps the primary key, the sending address\'s user ID and one encryption subkey, with their self-signatures', () => {
    const bytes = minimalAutocryptKey(KEYS.alicePublic, 'alice@example.org');
    expect(tags(bytes)).toEqual([TAG.PUBLIC_KEY, TAG.USER_ID, TAG.SIGNATURE, TAG.PUBLIC_SUBKEY, TAG.SIGNATURE]);
    expect(splitKeys(bytes)[0].primary.fingerprint).toBe(KEYS.aliceFingerprint);
  });

  it('leaves out the key\'s other addresses, which would tell every recipient about them', () => {
    const bytes = minimalAutocryptKey(KEYS.bobPublic, 'bob.work@example.com');
    expect(userIdsOf(bytes)).toEqual(['<bob.work@example.com>']);
    expect(splitKeys(Buffer.from(KEYS.bobBinaryBase64, 'base64'))[0].userIds).toHaveLength(2);
  });

  it('keeps a v6 key\'s direct-key signature, which carries its flags', () => {
    expect(tags(minimalAutocryptKey(KEYS.davePublic, 'dave@example.org')))
      .toEqual([TAG.PUBLIC_KEY, TAG.SIGNATURE, TAG.USER_ID, TAG.SIGNATURE, TAG.PUBLIC_SUBKEY, TAG.SIGNATURE]);
  });

  it('is null for an address the key is not for', () => {
    expect(minimalAutocryptKey(KEYS.alicePublic, 'someone@example.org')).toBeNull();
  });
});

describe('autocryptHeaderValue', () => {
  const keydata = minimalAutocryptKey(KEYS.alicePublic, 'alice@example.org');

  it('is addr, then keydata last, as Autocrypt Level 1 has it', () => {
    const value = autocryptHeaderValue({ addr: 'alice@example.org', keydata });
    const attrs = parseHeader(value);
    expect(Object.keys(attrs)).toEqual(['addr', 'keydata']);
    expect(attrs.addr).toBe('alice@example.org');
    expect(Buffer.from(attrs.keydata.replace(/\s+/g, ''), 'base64')).toEqual(keydata);
  });

  it('says prefer-encrypt=mutual only when asked', () => {
    expect(parseHeader(autocryptHeaderValue({ addr: 'a@example.org', keydata, preferEncrypt: true }))['prefer-encrypt']).toBe('mutual');
    expect(autocryptHeaderValue({ addr: 'a@example.org', keydata })).not.toContain('prefer-encrypt');
  });

  it('folds keydata so no header line passes 78 characters', () => {
    const lines = `Autocrypt: ${autocryptHeaderValue({ addr: 'alice@example.org', keydata, preferEncrypt: true })}`.split('\r\n');
    expect(lines.length).toBeGreaterThan(3);
    expect(lines.every(l => l.length <= 78)).toBe(true);
    expect(lines.slice(1).every(l => l.startsWith(' '))).toBe(true);
  });
});

describe('autocryptFor', () => {
  it('builds the header from the newest key for the From address, scoped to the user', async () => {
    const query = vi.fn(async () => ({ rows: [{ armored_public: KEYS.alicePublic }] }));
    const value = await autocryptFor('u1', 'Alice@Example.org', { preferEncrypt: true, query });
    expect(query.mock.calls[0][1]).toEqual(['u1', 'alice@example.org']);
    expect(query.mock.calls[0][0]).toContain('user_id = $1');
    expect(parseHeader(value)).toMatchObject({ addr: 'alice@example.org', 'prefer-encrypt': 'mutual' });
  });

  it('is null without a key, for a damaged one, and for one too big for every message', async () => {
    expect(await autocryptFor('u1', 'a@example.org', { query: async () => ({ rows: [] }) })).toBeNull();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await autocryptFor('u1', 'alice@example.org', { query: async () => ({ rows: [{ armored_public: 'not a key' }] }) })).toBeNull();
    expect(await autocryptFor('u1', 'alice@example.org', { query: async () => { throw new Error('db down'); } })).toBeNull();
    expect(MAX_KEYDATA_BYTES).toBeLessThan(64 * 1024);
  });
});

describe('the Autocrypt header on outgoing mail', () => {
  const account = { id: 'a1', email_address: 'alice@example.org' };
  const identity = autocrypt => ({ account, plaintextEmail: false, fromName: 'Alice', fromEmail: 'alice@example.org', replyTo: null, signature: null, autocrypt });
  const input = extra => validateSendInput({ accountId: 'a1', to: ['bob@example.net'], subject: 'Hi', body: 'Hello', ...extra });
  const value = autocryptHeaderValue({ addr: 'alice@example.org', keydata: minimalAutocryptKey(KEYS.alicePublic, 'alice@example.org'), preferEncrypt: true });
  const headerOf = raw => /^Autocrypt: [\s\S]*?(?=\r\n(?![ \t]))/m.exec(raw.toString('latin1'))?.[0];

  it('goes on plain mail as built, folded lines intact', async () => {
    const raw = await renderRawMessage(buildMailOptions(input(), identity(value)));
    expect(headerOf(raw)).toBe(`Autocrypt: ${value}`);
  });

  it('goes on encrypted mail too, outside the encryption', async () => {
    const options = buildMailOptions(input({ body: '', pgp: { encrypted: '-----BEGIN PGP MESSAGE-----\n\nwcBMA\n-----END PGP MESSAGE-----\n' } }), identity(value));
    const { smtpRaw } = await renderPgpMime(options, '-----BEGIN PGP MESSAGE-----\n\nwcBMA\n-----END PGP MESSAGE-----\n');
    expect(headerOf(smtpRaw)).toBe(`Autocrypt: ${value}`);
  });

  it('is absent when the sender has no key', async () => {
    const raw = await renderRawMessage(buildMailOptions(input(), identity(null)));
    expect(raw.toString('latin1')).not.toMatch(/^Autocrypt:/m);
  });
});
