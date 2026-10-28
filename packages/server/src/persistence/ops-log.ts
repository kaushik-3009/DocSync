import { createHash } from "node:crypto";
import type { Pool } from "pg";

export interface AppendOpOptions {
  /** Write a retryable fanout record in the same transaction as this op. */
  enqueueFanout?: boolean;
  /** Trace context is durable metadata for the later asynchronous publisher. */
  traceparent?: string;
  /** Optional benchmark/client correlation metadata. */
  clientMutationId?: string;
  clientCreatedAtMs?: number;
}

/** One update in a group commit. */
export interface AppendEntry {
  update: Uint8Array;
  traceparent?: string;
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

/** Builds `($1, $2, ...), ($n, ...)` placeholders for a multi-row insert. */
function valuesClause(rowCount: number, columnCount: number): string {
  return Array.from(
    { length: rowCount },
    (_, row) => `(${Array.from({ length: columnCount }, (_, column) => `$${row * columnCount + column + 1}`).join(", ")})`
  ).join(", ");
}

/**
 * Group commit: allocates a contiguous block of per-page sequence numbers and
 * appends every entry (plus its fanout outbox row) in one transaction. The
 * `page_seq` upsert row-locks the page, so concurrent batches for the same page
 * never collide or gap, and cost is five round trips per batch rather than per
 * update. Returns the sequence assigned to each entry, in order.
 */
export async function appendOps(pool: Pool, pageId: string, entries: AppendEntry[], options: { enqueueFanout?: boolean } = {}): Promise<number[]> {
  if (entries.length === 0) return [];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ seq: string }>(
      `INSERT INTO page_seq (page_id, seq) VALUES ($1, $2)
       ON CONFLICT (page_id) DO UPDATE SET seq = page_seq.seq + $2
       RETURNING seq`,
      [pageId, entries.length]
    );
    const lastSeq = Number(rows[0].seq);
    const seqs = entries.map((_, index) => lastSeq - entries.length + index + 1);
    const encoded = entries.map((entry) => Buffer.from(entry.update).toString("base64"));
    const opRows = entries.map((entry, index) => [
      pageId,
      seqs[index],
      encoded[index],
      updateFingerprint(entry.update),
      entry.clientMutationId ?? null,
      entry.clientCreatedAtMs ?? null,
    ]);
    await client.query(
      `INSERT INTO ops_log (page_id, seq, update, update_fingerprint, client_mutation_id, client_created_at_ms) VALUES ${valuesClause(entries.length, 6)}`,
      opRows.flat()
    );
    if (options.enqueueFanout) {
      await client.query(
        `INSERT INTO fanout_outbox (page_id, seq, update, update_fingerprint, client_mutation_id, client_created_at_ms, traceparent)
         VALUES ${valuesClause(entries.length, 7)}`,
        opRows.flatMap((row, index) => [...row, entries[index]!.traceparent ?? null])
      );
    }
    await client.query("COMMIT");
    return seqs;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** Single-update convenience wrapper over `appendOps`. */
export async function appendOp(pool: Pool, pageId: string, update: Uint8Array, options: AppendOpOptions = {}): Promise<number> {
  const [seq] = await appendOps(
    pool,
    pageId,
    [{ update, traceparent: options.traceparent, clientMutationId: options.clientMutationId, clientCreatedAtMs: options.clientCreatedAtMs }],
    { enqueueFanout: options.enqueueFanout }
  );
  return seq!;
}

export interface OpRow {
  seq: number;
  update: Uint8Array;
}

export interface OpSummary {
  seq: number;
  createdAt: string;
}

export interface LogicalVersionSummary {
  /** End sequence is retained as `seq` for the existing version/restore API. */
  seq: number;
  startSeq: number;
  endSeq: number;
  editCount: number;
  createdAt: string;
  updatedAt: string;
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

/** Groups the immutable operation history into user-facing versions. The raw
 * log remains one row per accepted Yjs update; this derived view rolls edits
 * into 30-second windows starting at the first edit in each window. Concurrent
 * collaborators therefore share one logical version while replay and restore
 * still address the exact end sequence of that version. */
export function groupOpSummaries(rows: OpSummary[], windowMs = 30_000): LogicalVersionSummary[] {
  const ascending = [...rows].sort((a, b) => a.seq - b.seq);
  const groups: LogicalVersionSummary[] = [];
  for (const row of ascending) {
    const timestamp = Date.parse(row.createdAt);
    const current = groups[groups.length - 1];
    const currentStart = current ? Date.parse(current.createdAt) : Number.NaN;
    if (!current || timestamp - currentStart >= windowMs) {
      groups.push({
        seq: row.seq,
        startSeq: row.seq,
        endSeq: row.seq,
        editCount: 1,
        createdAt: row.createdAt,
        updatedAt: row.createdAt,
      });
      continue;
    }
    current.endSeq = row.seq;
    current.seq = row.seq;
    current.editCount += 1;
    current.updatedAt = row.createdAt;
  }
  return groups.reverse();
}

export async function listLogicalVersionSummaries(pool: Pool, pageId: string): Promise<LogicalVersionSummary[]> {
  return groupOpSummaries(await listOpSummaries(pool, pageId));
}
