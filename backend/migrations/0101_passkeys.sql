-- Passkeys (WebAuthn credentials), routes/passkeys.js. A passkey signs the user in on its own: it
-- is something they have, unlocked by something they are or know (user verification is required),
-- so it stands in for both the password and the second factor.
--
-- `credential_id` is the authenticator's credential ID, base64url, as browsers send it back.
-- `public_key` is the COSE public key. `counter` is the authenticator's signature counter: a sign-in
-- whose counter does not go up (when the authenticator keeps one) is refused, since it can only
-- come from a copy of the key. Additive and idempotent.
CREATE TABLE IF NOT EXISTS passkeys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL UNIQUE,
  public_key BYTEA NOT NULL,
  counter BIGINT NOT NULL DEFAULT 0,
  transports JSONB NOT NULL DEFAULT '[]'::jsonb,
  device_type TEXT,
  backed_up BOOLEAN NOT NULL DEFAULT FALSE,
  aaguid TEXT,
  name VARCHAR(64) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS passkeys_user_id_idx ON passkeys (user_id);
