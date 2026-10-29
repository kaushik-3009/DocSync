-- Images attached to pages. The row is the access-control anchor (page_id);
-- bytes live in S3 (storage_key) or, for local development, inline (data).
CREATE TABLE IF NOT EXISTS uploads (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  storage_key TEXT,
  data TEXT,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS uploads_page_idx ON uploads (page_id);
