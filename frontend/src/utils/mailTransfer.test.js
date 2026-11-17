import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyImportFile, exportUrl, importUrl, importProgressFraction, mergeReports, runFileImport, saveBlob, selectionExportName,
} from './mailTransfer.js';

const ACC = 'c3c3c3c3-3333-4333-8333-c3c3c3c3c3c3';
const file = (name, size = 10) => ({ name, size });
const report = (o = {}) => ({ imported: 0, duplicates: 0, failed: 0, processed: 0, failures: [], failuresTruncated: 0, aborted: null, ...o });

describe('classifyImportFile', () => {
  test('tells an mbox from an eml by its extension, in any case', () => {
    assert.equal(classifyImportFile('Archive.MBOX'), 'mbox');
    assert.equal(classifyImportFile('inbox.mbx'), 'mbox');
    assert.equal(classifyImportFile('mail.eml'), 'eml');
    assert.equal(classifyImportFile('Mail.EML'), 'eml');
    assert.equal(classifyImportFile('notes.txt'), null);
    assert.equal(classifyImportFile('eml'), null);
  });
});

describe('urls', () => {
  test('the export url carries the account, the folder and the format, encoded', () => {
    const u = new URL(exportUrl(ACC, 'INBOX/A & B', 'zip'), 'http://x');
    assert.equal(u.pathname, '/api/mail-transfer/export');
    assert.equal(u.searchParams.get('accountId'), ACC);
    assert.equal(u.searchParams.get('folder'), 'INBOX/A & B');
    assert.equal(u.searchParams.get('format'), 'zip');
  });

  test('the import path says whether to mark as read, and which import it is', () => {
    const q = new URLSearchParams(importUrl(ACC, 'INBOX', { format: 'eml', markSeen: false, importId: 'i-1', label: 'a b.eml' }).split('?')[1]);
    assert.equal(q.get('markSeen'), '0');
    assert.equal(q.get('importId'), 'i-1');
    assert.equal(q.get('label'), 'a b.eml');
    assert.equal(q.get('format'), 'eml');
    const on = new URLSearchParams(importUrl(ACC, 'INBOX', { format: 'mbox', markSeen: true, importId: 'i' }).split('?')[1]);
    assert.equal(on.get('markSeen'), '1');
    assert.equal(on.get('label'), null);
  });
});

describe('importProgressFraction', () => {
  test('counts finished files plus the share of the current one read so far', () => {
    assert.equal(importProgressFraction({ fileIndex: 0, fileCount: 2, bytesRead: 50, totalBytes: 100 }), 0.25);
    assert.equal(importProgressFraction({ fileIndex: 1, fileCount: 2, bytesRead: 0, totalBytes: 100 }), 0.5);
    assert.equal(importProgressFraction({ fileIndex: 2, fileCount: 2 }), 1);
  });

  test('never leaves 0..1, and copes with an unknown size', () => {
    assert.equal(importProgressFraction({ fileIndex: 0, fileCount: 1, bytesRead: 500, totalBytes: 100 }), 1);
    assert.equal(importProgressFraction({ fileIndex: 0, fileCount: 1, bytesRead: 5, totalBytes: null }), 0);
    assert.equal(importProgressFraction({ fileIndex: 0, fileCount: 0 }), 0);
  });
});

describe('mergeReports', () => {
  test('adds the counts and prefixes each failure with its file', () => {
    const merged = mergeReports(
      { name: 'a.mbox', report: report({ imported: 2, duplicates: 1, failed: 1, processed: 4, failures: [{ label: 'message 3', reason: 'Quota' }] }) },
      { name: 'b.eml', report: report({ imported: 1, processed: 1 }) },
    );
    assert.deepEqual(
      { i: merged.imported, d: merged.duplicates, f: merged.failed, p: merged.processed },
      { i: 3, d: 1, f: 1, p: 5 },
    );
    assert.deepEqual(merged.failures, [{ label: 'a.mbox: message 3', reason: 'Quota' }]);
    assert.equal(merged.aborted, null);
  });

  test('keeps the first reason an import stopped, and the truncation count', () => {
    const merged = mergeReports(
      { name: 'a.mbox', report: report({ aborted: 'too_large', failuresTruncated: 4 }) },
      { name: 'b.mbox', report: report({ aborted: 'cancelled', failuresTruncated: 1 }) },
    );
    assert.equal(merged.aborted, 'too_large');
    assert.equal(merged.failuresTruncated, 5);
  });

  test('a .eml failure is named by the file alone', () => {
    const merged = mergeReports({ name: 'b.eml', report: report({ failed: 1, failures: [{ label: 'b.eml', reason: 'Empty message' }] }) });
    assert.deepEqual(merged.failures, [{ label: 'b.eml', reason: 'Empty message' }]);
  });
});

describe('runFileImport', () => {
  const opts = { accountId: ACC, folder: 'INBOX', markSeen: true, importId: 'i-1' };

  test('sends each file in turn, with the format its name gives, and merges the reports', async () => {
    const calls = [];
    const send = async (accountId, folder, f, o) => { calls.push([f.name, o.format, o.markSeen]); return report({ imported: 1, processed: 1 }); };
    const out = await runFileImport([file('a.mbox'), file('b.eml')], { ...opts, markSeen: false, send });
    assert.deepEqual(calls, [['a.mbox', 'mbox', false], ['b.eml', 'eml', false]]);
    assert.equal(out.imported, 2);
  });

  test('reports a file it cannot send as a failure and goes on with the others', async () => {
    const send = async (accountId, folder, f) => {
      if (f.name === 'a.eml') throw new Error('Request too large');
      return report({ imported: 1, processed: 1 });
    };
    const out = await runFileImport([file('a.eml'), file('b.eml')], { ...opts, send });
    assert.equal(out.imported, 1);
    assert.equal(out.failed, 1);
    assert.deepEqual(out.failures, [{ label: 'a.eml', reason: 'Request too large' }]);
  });

  test('reports a file that is neither mbox nor eml without sending it', async () => {
    let sent = 0;
    const out = await runFileImport([file('notes.txt')], { ...opts, send: async () => { sent++; return report(); }, unsupportedReason: 'Not an .mbox or .eml file' });
    assert.equal(sent, 0);
    assert.deepEqual(out.failures, [{ label: 'notes.txt', reason: 'Not an .mbox or .eml file' }]);
  });

  test('says which file it is on', async () => {
    const seen = [];
    await runFileImport([file('a.eml'), file('b.eml')], { ...opts, send: async () => report(), onFile: (i, count) => seen.push([i, count]) });
    assert.deepEqual(seen, [[0, 2], [1, 2], [2, 2]]);
  });
});

describe('saveBlob', () => {
  test('clicks a link to an object URL named for the download', () => {
    const clicked = [];
    const body = { appendChild: () => {} };
    const doc = { body, createElement: () => ({ click() { clicked.push({ href: this.href, download: this.download }); }, remove() {} }) };
    const urls = { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} };
    assert.equal(saveBlob({}, 'messages-2026-11-17.mbox', doc, urls), true);
    assert.deepEqual(clicked, [{ href: 'blob:x', download: 'messages-2026-11-17.mbox' }]);
    assert.equal(saveBlob({}, 'x', {}, urls), false);
  });

  test('names a selection export by the day', () => {
    assert.equal(selectionExportName(new Date('2026-11-17T23:00:00Z')), 'messages-2026-11-17.mbox');
  });
});
