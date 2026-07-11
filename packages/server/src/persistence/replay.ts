import * as Y from "yjs";
import type { Pool } from "pg";
import { getLatestSnapshot } from "./snapshots.js";
import { getOpsInRange } from "./ops-log.js";

/**
 * Reconstructs a page's document state as of `uptoSeq` (or the latest
 * known state if omitted): start from the newest snapshot at or before
 * that point, then replay every op after it in order. This is the one
 * function both "load a page on room startup" and "view version history at
 * an earlier point" share — a snapshot is just a replay checkpoint, never
 * a different code path.
 */
export async function replayDocument(pool: Pool, pageId: string, uptoSeq?: number): Promise<{ doc: Y.Doc; seq: number }> {
  const doc = new Y.Doc();
  const snapshot = await getLatestSnapshot(pool, pageId, uptoSeq);
  let seq = 0;

  if (snapshot) {
    Y.applyUpdate(doc, snapshot.state);
    seq = snapshot.seq;
  }

  const ops = await getOpsInRange(pool, pageId, seq, uptoSeq);
  for (const op of ops) {
    Y.applyUpdate(doc, op.update);
    seq = op.seq;
  }

  return { doc, seq };
}
