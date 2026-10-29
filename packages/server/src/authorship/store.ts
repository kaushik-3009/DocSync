import type { Pool } from "pg";
import { childLogger } from "../logger.js";

const log = childLogger({ module: "authorship" });

export interface ClientAuthor {
  userId: string | null;
  email: string | null;
}

/** Durable Yjs client id -> user mapping per page. */
export class AuthorshipStore {
  constructor(private readonly pool: Pool) {}

  /** First writer wins: a client id already attributed keeps its author, so
   *  a later session cannot re-attribute someone else's text to itself. */
  async record(pageId: string, entries: Array<{ clientId: number; userId: string }>): Promise<void> {
    if (entries.length === 0) return;
    const values = entries.map((_, index) => `($1, $${index * 2 + 2}, $${index * 2 + 3})`).join(", ");
    await this.pool.query(
      `INSERT INTO yjs_client_authors (page_id, client_id, user_id) VALUES ${values} ON CONFLICT (page_id, client_id) DO NOTHING`,
      [pageId, ...entries.flatMap((entry) => [entry.clientId, entry.userId])]
    );
    log.debug({ event: "client_authors_recorded", pageId, count: entries.length }, "recorded Yjs client authors");
  }

  async authorsFor(pageId: string): Promise<Map<number, ClientAuthor>> {
    const { rows } = await this.pool.query<{ client_id: string; user_id: string | null; email: string | null }>(
      `SELECT a.client_id, a.user_id, u.email
       FROM yjs_client_authors a LEFT JOIN users u ON u.id = a.user_id
       WHERE a.page_id = $1`,
      [pageId]
    );
    return new Map(rows.map((row) => [Number(row.client_id), { userId: row.user_id, email: row.email }]));
  }
}
