import { describe, expect, it } from 'vitest';
import {
  analyzeLinks,
  baseDomain,
  buildScamAnalysis,
  classifyAttachment,
  parseAuthenticationResults,
  parseHtmlBody,
  shownDomain,
  truncateText,
} from './mailSafetyInput.js';

const base = {
  from_name: 'PayPal Service',
  from_email: 'service@paypal-secure.io',
  subject: 'Your account is limited',
  body_text: null,
  body_html: null,
  attachments: [],
  reply_to: [],
};

describe('links', () => {
  it('flags a link whose visible text names another domain', () => {
    const { links } = parseHtmlBody('<p>Log in at <a href="https://login.evil.io/x">https://www.paypal.com/signin</a></p>'
      + '<a href="https://www.paypal.com/help">paypal.com</a><a href="https://news.example.org/a">Read more</a>');
    const { mismatches, links: listed } = analyzeLinks(links);
    expect(mismatches).toEqual([{ shown: 'paypal.com', actual: 'login.evil.io' }]);
    expect(listed.map(l => l.mismatch)).toEqual([true, false, false]);
  });

  it('treats subdomains of the same site as a match and ignores non-http links', () => {
    expect(baseDomain('mail.google.com')).toBe('google.com');
    expect(baseDomain('shop.example.co.uk')).toBe('example.co.uk');
    expect(shownDomain('Click here')).toBeNull();
    const { mismatches, links } = analyzeLinks([
      { href: 'https://accounts.google.com/x', text: 'www.google.com' },
      { href: 'mailto:a@b.c', text: 'evil.io' },
    ]);
    expect(mismatches).toEqual([]);
    expect(links).toHaveLength(1);
  });
});

describe('attachments', () => {
  it.each([
    ['invoice.pdf.exe', 'double_extension'],
    ['Invoice.PDF.exe. ', 'double_extension'],
    ['setup.exe', 'executable_attachment'],
    ['report.xlsm', 'macro_attachment'],
    ['login.html', 'active_attachment'],
    ['files.zip', 'archive_attachment'],
    ['photo.jpg', null],
  ])('%s → %s', (name, type) => {
    const { flags } = buildScamAnalysis({ ...base, attachments: [{ filename: name, type: 'application/octet-stream', size: 10 }] });
    expect(flags.find(f => f.name)?.type ?? null).toBe(type);
  });

  it('reads the extension, not the declared type', () => {
    expect(classifyAttachment('scan.pdf.scr', 'application/pdf')).toMatchObject({ level: 'block', doubleExtension: true });
  });

  it('sends metadata only, never attachment content', () => {
    const { input } = buildScamAnalysis({
      ...base,
      body_text: 'See attached.',
      attachments: [{ filename: 'a.txt', type: 'text/plain', size: 5, content: 'SECRET-BYTES', data: Buffer.from('SECRET-BYTES') }],
    });
    expect(input).toContain('a.txt | declared type: text/plain | size: 5 bytes');
    expect(input).not.toContain('SECRET-BYTES');
  });

  it('leaves out images shown inside the body', () => {
    const { input } = buildScamAnalysis({ ...base, attachments: [{ filename: 'logo.png', type: 'image/png', disposition: 'inline' }] });
    expect(input).not.toContain('logo.png');
  });
});

describe('body', () => {
  it('truncates a long body and says how much was kept', () => {
    const long = 'word '.repeat(10_000);
    const { input, truncated } = buildScamAnalysis({ ...base, body_text: long }, '', { bodyLimit: 1000 });
    expect(truncated.total).toBe(long.trim().length);
    expect(truncated.shown).toBeLessThanOrEqual(1000);
    expect(input).toContain(`first ${truncated.shown} of ${truncated.total} characters`);
    expect(input.length).toBeLessThan(2000);
  });

  it('cuts at a word boundary within the limit', () => {
    const { text, truncated } = truncateText('aaaa bbbb cccc dddd', 12);
    expect(text).toBe('aaaa bbbb');
    expect(truncated).toEqual({ shown: 9, total: 19 });
  });

  it('uses the visible HTML text when there is no text part, without scripts or styles', () => {
    const { input } = buildScamAnalysis({ ...base, body_html: '<style>p{}</style><script>alert(1)</script><p>Hello&nbsp;there</p>' });
    expect(input).toContain('Hello there');
    expect(input).not.toContain('alert(1)');
  });
});

describe('headers', () => {
  const raw = [
    'From: "PayPal Service" <service@paypal-secure.io>',
    'Reply-To: refunds@other-domain.net',
    'Return-Path: <bounce@mailer.example>',
    'Authentication-Results: mx.local; spf=pass smtp.mailfrom=paypal-secure.io; dkim=none; dmarc=fail header.from=paypal-secure.io',
    'Authentication-Results: forged; dmarc=pass',
  ].join('\r\n');

  it('reads the top Authentication-Results only and flags a DMARC failure', () => {
    expect(parseAuthenticationResults('a; dmarc=fail\nforged; dmarc=pass')).toMatchObject({ dmarc: 'fail' });
    const { flags, input } = buildScamAnalysis(base, raw);
    expect(flags).toContainEqual({ type: 'auth_fail', mechanism: 'dmarc', result: 'fail' });
    expect(input).toContain('dmarc=fail');
    expect(input).not.toContain('forged');
  });

  it('lists Reply-To and Return-Path when they differ, and flags a foreign Reply-To', () => {
    const { flags, input } = buildScamAnalysis(base, raw);
    expect(input).toContain('Reply-To: refunds@other-domain.net');
    expect(input).toContain('Return-Path: bounce@mailer.example');
    expect(flags).toContainEqual({ type: 'reply_to_differs', address: 'refunds@other-domain.net' });
  });

  it('flags a display name that is someone else\'s address', () => {
    const { flags } = buildScamAnalysis({ ...base, from_name: 'service@paypal.com' });
    expect(flags).toContainEqual({ type: 'display_name_address', shown: 'service@paypal.com', actual: 'service@paypal-secure.io' });
  });
});
