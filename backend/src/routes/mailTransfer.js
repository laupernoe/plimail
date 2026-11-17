import { once } from 'node:events';
import { Router } from 'express';
import { ZipArchive } from 'archiver';
import { query } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import { imapManager } from '../index.js';
import { findOwnedAccount, findOwnedMessages } from '../services/ownership.js';
import { decodeMimeWords } from '../services/messageParser.js';
import { attachmentDisposition, safeFilename, truncateFilename } from '../utils/contentDisposition.js';
import {
  MailTransferFormatError, mboxFromLine, mboxrdEscape, parseMbox, subjectOf, toCrlf, withMboxStatus,
} from '../services/mailTransfer.js';
import { runImport } from '../services/mailImport.js';
import { liftRequestTimeout } from '../services/requestTimeLimit.js';


// Bulk export and import of a folder. Not in the API token allowlist, so a token cannot reach
// either: one reads a whole folder, the other writes to it.
const router = Router();
router.use(requireAuth);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// eslint-disable-next-line no-control-regex -- rejecting control characters on purpose
const BAD_FOLDER_RE = /[\x00-\x1f\x7f]/;
const EXPORT_BATCH = 10;
const DEFAULT_MAX_IMPORT_MB = 500;
// One message, anywhere in an import. Larger than any server accepts for delivery, so it is a
// file that is not mail, or one that would be refused by the server anyway.
const MAX_IMPORT_MESSAGE_BYTES = 50 * 1024 * 1024;
const PROGRESS_INTERVAL_MS = 400;

// Read per request, so a change to the variable needs a restart but not a rebuild.
export function maxImportBytes() {
  const mb = Number(process.env.MAIL_IMPORT_MAX_MB);
  return Math.floor((Number.isFinite(mb) && mb > 0 ? mb : DEFAULT_MAX_IMPORT_MB) * 1024 * 1024);
}

const validFolder = f => typeof f === 'string' && f.length > 0 && f.length <= 255 && !BAD_FOLDER_RE.test(f);

// The account (owned by the user, enabled) and folder named by the query, or an answer sent.
async function resolveTarget(req, res, formats) {
  const { accountId, folder, format } = req.query;
  if (typeof accountId !== 'string' || !UUID_RE.test(accountId)) { res.status(400).json({ error: 'Invalid account id' }); return null; }
  if (!validFolder(folder)) { res.status(400).json({ error: 'Invalid folder name' }); return null; }
  if (!formats.includes(format)) { res.status(400).json({ error: 'Invalid format' }); return null; }
  const account = await findOwnedAccount(req.session.userId, accountId, { enabled: true });
  if (!account) { res.status(404).json({ error: 'Account not found' }); return null; }
  const { rows } = await query('SELECT path FROM folders WHERE account_id = $1 AND path = $2', [account.id, folder]);
  if (!rows.length) { res.status(404).json({ error: 'Folder not found' }); return null; }
  return { account, folder, format };
}

// ── Export ────────────────────────────────────────────────────────────────────────────────────

// Streams the messages of `groups` ([{ account, folder, uids }]) as an mbox or a zip of .eml
// files, a few messages at a time, so a large folder is never held in memory.
async function streamExport(res, groups, format, filename) {
  let closed = false;
  res.on('close', () => { closed = true; });

  res.setHeader('Content-Type', format === 'zip' ? 'application/zip' : 'application/mbox');
  res.setHeader('Content-Disposition', attachmentDisposition(filename));
  res.setHeader('Cache-Control', 'no-store');

  // Fail the download rather than finish a file that quietly lacks messages: once the headers
  // are out there is no status left to send, so the connection is cut.
  let archive = null;
  try {
    if (format === 'zip') {
      archive = new ZipArchive({ zlib: { level: 6 } });
      archive.on('error', err => res.destroy(err));
      archive.pipe(res);
    }
    for (const { account, folder, uids } of groups) {
      for (let i = 0; i < uids.length && !closed; i += EXPORT_BATCH) {
        const batch = await imapManager.fetchRawBatch(account, folder, uids.slice(i, i + EXPORT_BATCH));
        for (const { uid, source, internalDate, flags } of batch) {
          if (closed) break;
          if (archive) {
            const subject = truncateFilename(safeFilename(decodeMimeWords(subjectOf(source)) || 'message'), 60);
            // Wait for archiver to take the entry in, so it never queues more than one message.
            const taken = new Promise(resolve => archive.once('entry', resolve));
            archive.append(source, { name: `${String(uid).padStart(6, '0')}-${subject}.eml`, ...(internalDate ? { date: internalDate } : {}) });
            await taken;
          } else {
            const body = mboxrdEscape(withMboxStatus(source, flags));
            const tail = body.length && body[body.length - 1] === 10 ? '\n' : '\r\n\n';
            for (const chunk of [mboxFromLine(internalDate || new Date(0)), body, tail]) {
              if (!res.write(chunk)) await Promise.race([once(res, 'drain'), once(res, 'close')]);
            }
          }
        }
      }
    }
    if (closed) return archive?.abort();
    if (archive) await archive.finalize();
    else res.end();
  } catch (err) {
    console.error('Mail export error:', err.message);
    archive?.abort();
    res.destroy(err);
  }
}

router.get('/export', async (req, res) => {
  try {
    const target = await resolveTarget(req, res, ['mbox', 'zip']);
    if (!target) return;
    const { account, folder, format } = target;

    const uids = await imapManager.listFolderUids(account, folder);
    if (!uids.length) return res.status(404).json({ error: 'The folder has no messages' });

    const stamp = new Date().toISOString().slice(0, 10);
    const base = truncateFilename(safeFilename(folder.replace(/[/\\.]+/g, '-')), 60);
    await streamExport(res, [{ account, folder, uids }], format, `${base}-${stamp}.${format}`);
  } catch (err) {
    console.error('Mail export error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to export the folder' });
    else res.destroy();
  }
});

// The selected messages, by id, as one .mbox. They may come from several folders and accounts of
// the user; ids that are not the user's are left out.
const MAX_SELECTION = 1000;
router.post('/export-selection', async (req, res) => {
  try {
    const { ids } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids array required' });
    if (ids.length > MAX_SELECTION) return res.status(400).json({ error: `Too many messages, at most ${MAX_SELECTION}` });
    if (!ids.every(id => typeof id === 'string' && UUID_RE.test(id))) return res.status(400).json({ error: 'Invalid message IDs' });

    const owned = await findOwnedMessages(req.session.userId, ids, { columns: 'm.account_id, m.folder, m.uid', live: true });
    const groups = new Map();
    for (const m of owned) {
      const key = `${m.account_id}\0${m.folder}`;
      if (!groups.has(key)) groups.set(key, { accountId: m.account_id, folder: m.folder, uids: [] });
      groups.get(key).uids.push(m.uid);
    }
    const resolved = [];
    for (const g of groups.values()) {
      const account = await findOwnedAccount(req.session.userId, g.accountId, { enabled: true });
      if (account) resolved.push({ account, folder: g.folder, uids: g.uids.sort((a, b) => a - b) });
    }
    if (!resolved.length) return res.status(404).json({ error: 'No messages found' });

    const stamp = new Date().toISOString().slice(0, 10);
    await streamExport(res, resolved, 'mbox', `messages-${stamp}.mbox`);
  } catch (err) {
    console.error('Mail export error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to export the messages' });
    else res.destroy();
  }
});

// ── Import ────────────────────────────────────────────────────────────────────────────────────

class ImportLimitError extends Error {}

// One at a time per user: a second import would only compete with the first for the connection.
const importsRunning = new Set();

// The body is the file itself (an .mbox, or one .eml), read as a stream, so nothing waits on a
// form parser and the file is never held whole. express.json and friends skip these types.
router.post('/import', async (req, res) => {
  const userId = req.session.userId;
  let slotTaken = false;
  let restoreRequestTimeout = () => {};
  // Many answers come before the file has been read to its end (a refusal, the size limit, a file
  // that is not mail). The connection then cannot carry another request, so it is closed once the
  // answer is out; an import is one long request per file, so keep-alive saves nothing here.
  res.setHeader('Connection', 'close');
  res.once('finish', () => { if (!req.complete) req.destroy(); });
  try {
    const target = await resolveTarget(req, res, ['mbox', 'eml']);
    if (!target) return;
    const { account, folder, format } = target;
    const importId = typeof req.query.importId === 'string' && /^[\w-]{1,64}$/.test(req.query.importId) ? req.query.importId : null;
    const markSeen = req.query.markSeen !== '0' && req.query.markSeen !== 'false';

    const limit = maxImportBytes();
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      return res.status(413).json({ error: `The file is larger than the import limit of ${Math.round(limit / 1024 / 1024)} MB (MAIL_IMPORT_MAX_MB).` });
    }
    if (importsRunning.has(userId)) return res.status(409).json({ error: 'An import is already running. Wait for it to finish.' });
    importsRunning.add(userId);
    slotTaken = true;
    // The file is read only as fast as its messages are appended, which for a large mailbox takes
    // far longer than Node's five-minute limit on receiving a request.
    restoreRequestTimeout = liftRequestTimeout(req.socket.server);

    let bytesRead = 0;
    let limitHit = false;
    let formatError = null;
    let cancelled = false;
    res.on('close', () => { if (!res.writableEnded) cancelled = true; });
    const onBytes = (n) => {
      bytesRead += n;
      if (bytesRead > limit) { limitHit = true; throw new ImportLimitError('Upload larger than the import limit'); }
    };

    async function* emlMessage() {
      const parts = [];
      let size = 0;
      let tooLarge = false;
      for await (const chunk of req) {
        onBytes(chunk.length);
        size += chunk.length;
        if (size > MAX_IMPORT_MESSAGE_BYTES) { tooLarge = true; parts.length = 0; } else if (!tooLarge) parts.push(chunk);
      }
      const label = typeof req.query.label === 'string' && req.query.label ? truncateFilename(safeFilename(req.query.label), 120) : 'message';
      yield { index: 0, label, raw: tooLarge ? null : toCrlf(Buffer.concat(parts)), fromDate: null, tooLarge };
    }
    async function* guarded(source) {
      try { yield* source; } catch (err) {
        if (err instanceof MailTransferFormatError) formatError = err;
        throw err;
      }
    }
    const messages = format === 'mbox'
      ? guarded(parseMbox(req, { maxMessageBytes: MAX_IMPORT_MESSAGE_BYTES, onBytes }))
      : guarded(emlMessage());

    const totalBytes = Number.isFinite(declared) ? declared : null;
    let lastSent = 0;
    const sendProgress = (counts, done = false) => {
      imapManager.broadcast({ type: 'mail_import_progress', importId, accountId: account.id, folder, ...counts, bytesRead, totalBytes, done }, userId);
    };
    const report = await runImport({
      messages, account, folder, markSeen, imapManager, query,
      isCancelled: () => cancelled,
      onProgress: (counts) => {
        if (Date.now() - lastSent < PROGRESS_INTERVAL_MS) return;
        lastSent = Date.now();
        sendProgress(counts);
      },
    });
    if (limitHit) report.aborted = 'too_large';
    sendProgress({ imported: report.imported, duplicates: report.duplicates, failed: report.failed, processed: report.processed }, true);

    if (report.imported > 0) {
      imapManager.syncFolderOnDemand(account, folder).catch(err => console.error('syncFolderOnDemand after import:', err.message));
    }
    console.log(`Mail import into ${account.id}/${folder}: ${report.imported} imported, ${report.duplicates} duplicates, ${report.failed} failed${report.aborted ? `, stopped: ${report.aborted}` : ''}`);
    if (cancelled) return;
    if (formatError && report.processed === 0) return res.status(400).json({ error: formatError.message });
    res.json(report);
  } catch (err) {
    console.error('Mail import error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to import' });
  } finally {
    if (slotTaken) importsRunning.delete(userId);
    restoreRequestTimeout();
  }
});

export default router;
