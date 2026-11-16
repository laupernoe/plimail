-- Password-protected messages for recipients without PGP. The browser encrypts the message with a
-- key derived from a password the server never sees (PBKDF2, `iterations` and `salt` stored so the
-- cost can change), and the server keeps only the ciphertext and SHA-256 of a second key derived
-- from the same password (`auth_verifier`), which a recipient must present before any ciphertext
-- is handed out. The recipient opens it at /s/<token>; `token` is 32 random bytes, base64url.
-- Replies are encrypted in the recipient's browser with the same key. Additive and idempotent.
CREATE TABLE IF NOT EXISTS secure_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token TEXT NOT NULL UNIQUE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id UUID REFERENCES email_accounts(id) ON DELETE SET NULL,
  sender_name TEXT,
  sender_email TEXT NOT NULL,
  recipients JSONB NOT NULL DEFAULT '[]'::jsonb,
  ciphertext BYTEA NOT NULL,
  iv TEXT NOT NULL,
  salt TEXT NOT NULL,
  iterations INTEGER NOT NULL,
  auth_verifier TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  first_opened_at TIMESTAMPTZ,
  last_opened_at TIMESTAMPTZ,
  open_count INTEGER NOT NULL DEFAULT 0,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS secure_messages_user_id_idx ON secure_messages (user_id);
CREATE INDEX IF NOT EXISTS secure_messages_expires_at_idx ON secure_messages (expires_at);

CREATE TABLE IF NOT EXISTS secure_message_replies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  secure_message_id UUID NOT NULL REFERENCES secure_messages(id) ON DELETE CASCADE,
  ciphertext BYTEA NOT NULL,
  iv TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  read_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS secure_message_replies_message_idx ON secure_message_replies (secure_message_id);
