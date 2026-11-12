-- Drop what the removed plugin platform (and its only plugin, GTD) stored.
--
-- plugin_data held plugin-scoped key/value rows (the GTD inbox-zero pet), plugin_account_config
-- the per-account plugin settings (GTD enabled flag and state folders), and
-- messages.plugin_annotations a per-message cache (the GTD gist). No code reads any of them now.
-- The user preference keys were written only by the plugin activation route and the GTD sidebar.
-- Mail itself is untouched: GTD's state folders are ordinary IMAP folders and stay as they are.
-- Idempotent.
DROP TABLE IF EXISTS plugin_account_config;
DROP TABLE IF EXISTS plugin_data;
ALTER TABLE messages DROP COLUMN IF EXISTS plugin_annotations;
UPDATE users
   SET preferences = preferences - 'enabledPlugins' - 'gtdCollapsedSections' - 'gtdPetSlug'
 WHERE preferences ?| ARRAY['enabledPlugins', 'gtdCollapsedSections', 'gtdPetSlug'];
