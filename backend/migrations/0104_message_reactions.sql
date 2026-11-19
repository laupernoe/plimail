-- no-transaction
-- Emoji reactions (RFC 9078 and Gmail's text/vnd.google.email-reaction+json part).
--
-- `reaction_parts` is set at sync, from BODYSTRUCTURE alone, on a reply whose MIME structure has a
-- reaction part: a JSON array of { type: 'rfc9078' | 'json', part, encoding, charset }. The emoji is
-- in the body, which sync does not always fetch, so `reaction_emoji` is filled in later
-- (services/reactions.js): NULL while unread, the emoji once the part was read and found valid,
-- and '' when it was not, in which case the message is shown as the ordinary mail it also is.
-- Nothing here changes what is on the server: a reaction stays a message in its folder.
--
-- The index finds the reactions to one message (GET /mail/messages/:id/reactions). It is partial,
-- so it holds only reactions, and built CONCURRENTLY (hence no-transaction) so it never blocks
-- writes on a live messages table. Every statement is idempotent, as a no-transaction migration
-- must be; the DROP first rebuilds an index a crash left INVALID (see 0060).
ALTER TABLE messages ADD COLUMN IF NOT EXISTS reaction_parts JSONB;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS reaction_emoji TEXT;
DROP INDEX CONCURRENTLY IF EXISTS idx_messages_reaction_target;
CREATE INDEX CONCURRENTLY idx_messages_reaction_target ON messages (account_id, in_reply_to) WHERE reaction_parts IS NOT NULL;
