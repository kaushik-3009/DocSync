-- A standard y-websocket Sync frame has no application metadata slot.  Keep
-- the wire protocol unchanged, but persist a deterministic digest of the raw
-- Yjs update so exact retransmissions can be correlated and classified in
-- logs/outbox evidence.  This is deliberately a fingerprint, not a claimed
-- client-generated mutation ID (see collaboration-lifecycle.md).
ALTER TABLE ops_log ADD COLUMN IF NOT EXISTS update_fingerprint TEXT;
ALTER TABLE fanout_outbox ADD COLUMN IF NOT EXISTS update_fingerprint TEXT;

CREATE INDEX IF NOT EXISTS ops_log_page_fingerprint_idx
  ON ops_log (page_id, update_fingerprint);

CREATE INDEX IF NOT EXISTS fanout_outbox_fingerprint_idx
  ON fanout_outbox (page_id, update_fingerprint);
