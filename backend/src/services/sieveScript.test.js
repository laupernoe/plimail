import { describe, expect, it } from 'vitest';
import { buildPlimailScript, readPlimailMeta, sieveQuote, validateRules } from './sieveScript.js';

const ALL = ['fileinto', 'imap4flags'];

describe('validateRules', () => {
  it('keeps the fields each action needs and trims the text', () => {
    expect(validateRules([
      { field: 'from', contains: '  boss@example.test ', action: 'markRead', folder: 'ignored' },
      { field: 'subject', contains: 'invoice', action: 'move', folder: 'Invoices' },
      { field: 'recipient', contains: 'list@', action: 'redirect', address: 'me@example.test' },
    ])).toEqual({ rules: [
      { field: 'from', contains: 'boss@example.test', action: 'markRead' },
      { field: 'subject', contains: 'invoice', action: 'move', folder: 'Invoices' },
      { field: 'recipient', contains: 'list@', action: 'redirect', address: 'me@example.test' },
    ] });
  });

  it('refuses an empty text, which would match every message', () => {
    expect(validateRules([{ field: 'from', contains: '   ', action: 'delete' }])).toMatchObject({ index: 0 });
  });

  it('refuses unknown fields and actions, a missing folder, a bad address and control characters', () => {
    expect(validateRules([{ field: 'body', contains: 'x', action: 'move', folder: 'A' }]).error).toBeTruthy();
    expect(validateRules([{ field: 'from', contains: 'x', action: 'reject' }]).error).toBeTruthy();
    expect(validateRules([{ field: 'from', contains: 'x', action: 'move' }]).error).toBeTruthy();
    expect(validateRules([{ field: 'from', contains: 'x', action: 'redirect', address: 'not an address' }]).error).toBeTruthy();
    expect(validateRules([{ field: 'from', contains: 'a\nb', action: 'markRead' }]).error).toBeTruthy();
  });
});

describe('buildPlimailScript', () => {
  it('requires only the extensions the rules use and writes one block per rule, in order', () => {
    const { rules } = validateRules([
      { field: 'from', contains: 'news@', action: 'markRead' },
      { field: 'subject', contains: 'Invoice "Q3"', action: 'move', folder: 'Billing/2026' },
      { field: 'recipient', contains: 'old@example.test', action: 'redirect', address: 'new@example.test' },
    ]);
    const script = buildPlimailScript({ rules }, { extensions: ALL });
    expect(script).toContain('require ["fileinto", "imap4flags"];');
    expect(script).toContain('if header :contains "from" "news@" {\r\n  addflag "\\\\Seen";\r\n}');
    expect(script).toContain('if header :contains "subject" "Invoice \\"Q3\\"" {\r\n  fileinto "Billing/2026";\r\n  stop;\r\n}');
    expect(script).toContain('if header :contains ["to", "cc"] "old@example.test" {\r\n  redirect "new@example.test";\r\n  stop;\r\n}');
    expect(script.indexOf('news@')).toBeLessThan(script.indexOf('Invoice'));
    expect(script.split('\r\n').every(line => !line.includes('\n'))).toBe(true);
  });

  it('files deleted mail into Trash instead of discarding it', () => {
    const { rules } = validateRules([{ field: 'from', contains: 'spam@', action: 'delete' }]);
    const script = buildPlimailScript({ rules }, { extensions: ALL, trashFolder: 'Trash' });
    expect(script).toContain('fileinto "Trash";');
    expect(script).not.toMatch(/\bdiscard\b/);
    expect(() => buildPlimailScript({ rules }, { extensions: ALL })).toThrow(expect.objectContaining({ code: 'no_trash' }));
  });

  it('refuses a rule the server cannot run', () => {
    const { rules } = validateRules([{ field: 'from', contains: 'x', action: 'markRead' }]);
    expect(() => buildPlimailScript({ rules }, { extensions: ['fileinto'] }))
      .toThrow(expect.objectContaining({ code: 'extension_missing', missing: ['imap4flags'] }));
  });

  it('carries its rules so they read back, and a hand-written script reads as none', () => {
    const { rules } = validateRules([{ field: 'subject', contains: 'été', action: 'move', folder: 'Été' }]);
    expect(readPlimailMeta(buildPlimailScript({ rules }, { extensions: ALL }))).toEqual({ rules });
    expect(readPlimailMeta('require "fileinto";\r\nfileinto "A";\r\n')).toBeNull();
    expect(readPlimailMeta('# plimail-meta: not-base64-json\r\n')).toBeNull();
  });

  it('quotes backslashes and double quotes', () => {
    expect(sieveQuote('a\\b"c')).toBe('"a\\\\b\\"c"');
  });
});
