-- Only the selfhostr themes remain (selfhostr, selfhostr-light) and "system", which follows the OS
-- between them. Any other stored theme (dark, light, nord, winxp, ...) now means "system". The
-- font pairing is bound to the theme and no longer a preference, so the stored choice goes too.
UPDATE users
SET preferences = preferences || '{"theme": "system"}'::jsonb
WHERE jsonb_exists(preferences, 'theme')
  AND COALESCE(preferences->>'theme', '') <> ALL (ARRAY['system', 'selfhostr', 'selfhostr-light']);

UPDATE users
SET preferences = preferences - 'font'
WHERE jsonb_exists(preferences, 'font');
