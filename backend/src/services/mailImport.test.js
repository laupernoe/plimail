import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runImport, IMPORT_BATCH_SIZE } from './mailImport.js';

const account = { id: 'acc-1' };
const raw = (id, extra = '') => Buffer.from(`Message-ID: ${id}\r\nSubject: s\r\n${extra}\r\nbody\r\n`);
async function* source(items) { for (const i of items) yield i; }
const item = (n, extra = {}) => ({ index: n, raw: raw(`<${n}@x>`), fromDate: null, ...extra });

describe('runImport', () => {
  let imap, query;
  beforeEach(() => {
    query = vi.fn().mockResolvedValue({ rows: [] });
    imap = { appendImportBatch: vi.fn(async (_a, _f, items) => items.map(() => ({ status: 'imported' }))) };
  });
  const run = (items, opts = {}) => runImport({ messages: source(items), account, folder: 'INBOX', markSeen: true, imapManager: imap, query, ...opts });

  it('appends each message with its original date and the \\Seen flag', async () => {
    const d = new Date('1999-05-06T07:08:09Z');
    const report = await run([item(1, { fromDate: d }), { ...item(2), raw: raw('<2@x>', 'Date: Tue, 1 Mar 2022 10:00:00 +0100\r\n') }]);
    expect(report).toMatchObject({ imported: 2, duplicates: 0, failed: 0, processed: 2, aborted: null });
    const [, folder, batch] = imap.appendImportBatch.mock.calls[0];
    expect(folder).toBe('INBOX');
    expect(batch.map(i => i.flags)).toEqual([['\\Seen'], ['\\Seen']]);
    expect(batch[0].date).toEqual(d);
    expect(batch[1].date.toISOString()).toBe('2022-03-01T09:00:00.000Z');
  });

  it('leaves the message unread when asked', async () => {
    await run([item(1)], { markSeen: false });
    expect(imap.appendImportBatch.mock.calls[0][2][0].flags).toEqual([]);
  });

  it('keeps the read, answered and flagged state the mbox headers carry', async () => {
    await run([
      { ...item(1), raw: raw('<1@x>', 'Status: RO\r\nX-Status: AF\r\n') },
      { ...item(2), raw: raw('<2@x>', 'Status: O\r\n') },
      { ...item(3), raw: raw('<3@x>', 'X-Mozilla-Status: 0005\r\n') },
      item(4),
    ], { markSeen: true });
    // Only the message that says nothing about it is marked read by the option.
    expect(imap.appendImportBatch.mock.calls[0][2].map(i => i.flags)).toEqual([
      ['\\Seen', '\\Answered', '\\Flagged'], [], ['\\Seen', '\\Flagged'], ['\\Seen'],
    ]);
  });

  it('skips messages whose Message-ID is already in the folder, and says so', async () => {
    query.mockResolvedValue({ rows: [{ message_id: '<1@x>' }] });
    const report = await run([item(1), item(2)]);
    expect(report).toMatchObject({ imported: 1, duplicates: 1, failed: 0 });
    expect(imap.appendImportBatch.mock.calls[0][2].map(i => i.messageId)).toEqual(['<2@x>']);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('message_id = ANY');
    expect(params[0]).toBe('acc-1');
    expect(params[1]).toBe('INBOX');
  });

  it('skips a Message-ID that appears twice in the same import', async () => {
    const report = await run([item(1), { ...item(2), raw: raw('<1@x>') }]);
    expect(report).toMatchObject({ imported: 1, duplicates: 1 });
  });

  it('counts a duplicate the server found itself', async () => {
    imap.appendImportBatch.mockResolvedValue([{ status: 'duplicate' }, { status: 'imported' }]);
    expect(await run([item(1), item(2)])).toMatchObject({ imported: 1, duplicates: 1, failed: 0 });
  });

  it('reports each failure with its reason and carries on', async () => {
    imap.appendImportBatch.mockResolvedValue([{ status: 'failed', reason: 'Mailbox full' }, { status: 'imported' }]);
    const report = await run([
      item(1, { label: 'one.eml' }),
      item(2),
      { index: 3, raw: null, tooLarge: true, label: 'big' },
      { index: 4, raw: Buffer.alloc(0) },
      { index: 5, raw: Buffer.from('not a message') },
    ]);
    expect(report.imported).toBe(1);
    expect(report.failed).toBe(4);
    expect(report.failures.map(f => f.label)).toEqual(['big', 'message 5', 'message 6', 'one.eml']);
    expect(report.failures.find(f => f.label === 'one.eml').reason).toBe('Mailbox full');
    expect(report.failures.every(f => typeof f.reason === 'string' && f.reason)).toBe(true);
  });

  it('works in batches and reports progress after each', async () => {
    const onProgress = vi.fn();
    const items = Array.from({ length: IMPORT_BATCH_SIZE * 2 + 1 }, (_, i) => item(i + 1));
    const report = await run(items, { onProgress });
    expect(imap.appendImportBatch).toHaveBeenCalledTimes(3);
    expect(report.imported).toBe(items.length);
    expect(onProgress).toHaveBeenCalledTimes(3);
    expect(onProgress.mock.calls.at(-1)[0]).toMatchObject({ processed: items.length, imported: items.length });
  });

  it('fails the batch, not the import, when the connection breaks, and stops after three in a row', async () => {
    imap.appendImportBatch.mockRejectedValue(new Error('Connection closed'));
    const items = Array.from({ length: IMPORT_BATCH_SIZE * 5 }, (_, i) => item(i + 1));
    const report = await run(items);
    expect(imap.appendImportBatch).toHaveBeenCalledTimes(3);
    expect(report.aborted).toBe('imap_unavailable');
    expect(report.failed).toBe(IMPORT_BATCH_SIZE * 3);
    expect(report.failures[0].reason).toContain('Connection closed');
  });

  it('keeps what a broken batch had already stored', async () => {
    imap.appendImportBatch.mockRejectedValueOnce(Object.assign(new Error('Connection closed'), {
      partialResults: [{ status: 'imported' }],
    }));
    const report = await run([item(1), item(2)]);
    expect(report).toMatchObject({ imported: 1, failed: 1 });
  });

  it('stops when cancelled', async () => {
    let cancelled = false;
    imap.appendImportBatch.mockImplementation(async (_a, _f, items) => { cancelled = true; return items.map(() => ({ status: 'imported' })); });
    const items = Array.from({ length: IMPORT_BATCH_SIZE * 2 }, (_, i) => item(i + 1));
    const report = await run(items, { isCancelled: () => cancelled });
    expect(imap.appendImportBatch).toHaveBeenCalledTimes(1);
    expect(report.aborted).toBe('cancelled');
  });

  it('only ever reads and appends: no delete or update reaches the database', async () => {
    await run([item(1), item(2)]);
    for (const [sql] of query.mock.calls) expect(sql.trim()).toMatch(/^SELECT/i);
    expect(Object.keys(imap)).toEqual(['appendImportBatch']);
  });

  it('caps the failure list but keeps counting', async () => {
    imap.appendImportBatch.mockImplementation(async (_a, _f, items) => items.map(() => ({ status: 'failed', reason: 'no' })));
    const items = Array.from({ length: 700 }, (_, i) => item(i + 1));
    const report = await run(items);
    expect(report.failed).toBe(700);
    expect(report.failures).toHaveLength(500);
    expect(report.failuresTruncated).toBe(200);
  });
});
