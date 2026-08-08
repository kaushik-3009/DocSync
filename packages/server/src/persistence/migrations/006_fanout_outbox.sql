-- A committed document update must survive a Redis outage. This outbox row is
-- inserted in the same transaction as ops_log, then leased by a gateway-local
-- dispatcher until the Redis publish succeeds. `(page_id, seq)` is the durable
-- mutation identity for fanout; it is also the page-local operation identity.
CREATE TABLE IF NOT EXISTS fanout_outbox (
  page_id TEXT NOT NULL,
  seq BIGINT NOT NULL,
  update TEXT NOT NULL,
  traceparent TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (page_id, seq),
  FOREIGN KEY (page_id, seq) REFERENCES ops_log(page_id, seq) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS fanout_outbox_pending_idx
  ON fanout_outbox (delivered_at, available_at, lease_expires_at, created_at);
