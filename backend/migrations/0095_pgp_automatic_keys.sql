-- OpenPGP keys made and unlocked without the user handling them (routes/pgp.js).
--
-- `users.pgp_kdf_salt` is the salt the browser derives a key passphrase with from the user's
-- Plimail password (frontend utils/pgpSecret.js). It is not secret and authenticates nothing; the
-- derived passphrase itself is never sent to the server.
--
-- `pgp_keys.protection` says what the private key is encrypted with: 'passphrase', a passphrase of
-- the user's own (the keys of migration 0094), or 'login', the passphrase derived from the Plimail
-- password. `auto_email` is set on a key Plimail made by itself for an address, and is unique per
-- user, so two tabs making the first key at once store one. Additive and idempotent.
ALTER TABLE users ADD COLUMN IF NOT EXISTS pgp_kdf_salt TEXT;
ALTER TABLE pgp_keys ADD COLUMN IF NOT EXISTS protection TEXT NOT NULL DEFAULT 'passphrase';
ALTER TABLE pgp_keys ADD COLUMN IF NOT EXISTS auto_email TEXT;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pgp_keys_protection_check') THEN
    ALTER TABLE pgp_keys ADD CONSTRAINT pgp_keys_protection_check CHECK (protection IN ('passphrase', 'login'));
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS pgp_keys_auto_email_idx ON pgp_keys (user_id, auto_email) WHERE auto_email IS NOT NULL;
