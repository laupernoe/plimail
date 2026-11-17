// ManageSieve for a mail account: the server is the account's IMAP host on port 4190, and the
// login is the account's IMAP login, decrypted here and sent only to that host (the rule in
// mailPasswordHosts.js). Sessions for one account run one at a time, so two saves cannot
// interleave their read and write of the script.

import { decrypt } from './encryption.js';
import { getConnectionPolicy } from './connectionPolicy.js';
import { resolveForConnection } from './hostValidation.js';
import { isAccountMailHost } from './mailPasswordHosts.js';
import { MANAGESIEVE_PORT, SieveError, withManageSieve } from './manageSieve.js';

// The columns withAccountSieve reads.
export const SIEVE_ACCOUNT_COLUMNS = 'id, user_id, email_address, imap_host, smtp_host, auth_user, auth_pass, oauth_provider, imap_skip_tls_verify, folder_mappings';

// A refused login is not retried for a while: the stored password is what IMAP uses too, and
// sending a wrong one again and again is what gets an address blocked by the server's fail2ban.
const AUTH_BACKOFF_MS = 10 * 60 * 1000;
const authFailures = new Map();
const queues = new Map();

export function forgetSieveAuthFailure(accountId) {
  authFailures.delete(accountId);
}

function serialize(accountId, fn) {
  const previous = queues.get(accountId) || Promise.resolve();
  const run = previous.catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  queues.set(accountId, tail);
  tail.then(() => { if (queues.get(accountId) === tail) queues.delete(accountId); });
  return run;
}

export async function withAccountSieve(account, fn, { port = MANAGESIEVE_PORT, open, tlsOptions = {} } = {}) {
  if (account.oauth_provider) throw new SieveError('oauth_unsupported', 'Server filters need an account that signs in with a password');
  if (!account.auth_pass) throw new SieveError('no_password', 'This account has no stored password');
  const host = account.imap_host;
  if (!host || !isAccountMailHost(account, host)) throw new SieveError('host_refused', "The account's password is only sent to its own servers");

  return serialize(account.id, async () => {
    const failed = authFailures.get(account.id);
    if (failed && failed.pass === account.auth_pass && Date.now() - failed.at < AUTH_BACKOFF_MS) {
      throw new SieveError('auth_failed', 'The server refused the login a moment ago; not trying again yet');
    }
    const password = decrypt(account.auth_pass);
    if (!password) throw new SieveError('no_password', 'The stored password could not be read');
    const policy = await getConnectionPolicy();
    let resolved;
    try {
      resolved = await resolveForConnection(host, { allowPrivate: policy.allowPrivateHosts });
    } catch (err) {
      throw new SieveError('host_refused', err.message, { cause: err });
    }
    const pinned = resolved.lookup && resolved.servername;
    const options = {
      host: pinned ? resolved.servername : resolved.host,
      lookup: pinned ? resolved.lookup : null,
      servername: resolved.servername || host,
      port,
      username: account.auth_user || account.email_address,
      password,
      tlsOptions: { rejectUnauthorized: !(policy.allowInsecureTls && account.imap_skip_tls_verify), ...tlsOptions },
    };
    try {
      return await withManageSieve(options, fn, open ? { open } : undefined);
    } catch (err) {
      if (err instanceof SieveError && err.code === 'auth_failed') {
        authFailures.set(account.id, { pass: account.auth_pass, at: Date.now() });
      }
      throw err;
    }
  });
}
