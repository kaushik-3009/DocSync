-- Phase 2: ops log + snapshots for CRDT persistence and replay.
--
-- page_seq gives each page a monotonically increasing, gap-free sequence
-- number for its ops — this is what version history and replay-to-a-point
-- are built on top of (seq is the "version" in "version vectors" territory
-- Phase 3 will extend, not replace).
CREATE TABLE IF NOT EXISTS page_seq (
  page_id TEXT PRIMARY KEY,
  seq BIGINT NOT NULL DEFAULT 0
);

-- One row per Yjs update ever applied to a page. Never mutated, only
-- appended — this is the "ops log" / write-ahead history that snapshots
-- are a compaction of, and that replay reconstructs state from.
-- `update`/`state` are base64-encoded binary (Yjs update payloads), stored
-- as TEXT rather than BYTEA. This is a deliberate portability choice, not a
-- workaround: it sidesteps bytea encoding quirks across drivers/poolers
-- (relevant once PgBouncer or a different client library enters the stack
-- in later phases) at the cost of ~33% storage overhead, which is cheap
-- next to the alternative of a binary-encoding bug in the persistence path.
CREATE TABLE IF NOT EXISTS ops_log (
  page_id TEXT NOT NULL,
  seq BIGINT NOT NULL,
  update TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (page_id, seq)
);

-- Periodic full-document snapshots (Y.encodeStateAsUpdate at a given seq),
-- so replay doesn't have to re-apply every op since page creation.
CREATE TABLE IF NOT EXISTS snapshots (
  page_id TEXT NOT NULL,
  seq BIGINT NOT NULL,
  state TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (page_id, seq)
);

CREATE INDEX IF NOT EXISTS ops_log_page_seq_idx ON ops_log (page_id, seq);
CREATE INDEX IF NOT EXISTS snapshots_page_seq_idx ON snapshots (page_id, seq DESC);
