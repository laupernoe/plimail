-- Drop what the removed built-in antispam stored.
--
-- spam_training_log, spam_models and spam_training_deletions held the per-user training
-- records, the Naive Bayes models and the GDPR reset audit. The messages columns held the
-- classifier's scores and verdicts and the user's override of them, and the email_accounts
-- columns its per-account switch and trusted Authentication-Results host. The user preference
-- keys were its master switch and thresholds. Mark as spam / not spam still moves the message
-- between the spam folder and the inbox; nothing it needs is here. The messages columns go with
-- their check constraints and idx_messages_spam_verdict. Idempotent.
DROP TABLE IF EXISTS spam_training_log;
DROP TABLE IF EXISTS spam_models;
DROP TABLE IF EXISTS spam_training_deletions;
ALTER TABLE messages
  DROP COLUMN IF EXISTS spam_score_sa,
  DROP COLUMN IF EXISTS spam_score_ml,
  DROP COLUMN IF EXISTS spam_verdict,
  DROP COLUMN IF EXISTS spam_analyzed_at,
  DROP COLUMN IF EXISTS spam_details,
  DROP COLUMN IF EXISTS spam_user_override;
ALTER TABLE email_accounts
  DROP COLUMN IF EXISTS antispam_enabled,
  DROP COLUMN IF EXISTS trusted_authserv_id;
UPDATE users
   SET preferences = preferences - 'spamEnabled' - 'spam_thresholds'
 WHERE preferences ?| ARRAY['spamEnabled', 'spam_thresholds'];
