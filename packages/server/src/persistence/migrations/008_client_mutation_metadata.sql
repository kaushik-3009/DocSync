-- Optional benchmark/client correlation metadata. The normal y-websocket
-- protocol remains unchanged; only clients that send MessageType 2 populate it.
ALTER TABLE ops_log ADD COLUMN IF NOT EXISTS client_mutation_id TEXT;
ALTER TABLE ops_log ADD COLUMN IF NOT EXISTS client_created_at_ms BIGINT;
ALTER TABLE fanout_outbox ADD COLUMN IF NOT EXISTS client_mutation_id TEXT;
ALTER TABLE fanout_outbox ADD COLUMN IF NOT EXISTS client_created_at_ms BIGINT;

CREATE INDEX IF NOT EXISTS ops_log_page_client_mutation_idx
  ON ops_log (page_id, client_mutation_id);
