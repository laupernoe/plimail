// Calendars grouped under the account they belong to, in the accounts' order. An account with no
// calendar yet is left out, and so is a calendar whose account is not in the list.
export function groupCalendarsByAccount(accounts, calendars) {
  const groups = [];
  for (const account of accounts || []) {
    const own = (calendars || []).filter(c => c.accountId === account.id);
    if (own.length) groups.push({ account, calendars: own });
  }
  return groups;
}
