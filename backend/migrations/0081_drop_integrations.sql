-- Drop what the removed integrations stored: the Todoist connection and the CardDAV contact
-- sync client.
--
-- user_integrations held only those two providers' per-user settings (the Todoist API token,
-- the CardDAV server, login and sync state). The address books the CardDAV client pulled in
-- are kept, with their contacts, and become ordinary local books the user can edit:
-- address_books.source and external_url only told synced books apart and are dropped.
-- Idempotent.
DROP TABLE IF EXISTS user_integrations;
ALTER TABLE address_books DROP COLUMN IF EXISTS source;
ALTER TABLE address_books DROP COLUMN IF EXISTS external_url;
