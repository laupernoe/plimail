import { extractImapError } from './imapError.js';
import { internalDateOf, looksLikeMessage, mboxFlagsOf, messageIdOf } from './mailTransfer.js';

// Messages appended per IMAP session. Bounds both the messages held in memory and what one
// dropped connection can cost.
export const IMPORT_BATCH_SIZE = 20;
// A refusal that every message would get (the server is down, the quota is gone) is reported
// once, loudly, instead of being repeated for the rest of the file.
const MAX_BATCH_FAILURES_IN_A_ROW = 3;
const MAX_REPORTED_FAILURES = 500;

// Appends the messages of `messages` (an async iterable of { index, raw, fromDate, tooLarge,
// label }) to `folder`, in batches, and returns the report:
//   { imported, duplicates, failed, processed, failures: [{ label, reason }], failuresTruncated, aborted }
// This only ever adds mail: it reads message ids from the database and APPENDs, and has no way to
// delete, move or change a message that is already there. A message whose Message-ID is already
// in the folder, in the database or on the server, or earlier in this same import, is skipped.
export async function runImport({
  messages, account, folder, markSeen = true, imapManager, query, onProgress = () => {}, isCancelled = () => false,
}) {
  // A message keeps the flags its mbox headers carry. markSeen is for those that carry none.
  const flagsFor = (raw) => mboxFlagsOf(raw) ?? (markSeen ? ['\\Seen'] : []);
  const report = { imported: 0, duplicates: 0, failed: 0, processed: 0, failures: [], failuresTruncated: 0, aborted: null };
  const counts = () => ({ imported: report.imported, duplicates: report.duplicates, failed: report.failed, processed: report.processed });
  const seenIds = new Set();
  let batch = [];
  let batchFailuresInARow = 0;

  const fail = (label, reason) => {
    report.failed++;
    report.processed++;
    if (report.failures.length < MAX_REPORTED_FAILURES) report.failures.push({ label, reason });
    else report.failuresTruncated++;
  };

  async function flush() {
    if (!batch.length) return;
    let items = batch;
    batch = [];

    const ids = items.map(i => i.messageId).filter(Boolean);
    let known = new Set();
    if (ids.length) {
      const { rows } = await query(
        'SELECT message_id FROM messages WHERE account_id = $1 AND folder = $2 AND is_deleted = false AND message_id = ANY($3::text[])',
        [account.id, folder, ids],
      );
      known = new Set(rows.map(r => r.message_id));
    }
    const fresh = [];
    for (const it of items) {
      if (it.messageId && known.has(it.messageId)) { report.duplicates++; report.processed++; } else fresh.push(it);
    }
    items = fresh;
    if (!items.length) return;

    let results;
    try {
      results = await imapManager.appendImportBatch(account, folder, items);
      batchFailuresInARow = 0;
    } catch (err) {
      results = err?.partialResults || [];
      const reason = extractImapError(err) || 'IMAP connection failed';
      for (let i = results.length; i < items.length; i++) results = [...results, { status: 'failed', reason }];
      if (!results.some(r => r.status !== 'failed')) batchFailuresInARow++;
      else batchFailuresInARow = 0;
    }
    items.forEach((it, i) => {
      const r = results[i] || { status: 'failed', reason: 'No answer from the server' };
      if (r.status === 'imported') { report.imported++; report.processed++; }
      else if (r.status === 'duplicate') { report.duplicates++; report.processed++; }
      else fail(it.label, r.reason || 'The server refused the message');
    });
  }

  try {
    for await (const msg of messages) {
      const label = msg.label ?? `message ${msg.index + 1}`;
      if (msg.tooLarge) { fail(label, 'Larger than the size limit for one message'); }
      else if (!msg.raw || msg.raw.length === 0) { fail(label, 'Empty message'); }
      else if (!looksLikeMessage(msg.raw)) { fail(label, 'Not an RFC 822 message: no header at the start'); }
      else {
        const messageId = messageIdOf(msg.raw);
        if (messageId && seenIds.has(messageId)) { report.duplicates++; report.processed++; }
        else {
          if (messageId) seenIds.add(messageId);
          batch.push({ raw: msg.raw, messageId, date: internalDateOf(msg.raw, msg.fromDate), flags: flagsFor(msg.raw), label });
        }
      }
      if (batch.length >= IMPORT_BATCH_SIZE) {
        await flush();
        onProgress(counts());
        if (batchFailuresInARow >= MAX_BATCH_FAILURES_IN_A_ROW) { report.aborted = 'imap_unavailable'; return report; }
        if (isCancelled()) { report.aborted = 'cancelled'; return report; }
      }
    }
    await flush();
  } catch (err) {
    // The database or the upload stream failed: what was appended stays, and the report says why it stopped.
    report.aborted = 'error';
    report.abortReason = err.message;
    // Messages already read from the file are not lost with it.
    try { await flush(); } catch { /* the database is what failed; they stay unimported */ }
  }
  onProgress(counts());
  return report;
}
