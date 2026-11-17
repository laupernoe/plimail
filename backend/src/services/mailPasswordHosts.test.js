import { describe, expect, it } from 'vitest';
import { isAccountMailHost } from './mailPasswordHosts.js';

describe('isAccountMailHost', () => {
  const account = { imap_host: 'imap.example.test', smtp_host: 'SMTP.example.test' };

  it("accepts the account's own IMAP and SMTP hosts, whatever their case or trailing dot", () => {
    expect(isAccountMailHost(account, 'imap.example.test')).toBe(true);
    expect(isAccountMailHost(account, 'IMAP.Example.Test.')).toBe(true);
    expect(isAccountMailHost(account, 'smtp.example.test')).toBe(true);
  });

  it('refuses any other host, a lookalike included', () => {
    expect(isAccountMailHost(account, 'imap.example.test.evil.test')).toBe(false);
    expect(isAccountMailHost(account, 'example.test')).toBe(false);
    expect(isAccountMailHost(account, '')).toBe(false);
    expect(isAccountMailHost({ imap_host: null, smtp_host: null }, '')).toBe(false);
  });
});
