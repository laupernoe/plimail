import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isSelectedRow,
  messageIdentity,
  appendMessagesByIdentity,
  dedupeByIdentity,
  missingByIdentity,
} from './messageIdentity.js';

describe('isSelectedRow: account scoping (#476)', () => {
  const sel = { id: 'work-row', message_id: '<m1>', account_id: 'work' };

  it('does not highlight the other account copy of the same email', () => {
    // Both copies are rendered as separate rows now, so a Message-ID-only match would light up
    // both when the user clicked one.
    const other = { id: 'home-row', message_id: '<m1>', account_id: 'home' };
    assert.equal(isSelectedRow(other, sel.id, sel.message_id, sel.account_id), false);
  });

  it('still highlights the clicked row itself', () => {
    assert.equal(isSelectedRow(sel, sel.id, sel.message_id, sel.account_id), true);
  });

  it('still highlights a same-account copy in another folder, which is the point of the mid match', () => {
    // The label-folder copy: different DB id, same message, same account.
    const labelCopy = { id: 'label-row', message_id: '<m1>', account_id: 'work' };
    assert.equal(isSelectedRow(labelCopy, sel.id, sel.message_id, sel.account_id), true);
  });

  it('still matches by id when the row is the selected one but its account is not loaded', () => {
    const noAcct = { id: 'work-row', message_id: '<m1>' };
    assert.equal(isSelectedRow(noAcct, sel.id, sel.message_id, sel.account_id), true);
  });

  it('keeps the old identity match when either side has no account', () => {
    const row = { id: 'other', message_id: '<m1>' };
    assert.equal(isSelectedRow(row, 'work-row', '<m1>', null), true, 'selection account unknown');
    assert.equal(isSelectedRow(row, 'work-row', '<m1>', 'work'), true, 'row account unknown');
  });
});

describe('isSelectedRow', () => {
  it('matches a different DB copy of the selected message by shared message_id', () => {
    // Label-folder copy and inbox row (INBOX copy) are distinct ids, same RFC id.
    const labelRow = { id: 'label-7', message_id: '<m1>' };
    const inboxRow = { id: 'inbox-3', message_id: '<m1>' };
    // Selection is the label copy (selectedId = label-7, selectedMid = <m1>).
    assert.equal(isSelectedRow(labelRow, 'label-7', '<m1>'), true);   // exact id
    assert.equal(isSelectedRow(inboxRow, 'label-7', '<m1>'), true);  // identity across copies
  });

  it('never matches two null/absent message_ids — falls back to id equality', () => {
    // A row with no message_id and a selection with no message_id must not collapse together.
    assert.equal(isSelectedRow({ id: 'a' }, 'b', null), false);
    assert.equal(isSelectedRow({ id: 'a', message_id: null }, 'b', null), false);
    assert.equal(isSelectedRow({ id: 'b' }, 'b', null), true); // id fallback still works
  });

  it('does not match rows with a different message_id and a different id', () => {
    assert.equal(isSelectedRow({ id: 'x', message_id: '<other>' }, 'y', '<m1>'), false);
  });

  it('returns false for a missing row or when nothing is selected', () => {
    assert.equal(isSelectedRow(null, 'a', '<m1>'), false);
    assert.equal(isSelectedRow(undefined, 'a', '<m1>'), false);
    assert.equal(isSelectedRow({ id: 'a', message_id: '<m1>' }, null, null), false);
  });
});

describe('messageIdentity', () => {
  it('keys on the Message-ID when present', () => {
    assert.equal(messageIdentity({ id: 'uuid-1', message_id: '<m1>' }), 'mid:<m1>');
    // Same Message-ID under a regenerated id yields the SAME identity.
    assert.equal(
      messageIdentity({ id: 'uuid-2', message_id: '<m1>' }),
      messageIdentity({ id: 'uuid-1', message_id: '<m1>' })
    );
  });

  it('falls back to the row id when Message-ID is absent, and never collapses distinct ids', () => {
    assert.equal(messageIdentity({ id: 'uuid-1', message_id: null }), 'id:uuid-1');
    assert.equal(messageIdentity({ id: 'uuid-1', message_id: '' }), 'id:uuid-1');
    assert.notEqual(
      messageIdentity({ id: 'uuid-1' }),
      messageIdentity({ id: 'uuid-2' })
    );
  });

  it('returns null for a missing row', () => {
    assert.equal(messageIdentity(null), null);
    assert.equal(messageIdentity(undefined), null);
  });
});

describe('appendMessagesByIdentity', () => {
  it('adds the other account copy as its own row instead of replacing the held one (#476)', () => {
    // Originally this asserted that the read twin must not EVICT the unread copy, because a
    // merge that replaced unconditionally could hide mail the user had not seen. Keeping both
    // rows removes the eviction entirely: there is no survivor to choose, so neither copy's
    // read state can stand in for the other's.
    const existing = [{ id: 'unread', message_id: '<m1>', folder: 'INBOX', account_id: 'a', is_read: false }];
    const incoming = [{ id: 'read',   message_id: '<m1>', folder: 'INBOX', account_id: 'b', is_read: true }];
    const result = appendMessagesByIdentity(existing, incoming);
    assert.equal(result.length, 2);
    assert.deepEqual(result.map(m => m.id), ['unread', 'read']);
    // The held row is untouched, so the unread copy stays unread and stays visible.
    assert.equal(result[0].is_read, false);
  });

  it('keeps both in the other merge order too, so neither copy depends on arrival order', () => {
    const existing = [{ id: 'read',   message_id: '<m1>', folder: 'INBOX', account_id: 'a', is_read: true }];
    const incoming = [{ id: 'unread', message_id: '<m1>', folder: 'INBOX', account_id: 'b', is_read: false }];
    const result = appendMessagesByIdentity(existing, incoming);
    assert.equal(result.length, 2);
    assert.deepEqual(result.map(m => m.id), ['read', 'unread']);
  });

  it('contributes one row when a batch carries a copy and its Sent twin', () => {
    // The delivery-scoped batch key must not let a single delivery through twice.
    const result = appendMessagesByIdentity([], [
      { id: 'recv', message_id: '<m1>', folder: 'INBOX', account_id: 'a' },
      { id: 'sent', message_id: '<m1>', folder: 'Sent', account_id: 'a' },
    ]);
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'recv');
  });

  it('contributes two rows when a batch carries two accounts INBOX copies', () => {
    const result = appendMessagesByIdentity([], [
      { id: 'a', message_id: '<m1>', folder: 'INBOX', account_id: 'work' },
      { id: 'b', message_id: '<m1>', folder: 'INBOX', account_id: 'home' },
    ]);
    assert.equal(result.length, 2);
  });

  it('still replaces a reindexed row in the SAME account even when read state is unchanged', () => {
    // Must not regress the original #378 fix: the held row is stale and unclickable, so it has
    // to be replaced regardless of how the two compare.
    const existing = [{ id: 'old', message_id: '<m1>', folder: 'INBOX', account_id: 'a', is_read: true }];
    const incoming = [{ id: 'new', message_id: '<m1>', folder: 'INBOX', account_id: 'a', is_read: true }];
    const result = appendMessagesByIdentity(existing, incoming);
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'new');
  });

  it('replaces a same-account reindexed row even when the incoming copy is now read', () => {
    const existing = [{ id: 'old', message_id: '<m1>', folder: 'INBOX', account_id: 'a', is_read: false }];
    const incoming = [{ id: 'new', message_id: '<m1>', folder: 'INBOX', account_id: 'a', is_read: true }];
    assert.equal(appendMessagesByIdentity(existing, incoming)[0].id, 'new');
  });

  it('replaces a same-account reindexed row while the OTHER account copy is on screen', () => {
    // Regression found in review. The merge index mapped Message-ID to a single row, so once
    // #476 let two accounts' copies coexist, it pointed at whichever landed last. A reindexed
    // row from the FIRST account then compared itself against the second account's copy,
    // decided the two were independent deliveries, and appended instead of replacing. That
    // put two rows for one account back on screen, which is the duplicate #378 exists to stop.
    // Reachable on the default All Inboxes view through pagination and live merges.
    const existing = [
      { id: 'work-old', message_id: '<m1>', folder: 'INBOX', account_id: 'work' },
      { id: 'home',     message_id: '<m1>', folder: 'INBOX', account_id: 'home' },
    ];
    const result = appendMessagesByIdentity(existing, [
      { id: 'work-new', message_id: '<m1>', folder: 'INBOX', account_id: 'work' },
    ]);
    assert.equal(result.length, 2, 'still one row per account');
    assert.deepEqual(result.map(m => m.id), ['work-new', 'home'], 'the stale work row is replaced in place');
  });

  it('replaces the reindexed row whichever account copy came first', () => {
    // The old index kept the LAST match, so the last account happened to work and every
    // earlier one did not. Both orders have to behave the same.
    const existing = [
      { id: 'home',     message_id: '<m1>', folder: 'INBOX', account_id: 'home' },
      { id: 'work-old', message_id: '<m1>', folder: 'INBOX', account_id: 'work' },
    ];
    const result = appendMessagesByIdentity(existing, [
      { id: 'work-new', message_id: '<m1>', folder: 'INBOX', account_id: 'work' },
    ]);
    assert.equal(result.length, 2);
    assert.deepEqual(result.map(m => m.id), ['home', 'work-new']);
  });

  it('adds a third account copy without disturbing the other two', () => {
    const existing = [
      { id: 'work', message_id: '<m1>', folder: 'INBOX', account_id: 'work' },
      { id: 'home', message_id: '<m1>', folder: 'INBOX', account_id: 'home' },
    ];
    const result = appendMessagesByIdentity(existing, [
      { id: 'third', message_id: '<m1>', folder: 'INBOX', account_id: 'third' },
    ]);
    assert.deepEqual(result.map(m => m.id), ['work', 'home', 'third']);
  });

  it('resolves an incoming Sent twin against its OWN account copy, not whichever is last', () => {
    // The Sent copy belongs to `work`, so it must be matched against work's row rather than
    // waved through as an independent delivery because home's copy happened to be indexed.
    // Landing on work's row means the same-account rule applies and it replaces in place,
    // which is what this does with a single account on main and is unchanged by #476. The
    // point here is the row COUNT: the Sent twin must never add a row.
    const existing = [
      { id: 'work', message_id: '<m1>', folder: 'INBOX', account_id: 'work' },
      { id: 'home', message_id: '<m1>', folder: 'INBOX', account_id: 'home' },
    ];
    const result = appendMessagesByIdentity(existing, [
      { id: 'work-sent', message_id: '<m1>', folder: 'Sent', account_id: 'work' },
    ]);
    assert.equal(result.length, 2, 'the Sent twin adds no row');
    assert.deepEqual(result.map(m => m.account_id), ['work', 'home'], 'still one row per account');
  });

  it('keeps a new account delivery when a cross-account Sent twin is indexed ahead of it', () => {
    // Three accounts on one Message-ID: another account's INBOX copy, home's Sent copy, and
    // an arriving INBOX delivery for `work`. Because the Sent copy is not an independent
    // delivery, this does not take the straight append path, so it has to rank against the
    // copy it is NOT independent of. Ranking against an arbitrary copy instead loses the
    // work delivery entirely: it ties with the other INBOX row, fails the strict-improvement
    // check, and is silently dropped.
    const existing = [
      { id: 'other', message_id: '<m1>', folder: 'INBOX', account_id: 'other' },
      { id: 'home-sent', message_id: '<m1>', folder: 'Sent', account_id: 'home' },
    ];
    const result = appendMessagesByIdentity(existing, [
      { id: 'work', message_id: '<m1>', folder: 'INBOX', account_id: 'work' },
    ]);
    assert.ok(result.some(m => m.id === 'work'), 'the arriving delivery must not be dropped');
    assert.ok(!result.some(m => m.id === 'home-sent'), 'the Sent twin still collapses');
  });

  it('replaces the SAME-FOLDER copy when one account holds two folder copies', () => {
    // Found reviewing the index fix. Choosing the first loosely-matching row meant a
    // reindexed INBOX row could land on the account's All Mail copy, replace that, and leave
    // the stale INBOX row behind: two INBOX rows for one account.
    const existing = [
      { id: 'allmail',  message_id: '<m1>', folder: '[Gmail]/All Mail', account_id: 'work' },
      { id: 'work-old', message_id: '<m1>', folder: 'INBOX', account_id: 'work' },
    ];
    const result = appendMessagesByIdentity(existing, [
      { id: 'work-new', message_id: '<m1>', folder: 'INBOX', account_id: 'work' },
    ]);
    assert.equal(result.filter(m => m.folder === 'INBOX' && m.account_id === 'work').length, 1,
      'one INBOX row for the account');
    assert.ok(result.some(m => m.id === 'work-new'), 'the fresh row is the survivor');
    assert.ok(!result.some(m => m.id === 'work-old'), 'the stale row is gone');
  });

  it('prefers the row from the same account over one whose account is unknown', () => {
    // An account-less row matched any incoming row, so if it sat first it absorbed the
    // replacement and the real stale row survived alongside its replacement.
    const existing = [
      { id: 'ghost',    message_id: '<m1>', folder: 'INBOX' },
      { id: 'work-old', message_id: '<m1>', folder: 'INBOX', account_id: 'work' },
    ];
    const result = appendMessagesByIdentity(existing, [
      { id: 'work-new', message_id: '<m1>', folder: 'INBOX', account_id: 'work' },
    ]);
    assert.equal(result.filter(m => m.account_id === 'work').length, 1, 'no duplicate for the account');
    assert.ok(result.some(m => m.id === 'ghost'), 'the account-less row is untouched');
  });

  it('treats an account-less row as the same delivery before ranking against a Sent twin', () => {
    // Ambiguous on its face, so the rule is stated rather than left to list order: a row whose
    // account is unknown is treated as this delivery's own copy, matching how the replace rule
    // below already treats a missing account_id. The alternative, ranking against another
    // account's Sent twin, would replace a row belonging to a different message view.
    const existing = [
      { id: 'other-sent', message_id: '<m1>', folder: 'Sent', account_id: 'other' },
      { id: 'unknown',    message_id: '<m1>', folder: 'INBOX' },
    ];
    const result = appendMessagesByIdentity(existing, [
      { id: 'work', message_id: '<m1>', folder: 'INBOX', account_id: 'work' },
    ]);
    assert.ok(result.some(m => m.id === 'other-sent'), 'the Sent twin is left alone');
    assert.ok(!result.some(m => m.id === 'unknown'), 'the account-less row was the one replaced');
    assert.equal(result.length, 2);
  });

  it('agrees with dedupeByIdentity on a cross-account pair: every path keeps both', () => {
    // The merge paths disagreeing is what let the row flip between refreshes. They still have
    // to agree; what they agree on is now that both deliveries are real rows.
    const unread = { id: 'unread', message_id: '<m1>', folder: 'INBOX', account_id: 'a', is_read: false };
    const read   = { id: 'read',   message_id: '<m1>', folder: 'INBOX', account_id: 'b', is_read: true };
    assert.deepEqual(dedupeByIdentity([read, unread]).map(m => m.id), ['read', 'unread']);
    assert.deepEqual(appendMessagesByIdentity([read], [unread]).map(m => m.id), ['read', 'unread']);
    assert.deepEqual(appendMessagesByIdentity([unread], [read]).map(m => m.id), ['unread', 'read']);
    // And the Sent twin still collapses identically on both paths.
    const recv = { id: 'recv', message_id: '<m2>', folder: 'INBOX', account_id: 'a' };
    const sent = { id: 'sent', message_id: '<m2>', folder: 'Sent',  account_id: 'b' };
    assert.deepEqual(dedupeByIdentity([recv, sent]).map(m => m.id), ['recv']);
    assert.deepEqual(appendMessagesByIdentity([recv], [sent]).map(m => m.id), ['recv']);
  });

  it('replaces a reindexed message in place instead of duplicating it (the #378 bug)', () => {
    // Existing list holds the message under its old DB id; the fetched page carries the same
    // Message-ID under a NEW id (purge+reinsert regenerated the UUID).
    const existing = [{ id: 'old', message_id: '<m1>', snippet: 'a' }];
    const incoming = [{ id: 'new', message_id: '<m1>', snippet: 'a' }];
    const result = appendMessagesByIdentity(existing, incoming);
    assert.equal(result.length, 1);              // no duplicate
    assert.equal(result[0].id, 'new');           // survivor is the fresh, clickable copy
  });

  it('drops an incoming row with the same DB id, preserving the existing (optimistic) copy', () => {
    const existing = [{ id: 'a', message_id: '<m1>', unread_count: 3 }];
    const incoming = [{ id: 'a', message_id: '<m1>', unread_count: 0 }];
    const result = appendMessagesByIdentity(existing, incoming);
    assert.equal(result, existing);              // unchanged reference — no-op
  });

  it('appends genuinely new messages', () => {
    const existing = [{ id: 'a', message_id: '<m1>' }];
    const incoming = [{ id: 'b', message_id: '<m2>' }, { id: 'c', message_id: '<m3>' }];
    const result = appendMessagesByIdentity(existing, incoming);
    assert.deepEqual(result.map(m => m.id), ['a', 'b', 'c']);
  });

  it('de-duplicates within the incoming batch by identity', () => {
    const existing = [];
    const incoming = [{ id: 'b', message_id: '<m2>' }, { id: 'b2', message_id: '<m2>' }];
    const result = appendMessagesByIdentity(existing, incoming);
    assert.equal(result.length, 1);
  });

  it('never collapses distinct messages that both lack a Message-ID', () => {
    const existing = [{ id: 'a', message_id: null }];
    const incoming = [{ id: 'b', message_id: null }];
    const result = appendMessagesByIdentity(existing, incoming);
    assert.deepEqual(result.map(m => m.id), ['a', 'b']);
  });

  it('returns the original reference when there is nothing to add or replace', () => {
    const existing = [{ id: 'a', message_id: '<m1>' }];
    assert.equal(appendMessagesByIdentity(existing, []), existing);
    assert.equal(appendMessagesByIdentity(existing, null), existing);
  });
});

describe('dedupeByIdentity: independent deliveries to different accounts (#476)', () => {
  // Reported by @amalroymj: the same email delivered to two connected accounts showed once
  // in All Inboxes. Every client whose behavior could be verified from source shows both --
  // Thunderbird desktop builds Unified Folders as a virtual folder over each account's INBOX
  // and never compares Message-IDs, and Thunderbird for Android concatenates a per-account
  // query per account. Mailbird documents the same behavior explicitly. The structural
  // reason is that each copy is a separate mailbox item carrying its own \Seen flag, so
  // collapsing them forces a choice about whose read state the surviving row represents.
  //
  // MailFlow also summed the unread badge across accounts without deduplicating it, so the
  // count said two while the list showed one, and reading the visible copy left a phantom
  // unread that had no row in the unified list.

  it('keeps both copies when one message reached two accounts INBOX', () => {
    const list = [
      { id: 'a', message_id: '<m1>', folder: 'INBOX', account_id: 'work' },
      { id: 'b', message_id: '<m1>', folder: 'INBOX', account_id: 'home' },
    ];
    const result = dedupeByIdentity(list);
    assert.equal(result.length, 2, 'two separate mailbox items, two rows');
    assert.deepEqual(result.map(m => m.id), ['a', 'b'], 'and arrival order is preserved');
  });

  it('keeps one row per account when three accounts received it', () => {
    const list = ['x', 'y', 'z'].map(acct => ({ id: acct, message_id: '<m1>', folder: 'INBOX', account_id: acct }));
    assert.equal(dedupeByIdentity(list).length, 3);
  });

  it('still collapses the Sent twin, which is a different case (#378)', () => {
    // You sent this from one of your accounts to another. That is one message seen from both
    // ends, not two independent deliveries, and the INBOX copy still represents it.
    const list = [
      { id: 'recv', message_id: '<m1>', folder: 'INBOX', account_id: 'u2' },
      { id: 'sent', message_id: '<m1>', folder: 'Sent', account_id: 'u1' },
    ];
    const result = dedupeByIdentity(list);
    assert.equal(result.length, 1, 'INBOX and Sent still collapse');
    assert.equal(result[0].id, 'recv');
  });

  it('still collapses two copies in the same folder of the same account', () => {
    // Two live UIDs can legitimately share a Message-ID inside one folder; 93 such rows exist
    // on a real instance. Those are one message to the reader and stay collapsed.
    const list = [
      { id: 'u1', message_id: '<m1>', folder: 'INBOX', account_id: 'same' },
      { id: 'u2', message_id: '<m1>', folder: 'INBOX', account_id: 'same' },
    ];
    assert.equal(dedupeByIdentity(list).length, 1);
  });

  it('collapses when an account id is missing, rather than guessing they are independent', () => {
    const list = [
      { id: 'a', message_id: '<m1>', folder: 'INBOX' },
      { id: 'b', message_id: '<m1>', folder: 'INBOX', account_id: 'home' },
    ];
    assert.equal(dedupeByIdentity(list).length, 1, 'unknown provenance keeps the old behavior');
  });
});

describe('dedupeByIdentity', () => {
  it('collapses two rows that share a Message-ID into one (the #378 cross-account/Sent case)', () => {
    // Same email present as user2's received INBOX copy and user1's Sent copy.
    const list = [
      { id: 'a', message_id: '<m1>', folder: 'INBOX', account_id: 'u2' },
      { id: 'b', message_id: '<m1>', folder: 'Sent', account_id: 'u1' },
    ];
    const result = dedupeByIdentity(list);
    assert.equal(result.length, 1);
  });

  it('keeps the INBOX copy when the same message appears in INBOX and another folder', () => {
    const list = [
      { id: 'b', message_id: '<m1>', folder: 'Sent' },
      { id: 'a', message_id: '<m1>', folder: 'INBOX' },
    ];
    const result = dedupeByIdentity(list);
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'a');       // INBOX copy wins regardless of order
    assert.equal(result[0].folder, 'INBOX');
  });

  it('keeps BOTH copies when the same message reached two unified accounts', () => {
    // Previously this asserted the unread copy won the collapse: one notification delivered to
    // two of the user's addresses shares a Message-ID and usually a Date, so arrival order is
    // arbitrary, and keeping the read copy hid an unread email from the default list while the
    // unread filter (which drops the read copy server-side) still showed it. Both copies now
    // stay, so the list matches the unread filter and the summed badge without either copy
    // having to speak for the other's read state.
    const list = [
      { id: 'read',   message_id: '<m1>', folder: 'INBOX', account_id: 'a', is_read: true },
      { id: 'unread', message_id: '<m1>', folder: 'INBOX', account_id: 'b', is_read: false },
    ];
    const result = dedupeByIdentity(list);
    assert.equal(result.length, 2);
    assert.deepEqual(result.map(m => m.id), ['read', 'unread']);
    assert.equal(result.find(m => m.id === 'unread').is_read, false);
  });

  it('keeps the unread copy no matter which order the two rows arrive in', () => {
    const unread = { id: 'unread', message_id: '<m1>', folder: 'INBOX', is_read: false };
    const read   = { id: 'read',   message_id: '<m1>', folder: 'INBOX', is_read: true };
    assert.equal(dedupeByIdentity([unread, read])[0].id, 'unread');
    assert.equal(dedupeByIdentity([read, unread])[0].id, 'unread');
  });

  it('still prefers INBOX over another folder even when the other copy is unread', () => {
    // Folder rank dominates: an unread Sent twin must not displace the INBOX row.
    const list = [
      { id: 'inbox', message_id: '<m1>', folder: 'INBOX', is_read: true },
      { id: 'sent',  message_id: '<m1>', folder: 'Sent',  is_read: false },
    ];
    const result = dedupeByIdentity(list);
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'inbox');
  });

  it('prefers the unread copy within a non-INBOX folder too', () => {
    const list = [
      { id: 'read',   message_id: '<m1>', folder: 'Archive', is_read: true },
      { id: 'unread', message_id: '<m1>', folder: 'Archive', is_read: false },
    ];
    assert.equal(dedupeByIdentity(list)[0].id, 'unread');
  });

  it('leaves both rows alone when they are equally good, so ordering stays stable', () => {
    const list = [
      { id: 'first',  message_id: '<m1>', folder: 'INBOX', is_read: false },
      { id: 'second', message_id: '<m1>', folder: 'INBOX', is_read: false },
    ];
    assert.equal(dedupeByIdentity(list)[0].id, 'first');
  });

  it('preserves order and keeps the first occurrence when no INBOX copy exists', () => {
    const list = [
      { id: 'x', message_id: '<m2>', folder: 'Archive' },
      { id: 'a', message_id: '<m1>', folder: 'Sent' },
      { id: 'b', message_id: '<m1>', folder: 'Archive' },
    ];
    const result = dedupeByIdentity(list);
    assert.deepEqual(result.map(m => m.id), ['x', 'a']);
  });

  it('never collapses distinct messages that both lack a Message-ID', () => {
    const list = [
      { id: 'a', message_id: null, folder: 'INBOX' },
      { id: 'b', message_id: null, folder: 'INBOX' },
    ];
    assert.deepEqual(dedupeByIdentity(list).map(m => m.id), ['a', 'b']);
  });

  it('handles empty / nullish input and skips falsy rows', () => {
    assert.deepEqual(dedupeByIdentity([]), []);
    assert.deepEqual(dedupeByIdentity(null), []);
    assert.deepEqual(dedupeByIdentity([null, { id: 'a', message_id: '<m1>' }]).map(m => m.id), ['a']);
  });
});

describe('missingByIdentity', () => {
  it('skips messages already present under a regenerated id (matched by Message-ID)', () => {
    const existing = [{ id: 'new', message_id: '<m1>' }];
    const incoming = [{ id: 'old', message_id: '<m1>' }]; // same message, stale id
    assert.deepEqual(missingByIdentity(existing, incoming), []);
  });

  it('returns messages that are genuinely absent', () => {
    const existing = [{ id: 'a', message_id: '<m1>' }];
    const incoming = [{ id: 'b', message_id: '<m2>' }];
    assert.deepEqual(missingByIdentity(existing, incoming).map(m => m.id), ['b']);
  });

  it('keeps distinct id-only rows apart', () => {
    const existing = [{ id: 'a', message_id: null }];
    const incoming = [{ id: 'b', message_id: null }];
    assert.deepEqual(missingByIdentity(existing, incoming).map(m => m.id), ['b']);
  });

  it('restores one account copy while the OTHER account copy is still listed (#476 undo)', () => {
    // Found in a fresh review of the branch. All Inboxes now lists both accounts' copies. The
    // user archives work's copy and presses Undo: restoreMessages asks what to put back, and
    // a Message-ID-only key answered "nothing, it is already there", pointing at home's copy.
    // Undo silently did nothing.
    const afterArchive = [{ id: 'home', message_id: '<m1>', folder: 'INBOX', account_id: 'home' }];
    const undo         = [{ id: 'work', message_id: '<m1>', folder: 'INBOX', account_id: 'work' }];
    assert.deepEqual(missingByIdentity(afterArchive, undo).map(m => m.id), ['work']);
  });

  it('still skips a same-account copy already back under a regenerated id', () => {
    const existing = [{ id: 'new', message_id: '<m1>', account_id: 'work' }];
    const incoming = [{ id: 'old', message_id: '<m1>', account_id: 'work' }];
    assert.deepEqual(missingByIdentity(existing, incoming), []);
  });
});
