// Emoji reactions in a conversation (backend/src/services/reactions.js has the formats).
//
// A reaction is a message of its own, in its folder like any other, which the server marks with
// `reaction_emoji` once it has read and checked it. Here it is taken out of the conversation's
// stack and shown as a chip under the message it reacts to, but only when that message is in the
// conversation: a reaction to something not on screen stays an ordinary card, as Gmail shows one.

// The quick choices of the picker, Gmail's and Outlook's usual set.
export const QUICK_REACTIONS = ['👍', '❤️', '😂', '🎉', '😮', '🙏'];

// Gmail's limits (developers.google.com/workspace/gmail/reactions/format), as the server applies them.
export const MAX_REACTION_RECIPIENTS = 20;
export const MAX_REACTIONS_PER_USER = 20;

const key = id => String(id || '').trim();
const emailKey = value => String(value || '').trim().toLowerCase();

// The addresses that are the reader's own: every account's, and its aliases'.
export function ownAddresses(accounts = []) {
  const own = new Set();
  for (const account of accounts || []) {
    if (account?.email_address) own.add(emailKey(account.email_address));
    for (const alias of account?.aliases || []) if (alias?.email) own.add(emailKey(alias.email));
  }
  return own;
}

export const isReaction = message => Boolean(message?.reaction_emoji) && Boolean(key(message?.in_reply_to));

// Splits a conversation into the cards to show and the reactions on each: { cards, reactionsByTarget }.
// A reaction goes to the copy of its target in its own account when there is one (one email in two
// accounts is two cards), else to the first copy.
export function splitReactions(messages = []) {
  const byMessageId = new Map();
  for (const message of messages) {
    if (isReaction(message) || !key(message.message_id)) continue;
    const list = byMessageId.get(key(message.message_id)) || [];
    list.push(message);
    byMessageId.set(key(message.message_id), list);
  }
  const reactionsByTarget = new Map();
  const cards = [];
  for (const message of messages) {
    const targets = isReaction(message) ? byMessageId.get(key(message.in_reply_to)) : null;
    if (!targets?.length) {
      cards.push(message);
      continue;
    }
    const target = targets.find(t => t.account_id === message.account_id) || targets[0];
    const list = reactionsByTarget.get(target.id) || [];
    list.push(message);
    reactionsByTarget.set(target.id, list);
  }
  return { cards, reactionsByTarget };
}

// The chips under one message: [{ emoji, count, people: [{ name, email, mine }], mine }], in the
// order each emoji first appeared. One person counts once per emoji, and an RFC 9078 reaction may
// carry several emoji.
export function groupReactions(reactions = [], own = new Set()) {
  const groups = new Map();
  const sorted = [...reactions].sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0));
  for (const reaction of sorted) {
    const email = emailKey(reaction.from_email);
    const mine = own.has(email);
    for (const emoji of String(reaction.reaction_emoji).split(' ').filter(Boolean)) {
      const group = groups.get(emoji) || { emoji, people: [], mine: false };
      if (!group.people.some(p => p.email === email)) {
        group.people.push({ name: reaction.from_name || reaction.from_email || '', email, mine });
      }
      group.mine = group.mine || mine;
      groups.set(emoji, group);
    }
  }
  return [...groups.values()].map(group => ({ ...group, count: group.people.length }));
}

const addresses = list => (Array.isArray(list) ? list : []).map(a => emailKey(a?.email || a?.address)).filter(Boolean);

// Whether the reader can react to a message, by the server's rules (services/reactions.js
// reactionBlocker): not a draft or a reaction, not a mailing list, at most 20 To and Cc
// recipients, and the reader one of them or the author; and fewer than 20 of their own reactions.
export function canReact(message, own = new Set(), reactions = []) {
  if (!message || message.is_draft || isReaction(message) || !key(message.message_id)) return false;
  if (message.is_bulk || message.list_unsubscribe) return false;
  const recipients = new Set([...addresses(message.to_addresses), ...addresses(message.cc_addresses)]);
  if (recipients.size > MAX_REACTION_RECIPIENTS) return false;
  const fromMe = own.has(emailKey(message.from_email));
  if (!fromMe && ![...recipients].some(email => own.has(email))) return false;
  const mine = new Set(reactions.filter(r => own.has(emailKey(r.from_email))).map(r => r.reaction_emoji));
  return mine.size < MAX_REACTIONS_PER_USER;
}

// The reader's own emoji on a message, so the picker does not send the same one twice.
export const myReactionEmoji = (reactions = [], own = new Set()) => new Set(
  reactions.filter(r => own.has(emailKey(r.from_email))).flatMap(r => String(r.reaction_emoji).split(' ').filter(Boolean)),
);

// What a reaction looks like in the stack before the server answers: the card shows it at once.
export function pendingReaction(target, emoji, account) {
  return {
    id: `pending-reaction-${target.id}-${emoji}`,
    account_id: target.account_id,
    message_id: null,
    in_reply_to: target.message_id,
    reaction_emoji: emoji,
    from_name: account?.sender_name || account?.name || '',
    from_email: account?.email_address || '',
    date: new Date().toISOString(),
    is_read: true,
    pending: true,
  };
}
