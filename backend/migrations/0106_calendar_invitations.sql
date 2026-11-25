-- Invitations received by mail (iMIP, RFC 6047), and the answers given to them here.
--
-- A mail_invites row is written at sync, from BODYSTRUCTURE alone, for a message that carries a
-- text/calendar or application/ics part: `parts` says where (see messageParser detectInviteParts).
-- The object itself is read later (services/mailInvites.js): `ical` is NULL until then, the
-- iCalendar text once read, and '' when the parts held no invitation. uid, method, sequence and
-- range_end are read from it, so the pending list is found without parsing every row. The row goes
-- with its message: a message moved or resynced gets a new row, and is read again.
--
-- calendar_invite_replies records the user's answer per meeting (UID) and occurrence
-- (recurrence_id, '' for the whole series), at the SEQUENCE answered: a later revision of the
-- invitation asks again. It is what keeps an answer known when nothing else holds it: a declined
-- invitation, or a user with no calendar to put the event in.
CREATE TABLE IF NOT EXISTS mail_invites (
  message_id UUID PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  parts JSONB NOT NULL,
  ical TEXT,
  method TEXT,
  uid TEXT,
  sequence INTEGER,
  range_end TIMESTAMPTZ,
  read_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_mail_invites_account ON mail_invites(account_id);

CREATE TABLE IF NOT EXISTS calendar_invite_replies (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  uid TEXT NOT NULL,
  recurrence_id TEXT NOT NULL DEFAULT '',
  sequence INTEGER NOT NULL DEFAULT 0,
  partstat TEXT NOT NULL,
  summary TEXT,
  answered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, uid, recurrence_id)
);
