import { query } from './db.js';
import { reactionEmojiFromParts } from './messageParser.js';

// Emoji reactions: recording the candidates sync finds, reading their emoji, and deciding whether
// a message can be reacted to. The formats are in messageParser.js (detectReactionParts).
//
// A reaction is never more than a reading of a message that stays where it is: nothing here
// moves, flags or deletes one. A reaction whose emoji is not known yet, or turned out invalid, is
// shown as the ordinary message it also is.

// Gmail's limits for a client that sends reactions (developers.google.com/workspace/gmail/reactions/format).
export const MAX_REACTION_RECIPIENTS = 20;
export const MAX_REACTIONS_PER_USER = 20;

// Called by sync after a message row is written. Only fills a row that has none, so a resolved
// emoji is never reset by the next sync of the same uid.
export async function recordReactionParts(accountId, folder, uid, parts) {
  if (!parts?.length) return;
  await query(
    `UPDATE messages SET reaction_parts = $4::jsonb
      WHERE account_id = $1 AND folder = $2 AND uid = $3 AND reaction_parts IS NULL`,
    [accountId, folder, uid, JSON.stringify(parts)]
  );
}

// The Sent copy of a reaction sent from here: its emoji is known, so it needs no fetch.
export async function recordOwnReaction(accountId, folder, uid, parts, emoji) {
  await query(
    `UPDATE messages SET reaction_parts = $4::jsonb, reaction_emoji = $5
      WHERE account_id = $1 AND folder = $2 AND uid = $3`,
    [accountId, folder, uid, JSON.stringify(parts), emoji]
  );
}

function decodeText(buffer, charset) {
  try {
    return new TextDecoder(charset || 'utf-8').decode(buffer);
  } catch {
    return new TextDecoder('utf-8').decode(buffer);
  }
}

const validParts = parts => Array.isArray(parts)
  && parts.length > 0
  && parts.length <= 2
  && parts.every(p => p && typeof p.part === 'string' && /^\d+(\.\d+)*$/.test(p.part) && (p.type === 'json' || p.type === 'rfc9078'));

export const needsReactionEmoji = row => row?.reaction_parts != null && row.reaction_emoji == null;

// A fetch that failed (server down, message gone) is not tried again for this long, so a thread
// opened repeatedly does not open an IMAP connection each time.
const RETRY_AFTER_MS = 10 * 60 * 1000;
const inFlight = new Map();
const failedAt = new Map();

async function fetchEmoji(row, account, engine) {
  const parts = row.reaction_parts;
  // Not something sync wrote: treated as no reaction rather than fetched.
  if (!validParts(parts)) return '';
  const buffers = await engine.fetchMultipleAttachments(account, row.uid, row.folder,
    parts.map(p => ({ part: p.part, encoding: p.encoding })));
  // Nothing came back: the message may be gone or the server failing. Unknown, not invalid.
  if (!buffers?.size) return undefined;
  const texts = new Map();
  for (const p of parts) {
    const buf = buffers.get(p.part);
    if (buf) texts.set(p.part, decodeText(buf, p.charset));
  }
  return reactionEmojiFromParts(parts, texts);
}

async function resolveOne(row, account, engine, now) {
  if (!account) return;
  if (now - (failedAt.get(row.id) || 0) < RETRY_AFTER_MS) return;
  let pending = inFlight.get(row.id);
  if (!pending) {
    pending = (async () => {
      try {
        const emoji = await fetchEmoji(row, account, engine);
        if (emoji === undefined) {
          failedAt.set(row.id, Date.now());
          return undefined;
        }
        failedAt.delete(row.id);
        await query('UPDATE messages SET reaction_emoji = $2 WHERE id = $1 AND reaction_emoji IS NULL', [row.id, emoji]);
        return emoji;
      } catch (err) {
        failedAt.set(row.id, Date.now());
        console.warn(`Reaction part fetch failed for message ${row.id}: ${err.message}`);
        return undefined;
      } finally {
        inFlight.delete(row.id);
      }
    })();
    inFlight.set(row.id, pending);
  }
  const emoji = await pending;
  if (emoji !== undefined) row.reaction_emoji = emoji;
}

// Reads the emoji of the thread rows that have reaction parts and no emoji yet, in place, one at a
// time and at most `max` per call. Waits at most `timeoutMs`: what is not read by then stays
// unknown for this response (shown as ordinary mail) and is stored when it lands.
export async function resolveReactionEmoji(rows, { engine, timeoutMs = 6000, max = 10, now = Date.now() } = {}) {
  const todo = (rows || []).filter(needsReactionEmoji).slice(0, max);
  if (!todo.length || !engine) return;
  const accountIds = [...new Set(todo.map(r => r.account_id))];
  const { rows: accounts } = await query('SELECT * FROM email_accounts WHERE id = ANY($1::uuid[])', [accountIds]);
  const byId = new Map(accounts.map(a => [a.id, a]));
  const work = (async () => {
    for (const row of todo) await resolveOne(row, byId.get(row.account_id), engine, now);
  })();
  let timer;
  await Promise.race([work, new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); })])
    .finally(() => clearTimeout(timer));
}

export function _resetReactionState() {
  inFlight.clear();
  failedAt.clear();
}

const addressList = value => {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
  }
  return [];
};
const emailOf = entry => String(entry?.email || entry?.address || '').trim().toLowerCase();

// Why a message cannot be reacted to, or null. `own` is the set of the account's addresses,
// lowercased. Gmail's recommendations: no mailing lists, at most 20 distinct To and Cc
// recipients, and the reader must be one of them (not Bcc), or the author.
export function reactionBlocker(target, own) {
  if (!target) return 'not_found';
  if (target.is_draft) return 'draft';
  if (!target.message_id) return 'no_message_id';
  if (target.reaction_emoji) return 'is_reaction';
  if (target.is_bulk || target.list_unsubscribe) return 'mailing_list';
  const recipients = new Set([...addressList(target.to_addresses), ...addressList(target.cc_addresses)].map(emailOf).filter(Boolean));
  if (recipients.size > MAX_REACTION_RECIPIENTS) return 'too_many_recipients';
  const fromMe = own.has(String(target.from_email || '').toLowerCase());
  if (!fromMe && ![...recipients].some(email => own.has(email))) return 'not_a_recipient';
  return null;
}

const formatAddress = ({ name, email }) => {
  const clean = String(name || '').replace(/["\\\r\n\0<>]/g, '').trim();
  return clean ? `"${clean}" <${email}>` : email;
};

// Who a reaction goes to: everyone the message went to, as a reply-all does, without the reader.
// To the author (or its Reply-To), the rest in Cc; on one's own message, its own To and Cc.
export function reactionRecipients(target, own) {
  const seen = new Set();
  const take = list => addressList(list)
    .map(entry => ({ name: entry?.name || '', email: emailOf(entry) }))
    .filter(({ email }) => {
      if (!email || own.has(email) || seen.has(email)) return false;
      seen.add(email);
      return true;
    })
    .map(formatAddress);
  const fromMe = own.has(String(target.from_email || '').toLowerCase());
  if (fromMe) {
    const to = take(target.to_addresses);
    return { to, cc: take(target.cc_addresses) };
  }
  const replyTo = addressList(target.reply_to);
  const to = take(replyTo.length ? replyTo : [{ name: target.from_name, email: target.from_email }]);
  return { to, cc: take([...addressList(target.to_addresses), ...addressList(target.cc_addresses)]) };
}

export const reactionSubject = subject => {
  const s = String(subject || '').trim();
  return /^re:/i.test(s) ? s : `Re: ${s}`;
};

export function reactionReferences(target) {
  const refs = String(target.thread_references || '').trim();
  const id = String(target.message_id || '').trim();
  if (!refs) return id;
  return refs.split(/\s+/).includes(id) ? refs : `${refs} ${id}`;
}
