-- Semantic search over page chunks. Optional: requires the pgvector
-- extension (RDS Postgres 16 and the CI image ship it; pg-mem does not).
-- When this migration cannot run, semantic search reports itself as
-- unavailable and keyword search keeps working.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS page_chunks (
  page_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  embedder TEXT NOT NULL,
  embedding vector(768) NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (page_id, chunk_index)
);

-- Approximate nearest-neighbour search by cosine distance.
CREATE INDEX IF NOT EXISTS page_chunks_embedding_idx ON page_chunks USING hnsw (embedding vector_cosine_ops);
