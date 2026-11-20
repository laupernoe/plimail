import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signatureLinkHref, signatureLinkLabel } from './signatureLink.js';

test('a bare email address becomes a mailto link', () => {
  assert.equal(signatureLinkHref('noe@example.com'), 'mailto:noe@example.com');
  assert.equal(signatureLinkHref('  first.last+x@mail.example.ch '), 'mailto:first.last+x@mail.example.ch');
});
test('mailto: and tel: are kept', () => {
  assert.equal(signatureLinkHref('mailto:a@b.co'), 'mailto:a@b.co');
  assert.equal(signatureLinkHref('MAILTO:a@b.co?subject=Hi'), 'mailto:a@b.co?subject=Hi');
  assert.equal(signatureLinkHref('tel:+41 21 123 45 67'), 'tel:+41211234567');
});
test('a phone number becomes a tel link', () => {
  assert.equal(signatureLinkHref('+41 79 123 45 67'), 'tel:+41791234567');
});
test('web addresses keep https or get it', () => {
  assert.equal(signatureLinkHref('https://example.com/a?b=1'), 'https://example.com/a?b=1');
  assert.equal(signatureLinkHref('http://example.com'), 'http://example.com');
  assert.equal(signatureLinkHref('example.com'), 'https://example.com');
  assert.equal(signatureLinkHref('localhost:8080/x'), 'https://localhost:8080/x');
});
test('script-capable and other schemes are refused', () => {
  for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', 'data:text/html,<b>x</b>', 'vbscript:x', 'file:///etc/passwd', '//evil.example', 'mailto:not-an-address', '', '   ', null, undefined, 'a b@c.de']) {
    assert.equal(signatureLinkHref(bad), null, String(bad));
  }
});
test('the label for an address drops its scheme', () => {
  assert.equal(signatureLinkLabel('mailto:a@b.co'), 'a@b.co');
  assert.equal(signatureLinkLabel('tel:+4179'), '+4179');
  assert.equal(signatureLinkLabel('https://x.ch'), 'https://x.ch');
});
