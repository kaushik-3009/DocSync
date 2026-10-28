-- Exports may live in object storage (S3) instead of inline. `storage_key`
-- names the object; `data` is only populated for the inline Postgres backend.
ALTER TABLE exports ADD COLUMN IF NOT EXISTS storage_key TEXT;
ALTER TABLE exports ALTER COLUMN data DROP NOT NULL;
