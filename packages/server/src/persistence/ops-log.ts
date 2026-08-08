import { createHash } from "node:crypto";
import type { Pool } from "pg";

/**
 * Atomically allocates the next seq for a page and appends the update in
 * one transaction, so concurrent appends for the same page never collide
 * or gap. The `page_seq` upsert row-locks per page_id, giving us a
 * per-page monotonic counter without a global sequence bottleneck.
 */
export interface AppendOpOptions {
  /** Write a retryable fanout record in the same transaction as this op. */
  enqueueFanout?: boolean;
  /** Trace context is durable metadata for the later asynchronous publisher. */
  traceparent?: string;
  /** Optional benchmark/client correlation metadata. */
  clientMutationId?: string;
  clientCreatedAtMs?: number;
}

/**
 * Stable correlation for the exact binary Yjs update received by the gateway.
 * y-websocket's standard Sync frame has no metadata field. The benchmark and
 * chaos harnesses may use the separately versioned metadata frame, but this
 * fingerprint remains useful for ordinary clients and must not be described as
 * proof that two semantically equivalent Yjs updates are the same edit.
 */
export function updateFingerprint(update: Uint8Array): string {
  return createHash("sha256").update(update).digest("hex");
}

export async function appendOp(pool: Pool, pageId: string, update: Uint8Array, options: AppendOpOptions = {}): Promise<number> {
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
    const encodedUpdate = Buffer.from(update).toString("base64");
    const fingerprint = updateFingerprint(update);
    await client.query(`INSERT INTO ops_log (page_id, seq, update, update_fingerprint, client_mutation_id, client_created_at_ms) VALUES ($1, $2, $3, $4, $5, $6)`, [
      pageId,
      seq,
      encodedUpdate,
      fingerprint,
      options.clientMutationId ?? null,
      options.clientCreatedAtMs ?? null,
    ]);
    if (options.enqueueFanout) {
      await client.query(
        `INSERT INTO fanout_outbox (page_id, seq, update, update_fingerprint, client_mutation_id, client_created_at_ms, traceparent)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [pageId, seq, encodedUpdate, fingerprint, options.clientMutationId ?? null, options.clientCreatedAtMs ?? null, options.traceparent ?? null]
      );
    }
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

export interface OpSummary {
  seq: number;
  createdAt: string;
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

/** Every durable operation is a user-visible version. Periodic snapshots are
 * replay checkpoints, not the history boundary. */
export async function listOpSummaries(pool: Pool, pageId: string): Promise<OpSummary[]> {
  const { rows } = await pool.query<{ seq: string; created_at: string | Date }>(
    `SELECT seq, created_at FROM ops_log WHERE page_id = $1 ORDER BY seq DESC`,
    [pageId]
  );
  return rows.map((row) => ({ seq: Number(row.seq), createdAt: new Date(row.created_at).toISOString() }));
}
