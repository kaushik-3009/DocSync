import type { Pool } from "pg";
import type * as Y from "yjs";
import type { Embedder } from "../ai/embeddings.js";
import { childLogger } from "../logger.js";
import { chunkDocument } from "./chunking.js";

const log = childLogger({ module: "semantic-search" });

export interface SemanticHit {
  pageId: string;
  title: string;
  content: string;
  score: number;
}

const toVector = (values: number[]) => `[${values.join(",")}]`;

/**
 * pgvector-backed retrieval over page chunks. Embedding calls cost money and
 * latency, so re-indexing only embeds chunks whose content (or embedder)
 * changed since the last run.
 */
export class SemanticIndex {
  constructor(
    private readonly pool: Pool,
    private readonly embedder: Embedder
  ) {}

  async indexPage(pageId: string, doc: Y.Doc): Promise<{ embedded: number; reused: number }> {
    const chunks = chunkDocument(doc);
    const { rows: existing } = await this.pool.query<{ chunk_index: number; content_hash: string; embedder: string }>(
      "SELECT chunk_index, content_hash, embedder FROM page_chunks WHERE page_id = $1",
      [pageId]
    );
    const current = new Map(existing.map((row) => [row.chunk_index, row]));
    const stale = chunks.filter((chunk) => {
      const row = current.get(chunk.index);
      return !row || row.content_hash !== chunk.contentHash || row.embedder !== this.embedder.name;
    });
    const vectors = await this.embedder.embed(stale.map((chunk) => chunk.content));

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const [position, chunk] of stale.entries()) {
        await client.query(
          `INSERT INTO page_chunks (page_id, chunk_index, content, content_hash, embedder, embedding, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6::vector, now())
           ON CONFLICT (page_id, chunk_index) DO UPDATE SET content = EXCLUDED.content, content_hash = EXCLUDED.content_hash,
             embedder = EXCLUDED.embedder, embedding = EXCLUDED.embedding, updated_at = now()`,
          [pageId, chunk.index, chunk.content, chunk.contentHash, this.embedder.name, toVector(vectors[position]!)]
        );
      }
      await client.query("DELETE FROM page_chunks WHERE page_id = $1 AND chunk_index >= $2", [pageId, chunks.length]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
    log.info(
      { event: "semantic_index_updated", pageId, embedded: stale.length, reused: chunks.length - stale.length },
      "semantic index refreshed"
    );
    return { embedded: stale.length, reused: chunks.length - stale.length };
  }

  /** Nearest chunks to `query`, restricted to pages `userId` can read (all
   *  pages when auth is disabled and userId is null). */
  async search(query: string, userId: string | null, limit = 10): Promise<SemanticHit[]> {
    const [vector] = await this.embedder.embed([query]);
    const { rows } = await this.pool.query<{ page_id: string; title: string | null; content: string; distance: number }>(
      `SELECT c.page_id, d.title, c.content, c.embedding <=> $1::vector AS distance
       FROM page_chunks c
       LEFT JOIN documents d ON d.id = c.page_id
       WHERE ($2::text IS NULL OR c.page_id IN (SELECT page_id FROM page_roles WHERE user_id = $2))
       ORDER BY c.embedding <=> $1::vector
       LIMIT $3`,
      [toVector(vector!), userId, limit]
    );
    return rows.map((row) => ({
      pageId: row.page_id,
      title: row.title ?? "Untitled",
      content: row.content,
      score: 1 - Number(row.distance),
    }));
  }
}
