// Read receipts (MDN, RFC 8098): the choices the interface makes. The server decides whether a
// request may be answered at all (spam, lists, the Return-Path); this only turns its answer and
// the user's setting into what is shown.

export const RECEIPT_REPLY_MODES = ['ask', 'always', 'never'];

// Whether a new message asks for a read receipt. A message put back (an undone send, a scheduled
// message reopened) keeps what it had; a new one follows the "always ask" setting, off by default.
export function composeReadReceipt(composeData, always) {
  if (typeof composeData?.readReceipt === 'boolean') return composeData.readReceipt;
  return always === true;
}

// What to do with the server's verdict on an open message, given how the user answers requests:
//   none     show nothing
//   ask      the banner with Send and Ignore
//   auto     send it now: only "always send", and only when the server found nothing to doubt
//   confirm  the banner, with the warning: the address is not the one that delivered the message,
//            so even "always send" waits for the user
export function receiptAction({ status, mode }) {
  if (mode === 'never') return 'none';
  if (status === 'ok') return mode === 'always' ? 'auto' : 'ask';
  if (status === 'confirm') return 'confirm';
  return 'none';
}
