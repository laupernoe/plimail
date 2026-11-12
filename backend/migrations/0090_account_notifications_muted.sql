-- Per-account mute for new-mail alerts (#762). When set, new mail in the account raises no push,
-- desktop or in-app alert; the inbox list, unread counts and rules are unaffected, and an
-- explicit "Notify me" rule still alerts. Idempotent.
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS notifications_muted BOOLEAN NOT NULL DEFAULT false;
