-- Keys collected from a received Autocrypt header without anyone asking (services/pgpKeyring.js,
-- storeAutocryptKey). `auto_collected` is set only on those rows. A key the user imported, verified
-- or got from a Web Key Directory never carries it, so a later Autocrypt header can replace the
-- automatic ones and nothing else. Rows that were already stored with source 'autocrypt' were taken
-- by the user from an offer, and stay out of reach. Additive and idempotent.
ALTER TABLE pgp_public_keys ADD COLUMN IF NOT EXISTS auto_collected BOOLEAN NOT NULL DEFAULT FALSE;
