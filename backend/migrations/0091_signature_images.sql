-- Images uploaded into signatures. A signature shows one as /api/signature-images/<id>, served to
-- its owner only; when a message is built it goes out as an inline (cid:) part, so recipients
-- never fetch anything. Idempotent.
CREATE TABLE IF NOT EXISTS signature_images (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content_type TEXT NOT NULL,
  data BYTEA NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS signature_images_user_id_idx ON signature_images (user_id);
