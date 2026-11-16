import { describe, expect, it, vi } from 'vitest';
vi.mock('./db.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
import { KEYS } from './pgp.fixtures.js';
import { AC_KEYS } from './autocrypt.fixtures.js';
import { dearmor } from './pgpPackets.js';
import { authenticationFailed, normalizeAddress, readAutocryptHeader } from './autocryptReceive.js';
import { decideAutocryptStore, storeAutocryptKey } from './pgpKeyring.js';
import { collectAutocrypt } from './autocryptCollect.js';

const keydataOf = armored => dearmor(armored).bytes.toString('base64');
const headerOf = (addr, armored, extra = '') => `addr=${addr}; ${extra}keydata=${keydataOf(armored).replace(/(.{70})/g, '$1 ')}`;
const NOW = new Date('2026-11-16T12:00:00Z');
const read = (headers, from = 'alice@example.org') => readAutocryptHeader(headers, from, { now: NOW });
const alice = { autocrypt: headerOf('alice@example.org', KEYS.alicePublic), date: 'Mon, 02 Nov 2026 10:00:00 +0000' };

describe('readAutocryptHeader: the address', () => {
  it('keeps the key when addr is the From address', () => {
    const r = read(alice);
    expect(r.ok).toBe(true);
    expect(r.addr).toBe('alice@example.org');
    expect(r.fingerprint).toBe(KEYS.aliceFingerprint);
  });

  it('compares after normalizing: case, spaces and angle brackets', () => {
    expect(read({ autocrypt: headerOf('Alice@Example.ORG', KEYS.alicePublic) }, ' <ALICE@example.org> ').ok).toBe(true);
    expect(normalizeAddress('<A@B.c>')).toBe('a@b.c');
  });

  it.each([
    ['another address', 'mallory@example.org'],
    ['a plus address', 'alice+x@example.org'],
    ['another domain', 'alice@example.com'],
    ['a longer domain', 'alice@example.org.evil.test'],
    ['nothing', ''],
  ])('refuses a header whose addr is not the sender: %s', (_, from) => {
    expect(read(alice, from)).toEqual({ ok: false, reason: 'addrMismatch' });
  });

  it('refuses a message with two Autocrypt headers', () => {
    const twice = { autocrypt: `${alice.autocrypt}\n${headerOf('alice@example.org', AC_KEYS.alice2)}` };
    expect(read(twice)).toEqual({ ok: false, reason: 'multiple' });
  });

  it('refuses a header with an unknown critical attribute', () => {
    expect(read({ autocrypt: headerOf('alice@example.org', KEYS.alicePublic, 'foo=bar; ') }).ok).toBe(false);
    expect(read({ autocrypt: headerOf('alice@example.org', KEYS.alicePublic, '_foo=bar; ') }).ok).toBe(true);
  });
});

describe('readAutocryptHeader: the key', () => {
  it('refuses keydata that is not a key', () => {
    expect(read({ autocrypt: 'addr=alice@example.org; keydata=AAAA' }).ok).toBe(false);
    expect(read({ autocrypt: 'addr=alice@example.org; keydata=%%%not base64' }).ok).toBe(false);
  });

  it('refuses an expired key', () => {
    expect(read({ autocrypt: headerOf('expired@example.org', AC_KEYS.expired) }, 'expired@example.org')).toEqual({ ok: false, reason: 'expired' });
  });

  it('keeps a key whose expiry is still ahead', () => {
    expect(read({ autocrypt: headerOf('later@example.org', AC_KEYS.expiresLater) }, 'later@example.org').ok).toBe(true);
  });

  it('refuses a revoked key', () => {
    expect(read({ autocrypt: headerOf('revoked@example.org', AC_KEYS.revoked) }, 'revoked@example.org')).toEqual({ ok: false, reason: 'revoked' });
  });

  it('refuses a key whose encryption subkey expired', () => {
    expect(read({ autocrypt: headerOf('subexp@example.org', AC_KEYS.expiredSubkey) }, 'subexp@example.org').reason).toBe('cannotEncrypt');
  });

  it('refuses a key that cannot encrypt', () => {
    expect(read({ autocrypt: headerOf('signonly@example.org', AC_KEYS.signOnly) }, 'signonly@example.org').reason).toBe('cannotEncrypt');
  });
});

describe('readAutocryptHeader: the date and the authentication', () => {
  it('reads the Date header as the key\'s timestamp', () => {
    expect(read(alice).timestamp).toEqual(new Date('2026-11-02T10:00:00Z'));
  });

  it('never lets a date in the future stand: it is capped at now', () => {
    expect(read({ ...alice, date: 'Fri, 01 Jan 2100 00:00:00 +0000' }).timestamp).toEqual(NOW);
  });

  it('has no timestamp without a readable date', () => {
    expect(read({ autocrypt: alice.autocrypt }).timestamp).toBeNull();
    expect(read({ ...alice, date: 'not a date' }).timestamp).toBeNull();
  });

  it.each([
    ['dmarc=fail', 'mx.example; dmarc=fail header.from=example.org', true],
    ['dkim=fail', 'mx.example; dkim=fail header.d=example.org; spf=pass', true],
    ['dkim=permerror', 'mx.example; dkim=permerror', true],
    ['dkim and dmarc pass', 'mx.example; dkim=pass; dmarc=pass', false],
    ['only spf failing', 'mx.example; spf=fail; dkim=pass', false],
    ['no dkim or dmarc result', 'mx.example; none', false],
  ])('reads the receiving server\'s verdict: %s', (_, value, failed) => {
    expect(authenticationFailed({ 'authentication-results': value })).toBe(failed);
    expect(read({ ...alice, 'authentication-results': value }).authFailed).toBe(failed);
  });

  it('has no verdict without an Authentication-Results header', () => {
    expect(authenticationFailed({})).toBe(false);
  });

  it('goes by the topmost Authentication-Results header, the receiving server\'s own', () => {
    expect(authenticationFailed({ 'authentication-results': 'mx.example; dmarc=fail\nsender.example; dmarc=pass' })).toBe(true);
  });
});

describe('decideAutocryptStore', () => {
  const day = n => new Date(Date.UTC(2026, 10, n));
  const auto = (fingerprint, lastSeen) => ({ fingerprint, source: 'autocrypt', auto_collected: true, verified: false, last_seen: lastSeen });
  const offer = { fingerprint: 'new', timestamp: day(10), authFailed: false };

  it('stores a key for an address that has none', () => {
    expect(decideAutocryptStore([], offer)).toEqual({ action: 'insert' });
  });

  it('replaces an older Autocrypt key with a more recent one', () => {
    expect(decideAutocryptStore([auto('old', day(2))], offer)).toEqual({ action: 'replace' });
  });

  it('refreshes the key it already has when a newer message carries it again', () => {
    expect(decideAutocryptStore([auto('new', day(2))], offer)).toEqual({ action: 'refresh' });
  });

  it('never puts an older key over a newer one, nor over one of the same date', () => {
    expect(decideAutocryptStore([auto('old', day(20))], offer)).toEqual({ action: 'skip', reason: 'older' });
    expect(decideAutocryptStore([auto('old', day(10))], offer)).toEqual({ action: 'skip', reason: 'older' });
  });

  it('replaces nothing when the message has no date', () => {
    expect(decideAutocryptStore([auto('old', day(2))], { ...offer, timestamp: null })).toEqual({ action: 'skip', reason: 'noDate' });
  });

  it.each([
    ['imported by the user', { source: 'manual' }],
    ['from a Web Key Directory', { source: 'wkd' }],
    ['attached to a message', { source: 'attachment' }],
    ['taken by the user from an offer', { source: 'autocrypt', auto_collected: false }],
    ['verified by the user', { verified: true }],
  ])('never replaces a key that is %s', (_, patch) => {
    expect(decideAutocryptStore([{ ...auto('old', day(2)), ...patch }], offer)).toEqual({ action: 'skip', reason: 'protected' });
  });

  it('keeps out a different key as soon as one row of the address is protected', () => {
    expect(decideAutocryptStore([auto('a', day(2)), { ...auto('b', day(2)), source: 'manual' }], offer).reason).toBe('protected');
  });

  it('refuses a message that failed DKIM or DMARC: it neither replaces nor adds a key', () => {
    expect(decideAutocryptStore([auto('old', day(2))], { ...offer, authFailed: true })).toEqual({ action: 'skip', reason: 'auth' });
    expect(decideAutocryptStore([], { ...offer, authFailed: true })).toEqual({ action: 'skip', reason: 'auth' });
  });
});

describe('storeAutocryptKey', () => {
  // A transaction over a fake database holding `rows` for the address; records what it is asked.
  function fakeTransaction(rows, count = 3) {
    const calls = [];
    const db = {
      query: async (sql, params) => {
        calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
        if (/FROM pgp_public_keys WHERE user_id = \$1 AND email = \$2 FOR UPDATE/.test(sql)) return { rows };
        if (/COUNT/.test(sql)) return { rows: [{ n: count }] };
        return { rows: [], rowCount: 1 };
      },
    };
    return { transaction: fn => fn(db), calls };
  }
  const writes = calls => calls.filter(c => /^(INSERT|UPDATE|DELETE)/.test(c.sql)).map(c => c.sql.split(' ')[0]);
  const key = { addr: 'a@example.org', armored: 'ARMORED', fingerprint: 'new', timestamp: new Date('2026-11-10T00:00:00Z'), authFailed: false };
  const row = (patch = {}) => ({ fingerprint: 'old', source: 'autocrypt', auto_collected: true, verified: false, last_seen: new Date('2026-11-01T00:00:00Z'), ...patch });

  it('inserts, marked as from Autocrypt and collected automatically, dated by the message', async () => {
    const t = fakeTransaction([]);
    expect(await storeAutocryptKey('u1', key, t)).toEqual({ action: 'insert' });
    const insert = t.calls.find(c => /^INSERT/.test(c.sql));
    expect(insert.sql).toContain("'autocrypt'");
    expect(insert.sql).toContain('TRUE');
    expect(insert.params).toEqual(['u1', 'a@example.org', 'new', 'ARMORED', key.timestamp]);
  });

  it('replaces the older automatic key: deletes it, then inserts the new one', async () => {
    const t = fakeTransaction([row()]);
    expect((await storeAutocryptKey('u1', key, t)).action).toBe('replace');
    expect(writes(t.calls)).toEqual(['DELETE', 'INSERT']);
  });

  it('only moves the date and copy of a key it already has', async () => {
    const t = fakeTransaction([row({ fingerprint: 'new' })]);
    expect((await storeAutocryptKey('u1', key, t)).action).toBe('refresh');
    expect(writes(t.calls)).toEqual(['UPDATE']);
  });

  it('writes nothing over the user\'s own key, an older message or a failed authentication', async () => {
    for (const [rows, patch] of [[[row({ source: 'manual' })], {}], [[row({ last_seen: new Date('2026-12-01') })], {}], [[row()], { authFailed: true }]]) {
      const t = fakeTransaction(rows);
      expect((await storeAutocryptKey('u1', { ...key, ...patch }, t)).action).toBe('skip');
      expect(writes(t.calls)).toEqual([]);
    }
  });

  it('adds nothing to a full keyring', async () => {
    const t = fakeTransaction([], 5000);
    expect(await storeAutocryptKey('u1', key, t)).toEqual({ action: 'skip', reason: 'full' });
    expect(writes(t.calls)).toEqual([]);
  });
});

describe('collectAutocrypt', () => {
  const message = { uid: 7, folder: 'INBOX', from_email: 'alice@example.org', date: null };
  const account = { id: 'a1', email: 'me@example.net' };
  const headersText = `From: Alice <alice@example.org>\r\nDate: Mon, 02 Nov 2026 10:00:00 +0000\r\nAutocrypt: ${alice.autocrypt}\r\n`;
  const run = (over = {}, deps = {}) => {
    const store = vi.fn(async () => ({ action: 'insert' }));
    const imapManager = { fetchHeaders: vi.fn(async () => headersText) };
    return collectAutocrypt({ imapManager, account, message, userId: 'u1', ...over }, { store, now: () => NOW, ...deps }).then(result => ({ result, store, imapManager }));
  };

  it('stores the key of the message\'s header', async () => {
    const { result, store } = await run();
    expect(result).toEqual({ action: 'insert' });
    expect(store).toHaveBeenCalledWith('u1', expect.objectContaining({ addr: 'alice@example.org', fingerprint: KEYS.aliceFingerprint, authFailed: false }));
  });

  it('does not read the mail server for the user\'s own messages', async () => {
    const { result, imapManager, store } = await run({ message: { ...message, from_email: 'ME@example.net' } });
    expect(result.reason).toBe('own');
    expect(imapManager.fetchHeaders).not.toHaveBeenCalled();
    expect(store).not.toHaveBeenCalled();
  });

  it('stores nothing from a message without the header, or whose addr is not its From', async () => {
    const none = await run({ imapManager: { fetchHeaders: async () => 'From: a@b.c\r\n' } });
    expect(none.store).not.toHaveBeenCalled();
    const forged = await run({ message: { ...message, from_email: 'mallory@example.org' } });
    expect(forged.result.reason).toBe('addrMismatch');
    expect(forged.store).not.toHaveBeenCalled();
  });

  it('passes a failed authentication on, for the keyring to refuse', async () => {
    const { store } = await run({ imapManager: { fetchHeaders: async () => `${headersText}Authentication-Results: mx.example; dmarc=fail\r\n` } });
    expect(store).toHaveBeenCalledWith('u1', expect.objectContaining({ authFailed: true }));
  });

  it('never throws: a mail server that fails is a message without a key', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { result } = await run({ imapManager: { fetchHeaders: async () => { throw new Error('boom'); } } });
    expect(result).toEqual({ action: 'skip', reason: 'error' });
    warn.mockRestore();
  });
});
