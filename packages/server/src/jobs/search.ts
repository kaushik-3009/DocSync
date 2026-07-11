import type { Pool } from "pg";

export interface SearchHit {
  pageId: string;
  snippet: string;
}

/**
 * Plain ILIKE search over the denormalized `search_index` table (see
 * migration 003_jobs.sql for why this isn't tsvector/GIN). When `userId` is
 * provided (auth enabled), results are restricted to pages the user has any
 * role on — search must not leak the existence/content of pages a user
 * can't otherwise access.
 */
export async function searchPages(pool: Pool, query: string, userId: string | null): Promise<SearchHit[]> {
  const result = await pool.query<{ page_id: string; content: string }>(
    `SELECT page_id, content FROM search_index
     WHERE content ILIKE $1
       AND ($2::text IS NULL OR page_id IN (SELECT page_id FROM page_roles WHERE user_id = $2))
     ORDER BY updated_at DESC
     LIMIT 50`,
    [`%${query}%`, userId]
  );
  return result.rows.map((row) => ({
    pageId: row.page_id,
    snippet: row.content.length > 160 ? row.content.slice(0, 160) + "…" : row.content,
  }));
}
