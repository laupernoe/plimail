import { parseRawHeaders } from './messageParser.js';
import { normalizeAddress, readAutocryptHeader } from './autocryptReceive.js';
import { storeAutocryptKey } from './pgpKeyring.js';

// Keeps the key in a received message's Autocrypt header (Autocrypt Level 1) in the user's keyring
// without asking, the way Thunderbird and Delta Chat do. It runs where a message's body is first
// fetched from the mail server (routes/mail.js), once per message and only for the message the
// user opened or the body prefetch took: never over a mailbox. A body served from the stored row
// does not come back here, so reopening a message costs nothing.
//
// The rules live in autocryptReceive.js (is this a key to keep) and pgpKeyring.js (does it
// replace what the keyring has). This only reads the header block and hands them over.

const HEADERS_TIMEOUT_MS = 10_000;

// Never throws: a message that cannot be read for a key is just a message without one, and the
// reader's body is already on its way.
export async function collectAutocrypt({ imapManager, account, message, userId }, { store = storeAutocryptKey, now = () => new Date() } = {}) {
  let timer;
  try {
    if (!userId || !message?.from_email || !imapManager?.fetchHeaders) return { action: 'skip', reason: 'unavailable' };
    // The user's own mail, in Sent or copied to themselves, says nothing about a correspondent.
    if (normalizeAddress(message.from_email) === normalizeAddress(account?.email)) return { action: 'skip', reason: 'own' };
    const raw = await Promise.race([
      imapManager.fetchHeaders(account, message.uid, message.folder),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('headers fetch timed out')), HEADERS_TIMEOUT_MS); }),
    ]);
    const headers = parseRawHeaders(raw);
    if (!headers.autocrypt) return { action: 'skip', reason: 'noHeader' };
    const result = readAutocryptHeader(headers, message.from_email, { now: now(), messageDate: message.date });
    if (!result.ok) return { action: 'skip', reason: result.reason };
    return await store(userId, result);
  } catch (err) {
    console.warn(`[autocrypt] key not collected: ${err?.message || err}`);
    return { action: 'skip', reason: 'error' };
  } finally {
    clearTimeout(timer);
  }
}
