// Bulk export and import of a folder (the Sidebar folder menu). The server does the work:
// the export is a plain download, and an import is one request per file, whose body is the file.

export function classifyImportFile(name) {
  const m = /\.(mbox|mbx|eml)$/i.exec(String(name || ''));
  if (!m) return null;
  return m[1].toLowerCase() === 'eml' ? 'eml' : 'mbox';
}

export function exportUrl(accountId, folder, format) {
  const q = new URLSearchParams({ accountId, folder, format });
  return `/api/mail-transfer/export?${q}`;
}

// The path after /api, as api.js's request() takes it.
export function importUrl(accountId, folder, { format, markSeen, importId, label }) {
  const q = new URLSearchParams({ accountId, folder, format, markSeen: markSeen ? '1' : '0', importId });
  if (label) q.set('label', label);
  return `/mail-transfer/import?${q}`;
}

// A same-origin anchor click carries the session cookie and hands the stream to the browser, which
// writes it to disk as it arrives. Returns false when there is no document to click in.
export function downloadExport(accountId, folder, format, doc = globalThis.document) {
  if (!doc?.body) return false;
  const a = doc.createElement('a');
  a.href = exportUrl(accountId, folder, format);
  a.download = '';
  doc.body.appendChild(a);
  a.click();
  a.remove();
  return true;
}

// Hands a Blob to the browser as a download named `name`.
export function saveBlob(blob, name, doc = globalThis.document, urls = globalThis.URL) {
  if (!doc?.body || !urls?.createObjectURL) return false;
  const href = urls.createObjectURL(blob);
  const a = doc.createElement('a');
  a.href = href;
  a.download = name;
  doc.body.appendChild(a);
  a.click();
  a.remove();
  // Revoked later, not at once: the browser may not have started reading the Blob yet.
  setTimeout(() => urls.revokeObjectURL(href), 60_000)?.unref?.();
  return true;
}

export function selectionExportName(now = new Date()) {
  return `messages-${now.toISOString().slice(0, 10)}.mbox`;
}

// 0..1 across all the files: those done, plus how much of the current one the server has read.
export function importProgressFraction({ fileIndex, fileCount, bytesRead = 0, totalBytes = null }) {
  if (!fileCount) return 0;
  const current = totalBytes > 0 ? Math.min(1, Math.max(0, bytesRead / totalBytes)) : 0;
  return Math.min(1, (fileIndex + current) / fileCount);
}

// One report from the reports of the files, each failure naming its file.
export function mergeReports(...entries) {
  const merged = { imported: 0, duplicates: 0, failed: 0, processed: 0, failures: [], failuresTruncated: 0, aborted: null, abortReason: null };
  for (const { name, report } of entries) {
    merged.imported += report.imported;
    merged.duplicates += report.duplicates;
    merged.failed += report.failed;
    merged.processed += report.processed;
    merged.failuresTruncated += report.failuresTruncated || 0;
    for (const f of report.failures || []) {
      merged.failures.push({ label: f.label === name ? name : `${name}: ${f.label}`, reason: f.reason });
    }
    if (report.aborted && !merged.aborted) { merged.aborted = report.aborted; merged.abortReason = report.abortReason || null; }
  }
  return merged;
}

// Imports the files one after another. `send` is api.importMail. A file that cannot be sent is a
// failure in the report, not the end of the run; the report says what was added either way.
export async function runFileImport(files, { accountId, folder, markSeen, importId, send, onFile = () => {}, unsupportedReason = '' }) {
  const entries = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    onFile(i, files.length);
    const format = classifyImportFile(f.name);
    const failure = reason => ({ name: f.name, report: { imported: 0, duplicates: 0, failed: 1, processed: 1, failures: [{ label: f.name, reason }], failuresTruncated: 0, aborted: null } });
    if (!format) { entries.push(failure(unsupportedReason)); continue; }
    try {
      const report = await send(accountId, folder, f, { format, markSeen, importId, label: f.name });
      entries.push({ name: f.name, report });
    } catch (err) {
      entries.push(failure(err?.message || 'Request failed'));
    }
  }
  onFile(files.length, files.length);
  return mergeReports(...entries);
}
