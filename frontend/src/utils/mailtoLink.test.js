import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseMailto, mailtoComposeData, mailtoFromSearch, stashMailtoFromLocation, takePendingMailto } from './mailtoLink.js';

function memoryStorage() {
  const map = new Map();
  return {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: k => { map.delete(k); },
  };
}

describe('parseMailto (RFC 6068)', () => {
  it('reads the address list, to, cc, bcc, subject and body', () => {
    assert.deepEqual(
      parseMailto('mailto:a@example.com,b@example.com?cc=c@example.com&bcc=d@example.com&subject=Hello%20there&body=Line%201%0D%0ALine%202'),
      { to: ['a@example.com', 'b@example.com'], cc: ['c@example.com'], bcc: ['d@example.com'], subject: 'Hello there', body: 'Line 1\nLine 2' },
    );
  });

  it('keeps a plus as a plus: it is not the form encoding of a space', () => {
    const parsed = parseMailto('mailto:a+tag@example.com?subject=1+1%3D2&body=x+y');
    assert.deepEqual(parsed.to, ['a+tag@example.com']);
    assert.equal(parsed.subject, '1+1=2');
    assert.equal(parsed.body, 'x+y');
  });

  it('treats header names case-insensitively, scheme included', () => {
    const parsed = parseMailto('MAILTO:a@example.com?Subject=Hi&CC=c@example.com&BODY=b');
    assert.deepEqual(parsed, { to: ['a@example.com'], cc: ['c@example.com'], bcc: [], subject: 'Hi', body: 'b' });
  });

  it('adds a to= header to the address path, and repeated cc headers to each other', () => {
    const parsed = parseMailto('mailto:a@example.com?to=b@example.com&cc=c@example.com&cc=d@example.com,e@example.com');
    assert.deepEqual(parsed.to, ['a@example.com', 'b@example.com']);
    assert.deepEqual(parsed.cc, ['c@example.com', 'd@example.com', 'e@example.com']);
  });

  it('allows an empty address path (RFC 6068 example mailto:?to=...)', () => {
    assert.deepEqual(parseMailto('mailto:?to=a@example.com&subject=x').to, ['a@example.com']);
    assert.deepEqual(parseMailto('mailto:').to, []);
  });

  it('decodes percent-encoded UTF-8 and encoded delimiters', () => {
    const parsed = parseMailto('mailto:%22not%40me%22@example.org?subject=%C3%A9t%C3%A9%20%E2%82%AC&body=a%26b%3Dc');
    assert.deepEqual(parsed.to, ['"not@me"@example.org']);
    assert.equal(parsed.subject, 'été €');
    assert.equal(parsed.body, 'a&b=c');
  });

  it('does not split on a comma inside a quoted display name', () => {
    const parsed = parseMailto('mailto:?to=%22Doe%2C%20John%22%20%3Cj@example.com%3E,k@example.com');
    assert.deepEqual(parsed.to, ['"Doe, John" <j@example.com>', 'k@example.com']);
  });

  it('keeps the first subject and body, and ignores other headers', () => {
    const parsed = parseMailto('mailto:a@example.com?subject=one&subject=two&body=first&body=second&in-reply-to=%3Cx@y%3E&x-evil=1');
    assert.equal(parsed.subject, 'one');
    assert.equal(parsed.body, 'first');
    assert.deepEqual(Object.keys(parsed).sort(), ['bcc', 'body', 'cc', 'subject', 'to']);
  });

  it('keeps a line break out of the subject and the addresses', () => {
    const parsed = parseMailto('mailto:a@example.com%0D%0ABcc:x@evil.example?subject=Hi%0D%0ABcc:%20x@evil.example');
    assert.equal(parsed.subject, 'Hi Bcc: x@evil.example');
    assert.ok(parsed.to.every(a => !/[\r\n]/.test(a)));
  });

  it('survives a malformed percent sequence', () => {
    assert.equal(parseMailto('mailto:a@example.com?subject=100%').subject, '100%');
  });

  it('drops a fragment', () => {
    assert.equal(parseMailto('mailto:a@example.com?subject=x#frag').subject, 'x');
  });

  it('rejects anything that is not a mailto: URL', () => {
    assert.equal(parseMailto('https://example.com/?to=a@example.com'), null);
    assert.equal(parseMailto('javascript:alert(1)'), null);
    assert.equal(parseMailto(null), null);
  });
});

describe('mailtoComposeData', () => {
  it('escapes the plain-text body for the HTML editor and keeps its line breaks', () => {
    const data = mailtoComposeData(parseMailto('mailto:a@example.com?body=%3Cb%3Ehi%3C/b%3E%20%26%0Anext'));
    assert.equal(data.body, '&lt;b&gt;hi&lt;/b&gt; &amp;<br>next');
  });
});

describe('the ?mailto= the protocol handler passes', () => {
  it('is decoded once, a "+" the browser left as is staying a plus', () => {
    const inner = 'mailto:a+b@example.com?subject=Hello%20World';
    assert.equal(mailtoFromSearch(`?mailto=${encodeURIComponent(inner)}`), inner);
    assert.equal(mailtoFromSearch('?mailto=mailto%3Aa+b%40example.com'), 'mailto:a+b@example.com');
    assert.equal(mailtoFromSearch('?x=1'), null);
  });

  it('is taken out of the address before the sign-in redirect, and opened once afterwards', () => {
    const storage = memoryStorage();
    const replaced = [];
    const history = { state: { k: 1 }, replaceState: (_s, _t, url) => replaced.push(url) };
    const location = { pathname: '/', search: `?a=1&mailto=${encodeURIComponent('mailto:a@example.com?subject=Hi')}`, hash: '' };
    stashMailtoFromLocation({ location, history, storage, now: 1000 });
    assert.deepEqual(replaced, ['/?a=1']);
    assert.deepEqual(takePendingMailto(storage, 2000), { to: ['a@example.com'], cc: [], bcc: [], subject: 'Hi', body: '' });
    assert.equal(takePendingMailto(storage, 3000), null, 'a reload does not open it again');
  });

  it('is dropped when the sign-in took too long', () => {
    const storage = memoryStorage();
    stashMailtoFromLocation({ location: { pathname: '/', search: '?mailto=mailto%3Aa%40example.com', hash: '' }, history: { replaceState() {} }, storage, now: 0 });
    assert.equal(takePendingMailto(storage, 11 * 60 * 1000), null);
  });

  it('leaves the address alone without a mailto', () => {
    const history = { replaceState: () => assert.fail('no replace') };
    stashMailtoFromLocation({ location: { pathname: '/', search: '?m=1', hash: '' }, history, storage: memoryStorage() });
  });
});
