import { query } from './db.js';

// The account's own addresses (login address + aliases) as raw strings. The caller normalizes.
export async function getAccountAddresses(accountId) {
  const { rows } = await query(
    `SELECT email_address AS addr FROM email_accounts WHERE id = $1
     UNION ALL
     SELECT email AS addr FROM account_aliases WHERE account_id = $1`,
    [accountId]
  );
  return rows.map((r) => r.addr);
}
