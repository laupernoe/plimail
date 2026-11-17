// A mail account's stored password goes, without the user typing it, only to that account's own
// IMAP or SMTP host. Otherwise a session alone, without the password, could have it sent to any
// server and read it there. Calendar (CalDAV) and server filters (ManageSieve) both rely on this.

const norm = h => String(h ?? '').trim().toLowerCase().replace(/\.+$/, '');

export function isAccountMailHost(account, host) {
  const target = norm(host);
  if (!target || !account) return false;
  return [account.imap_host, account.smtp_host].some(h => typeof h === 'string' && norm(h) === target);
}
