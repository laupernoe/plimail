
// Whether a list row is the currently selected message. Matches across the multi-folder
// model, where one message's INBOX copy and its label-folder copy are distinct DB rows (each
// with its own id) that share an RFC message_id: so the label-folder row and the inbox row for
// the same email highlight together even though their ids differ. Prefers message_id when BOTH the row
// and the selection carry one — never matches two null/absent message_ids — and otherwise
// falls back to exact id equality, which is all a single-copy account (or a row/selection
// without a message_id) ever needs.
//
// That identity match is scoped to one account. The copies it is meant to light up together
// (an INBOX row and its label-folder row) always belong to the same account. Two accounts'
// copies of one email, which the list now renders as two separate rows (#476), share a
// Message-ID but are separate mail, so matching on the Message-ID alone would highlight both
// when the user clicked one. When either side's account is unknown the match stays as it was,
// rather than guessing. Pure and unit-testable.
export function isSelectedRow(row, selectedId, selectedMid, selectedAccountId) {
  if (!row) return false;
  if (selectedMid != null && row.message_id != null && row.message_id === selectedMid) {
    const differentAccount = selectedAccountId != null && row.account_id != null
      && row.account_id !== selectedAccountId;
    if (!differentAccount) return true;
  }
  return row.id != null && row.id === selectedId;
}

// A stable identity for a message list row: the RFC Message-ID when present, else the (volatile)
// DB row id. The row's UUID id is regenerated whenever a message is purged and re-inserted
// (folder move / resync / UID change), so deduplicating a list by id ALONE lets a reindexed
// message linger under its old id AND reappear under the new one — two rows with the same
// Message-ID, which the message-list renders as a visible duplicate (and isSelectedRow highlights
// together). Keying on the Message-ID collapses those; rows without one keep id identity so two
// distinct id-only rows never merge. Namespaced so a Message-ID can never collide with a UUID.
// Pure. Mirrors the identity rule in isSelectedRow / pickThreadMessage.
export function messageIdentity(m) {
  if (!m) return null;
  return m.message_id ? `mid:${m.message_id}` : `id:${m.id}`;
}

// Merge a freshly-fetched page of messages into an existing list, keyed by messageIdentity:
//  - an incoming row with the SAME DB id as an existing row is dropped (the existing copy may
//    carry optimistic local-only fields a network refresh lost, e.g. unread_count);
//  - an incoming row that shares a Message-ID with an existing row but carries a NEW id (the
//    message was purged+reinserted, regenerating its id) REPLACES that stale row in place, so a
//    reindexed message never shows as a duplicate and the surviving row is the fresh, clickable one;
//  - anything genuinely new is appended, de-duplicated within the incoming batch by identity.
// Returns the original array reference unchanged when nothing was added or replaced, so callers can
// skip a no-op state update. Pure.
export function appendMessagesByIdentity(existing, incoming) {
  const items = (incoming || []).filter(Boolean);
  if (items.length === 0) return existing;

  const existingIds = new Set(existing.map(m => m.id));
  // EVERY row index per Message-ID, not just the last one. Since #476 the list can hold one
  // row per account for a single Message-ID, and a single-index map pointed at whichever
  // landed last: a reindexed row from any other account then compared itself against the
  // wrong copy, concluded the two were independent deliveries, and appended instead of
  // replacing. That is the duplicate #378 exists to stop, and only the last account in the
  // list happened to behave.
  const idxByMid = new Map();
  existing.forEach((m, i) => {
    if (!m.message_id) return;
    const seen = idxByMid.get(m.message_id);
    if (seen) seen.push(i); else idxByMid.set(m.message_id, [i]);
  });

  let messages = existing;
  let mutated = false;
  const additions = [];
  // Scoped by delivery, not bare identity: two INBOX copies of one email in two different
  // accounts are separate mail (areIndependentDeliveries) and both must survive the batch.
  // Any other same-identity pair this lets through is collapsed by the dedupeByIdentity pass
  // on `additions` below, which applies exactly the same rule.
  const deliveryKey = m => (m?.folder === 'INBOX' && m?.account_id
    ? `${messageIdentity(m)}@${m.account_id}`
    : messageIdentity(m));
  const takenKeys = new Set(); // deliveries already consumed from the incoming batch

  for (const m of items) {
    if (existingIds.has(m.id)) continue;   // exact same row already present — keep existing
    const key = deliveryKey(m);
    if (takenKeys.has(key)) continue;      // a same-delivery incoming row was already handled
    takenKeys.add(key);
    if (m.message_id && idxByMid.has(m.message_id)) {
      const candidates = idxByMid.get(m.message_id);
      // The incoming row belongs to ONE delivery, so pick the held row representing that same
      // delivery. Most specific first, because a loose match that happens to sit earlier in
      // the list would absorb the replacement and leave the row it should have replaced in
      // place, which is how a duplicate appears:
      //   1. same account AND same folder: a reindexed row replacing itself;
      //   2. same account, other folder: the account's other copy of the message;
      //   3. account unknown on either side: no better information, old behavior.
      const pick = predicate => candidates.find(i => predicate(messages[i]));
      const sameAccountAs = held => held?.account_id && m.account_id && held.account_id === m.account_id;
      let at = pick(held => sameAccountAs(held) && held.folder === m.folder)
        ?? pick(sameAccountAs)
        ?? pick(held => !held?.account_id || !m.account_id);
      if (at === undefined) {
        // No copy from this account. If every row already here is an independent delivery,
        // this is simply another one and gets its own row.
        if (candidates.every(i => areIndependentDeliveries(messages[i], m))) {
          additions.push(m);
          continue;
        }
        // Otherwise rank against a copy that is NOT independent of it: the cross-account
        // Sent twin, which still collapses (#378).
        at = candidates.find(i => !areIndependentDeliveries(messages[i], m));
      }
      const held = messages[at];
      // Two different things share a Message-ID here, and they need opposite handling.
      //
      // SAME account: the row was purged and reinserted, regenerating its id. The held row is
      // stale and unclickable, so it must be replaced no matter how it compares.
      //
      // DIFFERENT accounts, both in INBOX: two independent deliveries of one email. Neither
      // replaces the other; the incoming copy becomes its own row (#476).
      //
      // DIFFERENT accounts otherwise (the cross-account Sent twin): still one message seen from
      // both ends, so it still collapses. Replacing unconditionally would let whichever merged
      // last win, which can swap an unread copy for its already-read twin and hide mail the user
      // has not seen. Rank instead, the way dedupeByIdentity does on full loads, so the paths agree.
      if (areIndependentDeliveries(held, m)) {
        additions.push(m);
        continue;
      }
      const sameAccount = !held?.account_id || !m.account_id || held.account_id === m.account_id;
      if (sameAccount || duplicateRank(m) < duplicateRank(held)) {
        if (!mutated) { messages = existing.slice(); mutated = true; }
        messages[at] = m;
      }
    } else {
      additions.push(m);                        // genuinely new
    }
  }

  if (!mutated && additions.length === 0) return existing;
  // Same rule applied within the new rows, so a batch carrying both an INBOX copy and its Sent
  // twin still contributes one row while two accounts' INBOX copies contribute two.
  const newRows = dedupeByIdentity(additions);
  return newRows.length ? [...messages, ...newRows] : messages;
}

// Collapse a message list so no two rows show the same DELIVERY twice. One email can exist as
// several DB rows in the places the list draws from: a received copy alongside its Sent twin, an
// INBOX copy alongside its label-folder copy, or two UIDs sharing a Message-ID in one folder.
// Those are all one piece of mail to the reader, and every raw list load (setMessages) would
// otherwise render each of them. This is the render-time guard the identity-aware merges
// (appendMessagesByIdentity) don't cover.
//
// Copies delivered to DIFFERENT accounts are not collapsed: see areIndependentDeliveries, which
// is where the rule and its reasoning live (#476).
// Order-preserving; on a collision the INBOX copy wins so the list shows the received message.
// Null-safe: rows without a Message-ID key on their (unique) id, so distinct ones never merge. Pure.
// Do these two rows represent two INDEPENDENT deliveries of one email, rather than two views
// of a single delivery? One email sent to two of your connected accounts arrives in each
// account's INBOX as its own mailbox item, with its own UID and its own \Seen flag. Reading it
// in one account does not read it in the other, so collapsing the pair forces the surviving row
// to misreport one of the two read states, and the unified unread badge (a plain sum of the
// per-account server counts) then disagrees with the list. Every client whose behavior could be
// checked against source shows both rows here (#476).
//
// Two views of ONE delivery stay collapsed, because there the second row adds no mail:
//   - a received copy and its Sent twin, which is you emailing yourself from one account to
//     another and seeing both ends of a single message (#378);
//   - two UIDs sharing a Message-ID inside one folder, which providers do emit.
// A row with no account_id has unknown provenance, so it collapses as before rather than
// being guessed independent.
export function areIndependentDeliveries(a, b) {
  if (!a || !b) return false;
  if (a.folder !== 'INBOX' || b.folder !== 'INBOX') return false;
  if (!a.account_id || !b.account_id) return false;
  return a.account_id !== b.account_id;
}

// Which copy of a duplicated message should represent it in the list. Lower wins.
//
// INBOX beats every other folder, as it always has. Within a folder class an UNREAD copy beats
// a read one: copies of one message that DO still collapse (a Sent twin, a label-folder copy)
// can carry different \Seen flags, and the order they reach us is arbitrary. Keeping whichever
// landed first could discard the unread copy and render the message as already read, hiding
// genuinely unread mail from the default list while it still showed under the unread filter
// (which excludes the read copy server-side). Copies in two different accounts no longer reach
// this tie-break at all, because both of them now render (see areIndependentDeliveries).
export function duplicateRank(m) {
  const folderRank = m?.folder === 'INBOX' ? 0 : 2;
  return folderRank + (m?.is_read ? 0 : -1);
}

export function dedupeByIdentity(list) {
  const idxByKey = new Map(); // identity -> index in result
  const result = [];
  for (const m of list || []) {
    if (!m) continue;
    const key = messageIdentity(m);
    if (!idxByKey.has(key)) {
      idxByKey.set(key, result.length);
      result.push(m);
    } else {
      const i = idxByKey.get(key);
      // Independent deliveries are separate mail and both stay. idxByKey keeps pointing at the
      // first copy, so a later Sent twin still ranks against a real INBOX row rather than
      // against whichever copy happened to be appended last.
      if (areIndependentDeliveries(result[i], m)) {
        result.push(m);
        continue;
      }
      // Strict improvement only, so an exact tie keeps the earlier row and order stays stable.
      if (duplicateRank(m) < duplicateRank(result[i])) result[i] = m;
    }
  }
  return result;
}

// Filter `incoming` to the messages whose stable identity is not already present in `existing`.
// Used by restore/undo so a message the network refresh already brought back — possibly under a
// regenerated id, matched via Message-ID — is not re-added as a duplicate. Pure.
//
// Presence is judged per account. Since #476 the list can hold one row per account for a single
// Message-ID, and a bare Message-ID key made Undo a no-op: archive one account's copy, press
// Undo, and the other account's copy answered "already present". A row with no account keys on
// the Message-ID alone, as before.
export function missingByIdentity(existing, incoming) {
  const key = m => `${messageIdentity(m)}\u0000${m.account_id ?? ''}`;
  const present = new Set(existing.map(key));
  return (incoming || []).filter(m => m && !present.has(key(m)));
}
