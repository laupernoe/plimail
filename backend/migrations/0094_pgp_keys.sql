-- OpenPGP. `pgp_keys` holds the user's own key pairs. The private key is stored only as the
-- armored key the browser made or imported, protected by the key's own passphrase (OpenPGP key
-- encryption), which the server never sees: routes/pgp.js refuses a private key with any
-- unprotected secret packet. Decryption and signing happen in the browser. `emails` are the
-- addresses in the key's user IDs, which decide which key a message from an address uses.
--
-- `pgp_public_keys` is the user's keyring of correspondents' public keys, one row per address
-- and key. `source` says where it came from; `verified` is set only by the user, after checking
-- the fingerprint with its owner. Additive and idempotent.
CREATE TABLE IF NOT EXISTS pgp_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id UUID REFERENCES email_accounts(id) ON DELETE SET NULL,
  fingerprint TEXT NOT NULL,
  emails JSONB NOT NULL DEFAULT '[]'::jsonb,
  user_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  algorithm INTEGER,
  armored_public TEXT NOT NULL,
  armored_private TEXT NOT NULL,
  key_created_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, fingerprint)
);
CREATE INDEX IF NOT EXISTS pgp_keys_user_id_idx ON pgp_keys (user_id);

CREATE TABLE IF NOT EXISTS pgp_public_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  armored TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('manual', 'wkd', 'autocrypt', 'attachment')),
  verified BOOLEAN NOT NULL DEFAULT FALSE,
  first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, email, fingerprint)
);
CREATE INDEX IF NOT EXISTS pgp_public_keys_user_email_idx ON pgp_public_keys (user_id, email);
