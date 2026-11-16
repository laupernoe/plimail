// AI output sits in the app's own box, and the mail the model read can steer it, so a link in it
// is shown as text with the domain it really goes to, never as something to click.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// DOMPurify binds to the window it finds when it is first imported.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://mail.example.test/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
const { renderMarkdown } = await import('./renderMarkdown.js');

const parse = html => new dom.window.DOMParser().parseFromString(`<body>${html}</body>`, 'text/html').body;

describe('renderMarkdown', () => {
  it('turns a markdown link into its text and its real domain', () => {
    const out = parse(renderMarkdown('Verify your account [at your bank](https://bank.example.evil.io/login) now.'));
    assert.equal(out.querySelector('a'), null);
    assert.equal(out.textContent.trim(), 'Verify your account at your bank (bank.example.evil.io) now.');
  });

  it('turns raw HTML links into text as well', () => {
    const out = parse(renderMarkdown('<a href="https://evil.io/x">https://bank.example/</a>'));
    assert.equal(out.querySelector('a'), null);
    assert.equal(out.textContent.trim(), 'https://bank.example/ (evil.io)');
  });

  it('shows a bare address once', () => {
    const out = parse(renderMarkdown('See https://example.com/page and www.example.org and a@b.example'));
    assert.equal(out.querySelector('a'), null);
    assert.equal(out.textContent.trim(), 'See https://example.com/page and www.example.org and a@b.example');
  });

  it('shows the punycode of a look-alike domain', () => {
    const out = parse(renderMarkdown('[Bank](https://bаnk.example/)'));
    assert.equal(out.textContent.trim(), 'Bank (xn--bnk-6cd.example)');
  });

  it('drops a javascript: link to its text', () => {
    const out = parse(renderMarkdown('[click](javascript:alert(1))'));
    assert.equal(out.querySelector('a'), null);
    assert.equal(out.textContent.trim(), 'click');
  });

  it('keeps the rest of the formatting', () => {
    const out = parse(renderMarkdown('# Title\n\n- **bold** and *em*\n\n`code`\n\n| a | b |\n|---|---|\n| 1 | 2 |'));
    for (const tag of ['h1', 'li', 'strong', 'em', 'code', 'table', 'td']) assert.ok(out.querySelector(tag), tag);
  });

  it('removes images and scripts', () => {
    const out = parse(renderMarkdown('![x](https://evil.io/p.gif)<script>alert(1)</script><img src=x onerror=alert(1)>'));
    assert.equal(out.querySelector('img, script'), null);
  });
});
