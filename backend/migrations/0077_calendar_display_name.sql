-- A name the user picks for a calendar, kept over the server's name, and calendars the user does
-- not want at all (often ones shared with them): an ignored calendar is not synced or shown.
ALTER TABLE calendars ADD COLUMN IF NOT EXISTS display_name TEXT;
ALTER TABLE calendars ADD COLUMN IF NOT EXISTS ignored BOOLEAN NOT NULL DEFAULT FALSE;
