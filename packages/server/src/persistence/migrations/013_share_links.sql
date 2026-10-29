-- Public read-only links. Only a SHA-256 of each link's secret is stored, so
-- a database leak does not leak working links.
CREATE TABLE IF NOT EXISTS share_links (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS share_links_page_idx ON share_links (page_id);
