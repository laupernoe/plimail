import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import {
  bytesToBinary, canonicalEntityBytes, decodeEncodedWords, decodeQuotedPrintable, extractContent, parseAutocrypt,
  parseMime, parseStructuredHeader, partText,
} from './mimeParse.js';
import { buildMimeEntity, encodeHeaderWord, quotedPrintable } from './mimeBuild.js';

const crlf = s => s.replace(/\n/g, '\r\n');
const text = s => new TextDecoder().decode(s);

test('decodes encoded-words in their own charsets and joins adjacent ones', () => {
  assert.equal(decodeEncodedWords('=?UTF-8?B?w6l0w6k=?= =?ISO-8859-1?Q?=E9t=E9?='), 'étéété');
  assert.equal(decodeEncodedWords('Re: =?utf-8?q?caf=C3=A9_cr=C3=A8me?= now'), 'Re: café crème now');
  assert.equal(decodeEncodedWords('plain'), 'plain');
});

test('reads RFC 2231 parameters, continued and in a charset', () => {
  const { value, params } = parseStructuredHeader(
    "attachment; filename*0*=UTF-8''r%C3%A9sum; filename*1*=%C3%A9.pdf; size=12",
  );
  assert.equal(value, 'attachment');
  assert.equal(params.filename, 'résumé.pdf');
  assert.equal(params.size, '12');
  assert.equal(parseStructuredHeader('text/plain; charset="iso-8859-1"; name="a;b.txt"').params.name, 'a;b.txt');
});

test('decodes quoted-printable with soft line breaks', () => {
  assert.equal(text(decodeQuotedPrintable('caf=C3=A9 =\r\nau lait=3D')), 'café au lait=');
});

test('parses multipart/alternative and charsets, preferring HTML with the text kept', () => {
  const raw = crlf([
    'Content-Type: multipart/alternative; boundary="b1"',
    '',
    'preamble',
    '--b1',
    'Content-Type: text/plain; charset=iso-8859-1',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    'Gr=FC=DFe',
    '--b1',
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from('<p>Grüße</p>').toString('base64'),
    '--b1--',
    'epilogue',
  ].join('\n'));
  const root = parseMime(Buffer.from(raw, 'latin1'));
  const content = extractContent(root);
  assert.equal(content.text, 'Grüße');
  assert.equal(content.html, '<p>Grüße</p>');
  assert.deepEqual(content.attachments, []);
});

test('separates attachments and cid images the HTML uses', () => {
  const raw = crlf([
    'Content-Type: multipart/mixed; boundary=outer',
    '',
    '--outer',
    'Content-Type: multipart/related; boundary=rel',
    '',
    '--rel',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<img src="cid:logo@x">',
    '--rel',
    'Content-Type: image/png',
    'Content-ID: <logo@x>',
    'Content-Transfer-Encoding: base64',
    '',
    'iVBORw0KGgo=',
    '--rel--',
    '--outer',
    'Content-Type: application/pdf; name="=?UTF-8?B?ZmFjdHVyZS5wZGY=?="',
    'Content-Disposition: attachment',
    'Content-Transfer-Encoding: base64',
    '',
    'JVBERi0=',
    '--outer--',
  ].join('\n'));
  const content = extractContent(parseMime(Buffer.from(raw, 'latin1')));
  assert.equal(content.html, '<img src="cid:logo@x">');
  assert.equal(content.inline.length, 1);
  assert.equal(content.inline[0].contentId, 'logo@x');
  assert.deepEqual(content.attachments.map(a => [a.filename, a.mimeType, text(a.data)]), [['facture.pdf', 'application/pdf', '%PDF-']]);
});

test('gives a multipart/signed first part exactly as it was signed, with CRLF', () => {
  const signedPart = 'Content-Type: text/plain\n\nhello\n';
  const raw = [
    'Content-Type: multipart/signed; boundary="s"; protocol="application/pgp-signature"; micalg=pgp-sha256',
    '',
    '--s',
    signedPart,
    '--s',
    'Content-Type: application/pgp-signature',
    '',
    '-----BEGIN PGP SIGNATURE-----',
    '--s--',
    '',
  ].join('\n');
  const root = parseMime(Buffer.from(raw, 'latin1'));
  assert.equal(root.children.length, 2);
  // The line break before the delimiter belongs to the delimiter, not to the part.
  assert.equal(text(canonicalEntityBytes(root.source, root.children[0])), 'Content-Type: text/plain\r\n\r\nhello\r\n');
  assert.equal(partText(root.source, root.children[1]), '-----BEGIN PGP SIGNATURE-----');
});

test('does not take a boundary string inside a line for a delimiter', () => {
  const raw = crlf('Content-Type: multipart/mixed; boundary=b\n\n--b\nContent-Type: text/plain\n\nsee x--b here\n--b--\n');
  const content = extractContent(parseMime(raw));
  assert.equal(content.text, 'see x--b here');
});

test('reads raw 8-bit UTF-8 in headers', () => {
  const raw = Buffer.concat([Buffer.from('Subject: '), Buffer.from('Ça va', 'utf8'), Buffer.from('\r\nContent-Type: multipart/mixed; boundary=b\r\n\r\n--b\r\n\r\nx\r\n--b--\r\n')]);
  assert.equal(extractContent(parseMime(raw)).subject, 'Ça va');
});

test('reads Autocrypt headers and ignores ones with unknown critical attributes', () => {
  assert.deepEqual(parseAutocrypt('addr=Alice@Example.org; prefer-encrypt=mutual; keydata=mQIN AAA='), {
    addr: 'alice@example.org', keydata: 'mQINAAA=', preferEncrypt: 'mutual',
  });
  assert.equal(parseAutocrypt('addr=a@b.c; keydata=AAA; future=1'), null);
  assert.ok(parseAutocrypt('addr=a@b.c; keydata=AAA; _extra=1'));
  assert.equal(parseAutocrypt('addr=a@b.c'), null);
});

test('builds an entity that reads back the same: text, HTML, attachments, protected headers', () => {
  const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0xff, 0x00]);
  const entity = buildMimeEntity({
    html: '<p>Bonjour Zoë</p><img src="data:image/png;base64,iVBORw0KGgo=">',
    text: 'Bonjour Zoë\n.leading dot\nFrom here',
    attachments: [{ filename: 'été 2026.pdf', mimeType: 'application/pdf', data: pdf }],
    headers: { from: { name: 'Zoë', email: 'zoe@example.org' }, to: [{ email: 'bob@example.net' }], subject: 'Réunion à 10 h' },
  });
  // 7-bit and CRLF only, lines short enough for any SMTP server.
  assert.ok(!/[^\t\r\n\x20-\x7e]/.test(entity));
  assert.ok(!/[^\r]\n/.test(entity));
  assert.ok(entity.split('\r\n').every(l => l.length <= 78), 'line too long');
  const root = parseMime(entity);
  const content = extractContent(root);
  assert.equal(content.protectedHeaders, true);
  assert.equal(content.subject, 'Réunion à 10 h');
  assert.equal(content.text, 'Bonjour Zoë\n.leading dot\nFrom here');
  assert.match(content.html, /<p>Bonjour Zoë<\/p><img src="cid:[^"]+">/);
  assert.equal(content.inline.length, 1);
  assert.equal(content.attachments.length, 1);
  assert.equal(content.attachments[0].filename, 'été 2026.pdf');
  assert.deepEqual([...content.attachments[0].data], [...pdf]);
});

test('quoted-printable escapes what could be mangled and keeps lines short', () => {
  const qp = quotedPrintable(`${'x'.repeat(200)} \n.\nFrom me`);
  assert.ok(qp.split('\r\n').every(l => l.length <= 76));
  assert.equal(text(decodeQuotedPrintable(qp)), `${'x'.repeat(200)} \r\n.\r\nFrom me`);
  assert.ok(!/^\./m.test(qp) && !/^From /m.test(qp));
});

test('encodes non-ASCII header words', () => {
  assert.equal(encodeHeaderWord('plain'), 'plain');
  assert.equal(decodeEncodedWords(encodeHeaderWord('Ça marche très bien, même avec un sujet assez long pour être coupé')),
    'Ça marche très bien, même avec un sujet assez long pour être coupé');
});

test('binary strings keep every byte', () => {
  const bytes = new Uint8Array(256).map((_, i) => i);
  assert.equal(bytesToBinary(bytes).length, 256);
});
