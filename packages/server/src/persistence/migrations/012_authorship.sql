-- Which signed-in user a Yjs client id belongs to. Yjs stamps every inserted
-- character with the inserting client's id; the gateway records the
-- authenticated user behind each client id the first time it commits an
-- update from it, which is what makes "who wrote this" answerable later.
CREATE TABLE IF NOT EXISTS yjs_client_authors (
  page_id TEXT NOT NULL,
  client_id BIGINT NOT NULL,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (page_id, client_id)
);
