-- A library of named signatures per user (Settings > Signatures). An account, or an alias, is
-- assigned one of them by signature_id; an alias with none uses its account's, as before.
--
-- email_accounts.signature and account_aliases.signature stay, and stay what every send, draft
-- and scheduled-send path reads: services/signatureLibrary.js rewrites them, in the same
-- transaction, whenever an assigned signature is edited, assigned or deleted. Rolling back to a
-- release without the library therefore finds the signatures it expects.
--
-- Every existing signature becomes a library entry assigned to its account or alias, named
-- after it. Only rows without a signature_id are copied, so running this again copies nothing.
CREATE TABLE IF NOT EXISTS signatures (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT        NOT NULL,
  html       TEXT        NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS signatures_user_id_idx ON signatures (user_id);

ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS signature_id UUID REFERENCES signatures(id) ON DELETE SET NULL;
ALTER TABLE account_aliases ADD COLUMN IF NOT EXISTS signature_id UUID REFERENCES signatures(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS email_accounts_signature_id_idx ON email_accounts (signature_id);
CREATE INDEX IF NOT EXISTS account_aliases_signature_id_idx ON account_aliases (signature_id);

-- A volatile function in a CTE is evaluated once per row, and the CTE is read by both the insert
-- and the update, so each account gets the entry made from its own signature.
WITH src AS (
  SELECT id AS account_id, user_id, gen_random_uuid() AS signature_id, signature,
         CASE WHEN lower(btrim(name)) IN ('', lower(email_address)) THEN email_address
              ELSE btrim(name) || ' (' || email_address || ')' END AS name
    FROM email_accounts
   WHERE signature_id IS NULL AND signature IS NOT NULL AND btrim(signature) <> ''
), created AS (
  INSERT INTO signatures (id, user_id, name, html)
  SELECT signature_id, user_id, name, signature FROM src
  RETURNING id
)
UPDATE email_accounts a SET signature_id = src.signature_id
  FROM src WHERE a.id = src.account_id;

WITH src AS (
  SELECT al.id AS alias_id, a.user_id, gen_random_uuid() AS signature_id, al.signature,
         CASE WHEN lower(btrim(al.name)) IN ('', lower(al.email)) THEN al.email
              ELSE btrim(al.name) || ' (' || al.email || ')' END AS name
    FROM account_aliases al JOIN email_accounts a ON a.id = al.account_id
   WHERE al.signature_id IS NULL AND al.signature IS NOT NULL AND btrim(al.signature) <> ''
), created AS (
  INSERT INTO signatures (id, user_id, name, html)
  SELECT signature_id, user_id, name, signature FROM src
  RETURNING id
)
UPDATE account_aliases al SET signature_id = src.signature_id
  FROM src WHERE al.id = src.alias_id;
