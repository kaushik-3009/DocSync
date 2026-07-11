import type { Pool } from "pg";

/**
 * Atomically allocates the next seq for a page and appends the update in
 * one transaction, so concurrent appends for the same page never collide
 * or gap. The `page_seq` upsert row-locks per page_id, giving us a
 * per-page monotonic counter without a global sequence bottleneck.
 */
export async function appendOp(pool: Pool, pageId: string, update: Uint8Array): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ seq: string }>(
      `INSERT INTO page_seq (page_id, seq) VALUES ($1, 1)
       ON CONFLICT (page_id) DO UPDATE SET seq = page_seq.seq + 1
       RETURNING seq`,
      [pageId]
    );
    const seq = Number(rows[0].seq);
    await client.query(`INSERT INTO ops_log (page_id, seq, update) VALUES ($1, $2, $3)`, [
      pageId,
      seq,
      Buffer.from(update).toString("base64"),
    ]);
    await client.query("COMMIT");
    return seq;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export interface OpRow {
  seq: number;
  update: Uint8Array;
}

export async function getOpsInRange(pool: Pool, pageId: string, afterSeq: number, uptoSeq?: number): Promise<OpRow[]> {
  const { rows } = await pool.query<{ seq: string; update: string }>(
    uptoSeq === undefined
      ? `SELECT seq, update FROM ops_log WHERE page_id = $1 AND seq > $2 ORDER BY seq ASC`
      : `SELECT seq, update FROM ops_log WHERE page_id = $1 AND seq > $2 AND seq <= $3 ORDER BY seq ASC`,
    uptoSeq === undefined ? [pageId, afterSeq] : [pageId, afterSeq, uptoSeq]
  );
  return rows.map((r) => ({ seq: Number(r.seq), update: new Uint8Array(Buffer.from(r.update, "base64")) }));
}

export async function getCurrentSeq(pool: Pool, pageId: string): Promise<number> {
  const { rows } = await pool.query<{ seq: string }>(`SELECT seq FROM page_seq WHERE page_id = $1`, [pageId]);
  return rows.length > 0 ? Number(rows[0].seq) : 0;
}
