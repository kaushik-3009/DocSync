import type { Pool } from "pg";

export interface SnapshotRow {
  seq: number;
  state: Uint8Array;
}

export async function saveSnapshot(pool: Pool, pageId: string, seq: number, state: Uint8Array): Promise<void> {
  await pool.query(
    `INSERT INTO snapshots (page_id, seq, state) VALUES ($1, $2, $3)
     ON CONFLICT (page_id, seq) DO NOTHING`,
    [pageId, seq, Buffer.from(state).toString("base64")]
  );
}

/** Latest snapshot at or before `uptoSeq` (default: latest overall) — the base for replay. */
export async function getLatestSnapshot(pool: Pool, pageId: string, uptoSeq?: number): Promise<SnapshotRow | null> {
  const { rows } = await pool.query<{ seq: string; state: string }>(
    uptoSeq === undefined
      ? `SELECT seq, state FROM snapshots WHERE page_id = $1 ORDER BY seq DESC LIMIT 1`
      : `SELECT seq, state FROM snapshots WHERE page_id = $1 AND seq <= $2 ORDER BY seq DESC LIMIT 1`,
    uptoSeq === undefined ? [pageId] : [pageId, uptoSeq]
  );
  if (rows.length === 0) return null;
  return { seq: Number(rows[0].seq), state: new Uint8Array(Buffer.from(rows[0].state, "base64")) };
}

/** All snapshot seqs for a page, newest first — the raw material for a "version history" list. */
export async function listSnapshotSeqs(pool: Pool, pageId: string): Promise<number[]> {
  // Snapshot rows are sparse replay checkpoints. Version history is a user
  // feature, however, and must include every durable edit; replayAt already
  // supports operation sequences between checkpoints. Keep the fallback for
  // maintenance/test callers that seed a snapshot without an ops-log row.
  const operations = await pool.query<{ seq: string }>(
    `SELECT seq FROM ops_log WHERE page_id = $1 ORDER BY seq DESC`,
    [pageId]
  );
  if (operations.rows.length > 0) return operations.rows.map((r) => Number(r.seq));
  const snapshots = await pool.query<{ seq: string }>(
    `SELECT seq FROM snapshots WHERE page_id = $1 ORDER BY seq DESC`,
    [pageId]
  );
  return snapshots.rows.map((r) => Number(r.seq));
}

export interface SnapshotSummary {
  seq: number;
  createdAt: string;
}

/** Same as `listSnapshotSeqs`, plus each version's creation time — a raw seq
 * number means nothing to a user browsing version history, a real timestamp
 * does. See `listSnapshotSeqs` for why operation rows take precedence over
 * sparse snapshot checkpoints. */
export async function listSnapshots(pool: Pool, pageId: string): Promise<SnapshotSummary[]> {
  const operations = await pool.query<{ seq: string; created_at: string | Date }>(
    `SELECT seq, created_at FROM ops_log WHERE page_id = $1 ORDER BY seq DESC`,
    [pageId]
  );
  const rows = operations.rows.length
    ? operations.rows
    : (
        await pool.query<{ seq: string; created_at: string | Date }>(
          `SELECT seq, created_at FROM snapshots WHERE page_id = $1 ORDER BY seq DESC`,
          [pageId]
        )
      ).rows;
  return rows.map((r) => ({ seq: Number(r.seq), createdAt: new Date(r.created_at).toISOString() }));
}
