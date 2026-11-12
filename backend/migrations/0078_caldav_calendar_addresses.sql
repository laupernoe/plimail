-- The addresses a CalDAV server lists as the user's own (calendar-user-address-set), kept so that
-- invitations to them are recognized as the user's after a restart, before the server is asked again.
ALTER TABLE caldav_accounts ADD COLUMN IF NOT EXISTS calendar_addresses TEXT[] NOT NULL DEFAULT '{}';
