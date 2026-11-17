import { Router } from 'express';
import { query } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import { findOwnedMessage } from '../services/ownership.js';
import { imapManager } from '../index.js';
import { parseRawHeaders } from '../services/messageParser.js';
import { createAccountSmtpTransport } from '../services/smtpTransport.js';
import {
  MDN_SENT_FLAG, assessReceiptRequest, buildMdn, folderRole, receiptReplyMode,
} from '../services/readReceipts.js';

// Read receipts the user is asked for (RFC 8098). GET says whether the open message asks for one
// and may be answered; POST answers it (send) or declines it (ignore). Either way the answer is
// kept on the message as the IMAP keyword $MDNSent, the one Thunderbird uses, so it is never
// asked or sent twice, from here or from another client.
const router = Router();
router.use(requireAuth);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Messages whose answer is being written right now, so two clicks or tabs cannot both send.
const inflight = new Set();

const norm = v => String(v || '').replace(/[<>\s]/g, '').toLowerCase();

class ReceiptError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}

// The message, its account and the state the server holds for it now: headers and flags are read
// from the mail server, never taken from the client.
async function loadState(userId, id) {
  const message = await findOwnedMessage(userId, id, {
    columns: 'm.id, m.account_id, m.uid, m.folder, m.message_id, m.subject, m.date, m.is_bulk',
    live: true,
  });
  if (!message) throw new ReceiptError(404, 'Message not found');
  const [{ rows: [account] }, { rows: [folder] }] = await Promise.all([
    query('SELECT * FROM email_accounts WHERE id = $1', [message.account_id]),
    query('SELECT special_use FROM folders WHERE account_id = $1 AND path = $2', [message.account_id, message.folder]),
  ]);
  if (!account) throw new ReceiptError(404, 'Account not found');
  let fetched;
  try { fetched = await imapManager.fetchHeadersAndFlags(account, message.uid, message.folder); }
  catch (err) {
    console.warn('Read receipt: header fetch failed:', err.message);
    throw new ReceiptError(502, 'Could not read this message from the mail server.');
  }
  const headers = parseRawHeaders(fetched?.headers || '');
  // A uid that now holds another message must not be answered as this one (cf. the draft Bcc lookup).
  if (!Object.keys(headers).length || (message.message_id && norm(message.message_id) !== norm(headers['message-id']))) {
    throw new ReceiptError(409, 'This message changed on the mail server. Refresh the folder and try again.');
  }
  const assessment = assessReceiptRequest({
    headers, flags: fetched.flags || [], role: folderRole(folder?.special_use), message,
  });
  return { message, account, headers, assessment };
}

router.get('/messages/:id/receipt', async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid message id' });
  try {
    const prefsRow = await query('SELECT preferences FROM users WHERE id = $1', [req.session.userId]);
    const mode = receiptReplyMode(prefsRow.rows[0]?.preferences);
    // Nothing is read from the mail server for a user who never answers.
    if (mode === 'never') return res.json({ status: 'none', mode });
    const { assessment } = await loadState(req.session.userId, id);
    res.json({
      status: assessment.status,
      mode,
      ...(assessment.reason ? { reason: assessment.reason } : {}),
      ...(assessment.status === 'ok' || assessment.status === 'confirm' ? { address: assessment.address } : {}),
    });
  } catch (err) {
    if (err instanceof ReceiptError) return res.status(err.status).json({ error: err.message });
    console.error('Read receipt lookup failed:', err.message);
    res.status(500).json({ error: 'Failed to look up the read receipt request' });
  }
});

router.post('/messages/:id/receipt', async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid message id' });
  const { action, confirm } = req.body || {};
  if (action !== 'send' && action !== 'ignore') return res.status(400).json({ error: 'action must be send or ignore' });
  const key = `${req.session.userId}:${id}`;
  if (inflight.has(key)) return res.status(409).json({ error: 'A read receipt for this message is already being handled.' });
  inflight.add(key);
  let flagged = false;
  let state;
  try {
    state = await loadState(req.session.userId, id);
    const { message, account, assessment } = state;
    if (assessment.status === 'done') return res.json({ status: 'done' });
    if (assessment.status === 'none' || assessment.status === 'blocked') {
      return res.status(409).json({ error: 'This message cannot be answered with a read receipt.', status: assessment.status });
    }
    if (action === 'send' && assessment.status === 'confirm' && confirm !== true) {
      return res.status(409).json({ error: 'This request needs your confirmation.', status: 'confirm', reason: assessment.reason });
    }
    // The keyword goes on first: when it cannot be stored nothing is sent, because a receipt that
    // could be sent again is worse than one not sent.
    try {
      await imapManager.setFlag(account, message.uid, message.folder, MDN_SENT_FLAG, true);
    } catch (err) {
      console.warn('Read receipt: could not store $MDNSent:', err.message);
      throw new ReceiptError(502, 'Could not record the answer on the mail server, so nothing was sent.');
    }
    flagged = true;
    if (action === 'ignore') return res.json({ status: 'ignored' });

    const smtp = await createAccountSmtpTransport(account);
    if (smtp.error) throw new ReceiptError(smtp.status || 502, smtp.error);
    const sender = smtp.account || account;
    const mdn = await buildMdn({
      fromName: sender.sender_name || sender.name,
      fromEmail: sender.email_address,
      to: assessment.address,
      original: { messageId: message.message_id, subject: message.subject, date: message.date },
    });
    await smtp.transport.sendMail({ raw: mdn.raw, envelope: mdn.envelope });
    res.json({ status: 'sent' });
  } catch (err) {
    // Not sent, so it may be asked again: take the keyword back off (best effort).
    if (flagged && action === 'send') {
      imapManager.setFlag(state.account, state.message.uid, state.message.folder, MDN_SENT_FLAG, false)
        .catch(e => console.warn('Read receipt: could not clear $MDNSent after a failed send:', e.message));
    }
    if (err instanceof ReceiptError) return res.status(err.status).json({ error: err.message, ...err.extra });
    console.error('Read receipt failed:', err.message);
    res.status(500).json({ error: 'Could not send the read receipt.' });
  } finally {
    inflight.delete(key);
  }
});

export default router;
