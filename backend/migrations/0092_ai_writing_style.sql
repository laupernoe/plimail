-- The user's writing style, learned by the AI from their own sent mail and editable in Settings.
-- When enabled, the writing assistant and Reply with AI write in that style. samples is how many
-- sent messages the profile was learned from. Additive and idempotent.
ALTER TABLE users ADD COLUMN IF NOT EXISTS ai_writing_style TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS ai_writing_style_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS ai_writing_style_samples INTEGER;
ALTER TABLE users ADD COLUMN IF NOT EXISTS ai_writing_style_updated_at TIMESTAMPTZ;
