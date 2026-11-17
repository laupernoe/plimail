import { describe, expect, it } from 'vitest';
import { buildPlimailScript, readPlimailMeta, sieveQuote, validateRules, validateVacation } from './sieveScript.js';

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
    expect(readPlimailMeta(buildPlimailScript({ rules }, { extensions: ALL }))).toEqual({ rules, vacation: null });
    expect(readPlimailMeta('require "fileinto";\r\nfileinto "A";\r\n')).toBeNull();
    expect(readPlimailMeta('# plimail-meta: not-base64-json\r\n')).toBeNull();
  });

  it('quotes backslashes and double quotes', () => {
    expect(sieveQuote('a\\b"c')).toBe('"a\\\\b\\"c"');
  });
});

describe('validateVacation', () => {
  const base = { enabled: true, subject: ' Away ', body: 'Back on Monday.\r\nRegards', days: 3, addresses: ['me@example.test', 'me@example.test'] };

  it('trims, normalizes line breaks, defaults the interval and drops duplicate addresses', () => {
    expect(validateVacation(base)).toEqual({ vacation: {
      enabled: true, subject: 'Away', body: 'Back on Monday.\nRegards', start: null, end: null, days: 3, addresses: ['me@example.test'],
    } });
    expect(validateVacation({ enabled: true, body: 'x' }).vacation.days).toBe(7);
  });

  it('keeps the text of a reply that is off, even without a message', () => {
    expect(validateVacation({ enabled: false, body: '' }).vacation).toMatchObject({ enabled: false, body: '' });
    expect(validateVacation({ enabled: true, body: '  ' }).error).toBeTruthy();
  });

  it('refuses impossible dates, an end before the start, an interval out of range and bad addresses', () => {
    expect(validateVacation({ ...base, start: '2026-02-30' }).error).toBeTruthy();
    expect(validateVacation({ ...base, start: '20261201' }).error).toBeTruthy();
    expect(validateVacation({ ...base, start: '2026-12-10', end: '2026-12-01' }).error).toBeTruthy();
    expect(validateVacation({ ...base, days: 0 }).error).toBeTruthy();
    expect(validateVacation({ ...base, days: 31 }).error).toBeTruthy();
    expect(validateVacation({ ...base, days: 2.5 }).error).toBeTruthy();
    expect(validateVacation({ ...base, addresses: ['nope'] }).error).toBeTruthy();
    expect(validateVacation({ ...base, subject: 'a\nb' }).error).toBeTruthy();
    expect(validateVacation({ ...base, body: 'a\u0000b' }).error).toBeTruthy();
  });
});

describe('buildPlimailScript with an out-of-office reply', () => {
  const EXT = [...ALL, 'vacation', 'date', 'relational'];
  const reply = extra => validateVacation({ enabled: true, subject: 'Out "now"', body: 'Away.\nBack soon', days: 5, ...extra }).vacation;

  it('replies before the rules run, so mail a rule files away is still answered', () => {
    const { rules } = validateRules([{ field: 'subject', contains: 'invoice', action: 'move', folder: 'Invoices' }]);
    const script = buildPlimailScript({ rules, vacation: reply({ addresses: ['alias@example.test'] }) }, { extensions: EXT });
    expect(script).toContain('require ["fileinto", "vacation"];');
    expect(script).toContain('vacation :days 5 :subject "Out \\"now\\"" :addresses ["alias@example.test"] "Away.\r\nBack soon";');
    expect(script.indexOf('vacation :days')).toBeLessThan(script.indexOf('fileinto "Invoices"'));
    expect(script).not.toContain('currentdate');
  });

  it('limits the reply to its dates', () => {
    const both = buildPlimailScript({ vacation: reply({ start: '2026-12-20', end: '2027-01-04' }) }, { extensions: EXT });
    expect(both).toContain('require ["date", "relational", "vacation"];');
    expect(both).toContain('if allof (currentdate :value "ge" "date" "2026-12-20", currentdate :value "le" "date" "2027-01-04") {\r\n  vacation ');
    const until = buildPlimailScript({ vacation: reply({ end: '2027-01-04' }) }, { extensions: EXT });
    expect(until).toContain('if currentdate :value "le" "date" "2027-01-04" {');
  });

  it('writes no reply while it is off, but keeps it to show again', () => {
    const vacation = validateVacation({ enabled: false, body: 'Away', start: '2026-12-20' }).vacation;
    const script = buildPlimailScript({ rules: [], vacation }, { extensions: [] });
    expect(script).not.toMatch(/^vacation|require/m);
    expect(readPlimailMeta(script)).toEqual({ rules: [], vacation });
  });

  it('reads back the reply it wrote', () => {
    const vacation = reply({ start: '2026-12-20' });
    expect(readPlimailMeta(buildPlimailScript({ vacation }, { extensions: EXT }))).toEqual({ rules: [], vacation });
  });

  it('refuses a reply the server cannot send, or cannot date', () => {
    expect(() => buildPlimailScript({ vacation: reply() }, { extensions: ALL }))
      .toThrow(expect.objectContaining({ code: 'extension_missing', missing: ['vacation'] }));
    expect(() => buildPlimailScript({ vacation: reply({ start: '2026-12-20' }) }, { extensions: [...ALL, 'vacation'] }))
      .toThrow(expect.objectContaining({ code: 'extension_missing', missing: ['date', 'relational'] }));
  });
});
