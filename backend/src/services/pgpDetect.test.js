import { describe, expect, it } from 'vitest';
import { PGP_ENCRYPTED_SNIPPET, pgpKindOfBody, pgpKindOfStructure, pgpSnippet } from './pgpDetect.js';
import { parseMessage, snippetFromBody } from './messageParser.js';

// IMAP BODYSTRUCTUREs as imapflow gives them.
const encrypted = {
  type: 'multipart/encrypted',
  parameters: { protocol: 'application/pgp-encrypted', boundary: 'b' },
  childNodes: [
    { part: '1', type: 'application/pgp-encrypted', size: 12 },
    { part: '2', type: 'application/octet-stream', parameters: { name: 'encrypted.asc' }, disposition: 'inline', size: 2000 },
  ],
};
const signed = {
  type: 'multipart/signed',
  parameters: { protocol: 'application/pgp-signature', micalg: 'pgp-sha256', boundary: 's' },
  childNodes: [{ part: '1', type: 'text/plain' }, { part: '2', type: 'application/pgp-signature', parameters: { name: 'signature.asc' } }],
};
const inlineArmor = '-----BEGIN PGP MESSAGE-----\n\nhQEMA1234\n=abcd\n-----END PGP MESSAGE-----\n';

describe('pgpKindOfStructure', () => {
  it('recognizes PGP/MIME encrypted and signed messages', () => {
    expect(pgpKindOfStructure(encrypted)).toBe('encrypted');
    expect(pgpKindOfStructure(signed)).toBe('signed');
  });

  it('only at the root: an encrypted or signed part inside ordinary mail is that mail\'s content', () => {
    expect(pgpKindOfStructure({ type: 'multipart/mixed', childNodes: [signed, { type: 'text/plain' }] })).toBe(null);
    expect(pgpKindOfStructure({ type: 'multipart/mixed', childNodes: [encrypted, { type: 'text/plain' }] })).toBe(null);
  });

  it('does not take S/MIME or ordinary mail for OpenPGP', () => {
    expect(pgpKindOfStructure({ type: 'multipart/signed', parameters: { protocol: 'application/pkcs7-signature' }, childNodes: [] })).toBe(null);
    expect(pgpKindOfStructure({ type: 'text/plain' })).toBe(null);
    expect(pgpKindOfStructure(null)).toBe(null);
  });
});

describe('pgpKindOfBody', () => {
  it('reads the stored marks of an encrypted or signed message', () => {
    expect(pgpKindOfBody({ snippet: PGP_ENCRYPTED_SNIPPET })).toBe('encrypted');
    expect(pgpKindOfBody({ text: `\n  ${inlineArmor}` })).toBe('encrypted');
    expect(pgpKindOfBody({ text: '-----BEGIN PGP SIGNED MESSAGE-----\nHash: SHA256\n\nhi\n-----BEGIN PGP SIGNATURE-----\nx\n-----END PGP SIGNATURE-----' })).toBe('signed');
    expect(pgpKindOfBody({ attachments: '[{"type":"application/pgp-signature"}]' })).toBe('signed');
    expect(pgpKindOfBody({ structureKind: 'encrypted', text: 'whatever' })).toBe('encrypted');
    expect(pgpKindOfBody({ text: 'An email that mentions -----BEGIN PGP MESSAGE----- in passing.' })).toBe(null);
  });

  it('does not take ordinary mail for encrypted: a quoted or pasted block, a .pgp file', () => {
    // Its body and attachments would be hidden behind a lock that opens nothing.
    expect(pgpKindOfBody({ text: `Here is what you sent:\n${inlineArmor}` })).toBe(null);
    expect(pgpKindOfBody({ text: inlineArmor.split('\n').map(l => `> ${l}`).join('\n') })).toBe(null);
    expect(pgpKindOfBody({ attachments: [{ type: 'application/pgp-encrypted', filename: 'backup.pgp' }] })).toBe(null);
    expect(pgpKindOfBody({ attachments: '[{"type":"application/pgp-encrypted","filename":"backup.pgp"}]' })).toBe(null);
  });
});

describe('snippets of encrypted mail', () => {
  it('stores the marker rather than ciphertext or the version part', () => {
    expect(pgpSnippet(encrypted, 'Version: 1')).toBe(PGP_ENCRYPTED_SNIPPET);
    expect(pgpSnippet({ type: 'text/plain' }, '-----BEGIN PGP MESSAGE----- hQEMA')).toBe(PGP_ENCRYPTED_SNIPPET);
    expect(pgpSnippet({ type: 'text/plain' }, 'Hello')).toBe('Hello');
    expect(snippetFromBody(inlineArmor, null)).toBe(PGP_ENCRYPTED_SNIPPET);
  });

  it('shows a cleartext-signed message\'s text without its armor', () => {
    const text = '-----BEGIN PGP SIGNED MESSAGE-----\nHash: SHA256\n\nSee you at ten.\n- -- dashes\n-----BEGIN PGP SIGNATURE-----\n\nwnUE\n-----END PGP SIGNATURE-----\n';
    expect(snippetFromBody(text, null)).toBe('See you at ten. -- dashes');
  });

  it('gives a synced PGP/MIME message the marker as its snippet', async () => {
    const parsed = await parseMessage({
      uid: 7,
      envelope: { from: [{ name: 'Bob', address: 'bob@example.net' }], subject: 'Hi' },
      flags: new Set(),
      bodyStructure: encrypted,
      bodyParts: new Map([['1', Buffer.from('Version: 1\r\n')]]),
    });
    expect(parsed.snippet).toBe(PGP_ENCRYPTED_SNIPPET);
  });
});
