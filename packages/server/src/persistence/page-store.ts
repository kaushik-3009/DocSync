import * as Y from "yjs";
import type { Pool } from "pg";
import { appendOp, getCurrentSeq } from "./ops-log.js";
import { saveSnapshot, listSnapshotSeqs, listSnapshots, type SnapshotSummary } from "./snapshots.js";
import { replayDocument } from "./replay.js";
import { childLogger } from "../logger.js";
import { tracer } from "../tracing/tracer.js";

const log = childLogger({ module: "persistence/page-store" });

/** Snapshot every N ops — bounds how many ops replay ever has to re-apply on load. */
const SNAPSHOT_INTERVAL = 50;

/**
 * The persistence-facing API a Room depends on. Everything DB-shaped
 * (connection pooling, transactions, table layout) stays behind this
 * interface so Room/RoomRegistry only ever call `loadPage` / `recordUpdate`
 * / `listVersions` / `replayAt` — matching the seam already drawn around
 * RoomRegistry for Phase 4 (swap the backing registry, not its callers).
 */
export class PageStore {
  constructor(private readonly pool: Pool) {}

  /** Loads (or lazily initializes) a page's current document state and seq. */
  async loadPage(pageId: string): Promise<{ doc: Y.Doc; seq: number }> {
    return replayDocument(this.pool, pageId);
  }

  /**
   * Appends one Yjs update to the ops log and, every SNAPSHOT_INTERVAL ops,
   * writes a fresh snapshot from the caller's current in-memory doc state
   * (cheaper than replaying — the caller already has the merged doc).
   */
  async recordUpdate(pageId: string, update: Uint8Array, currentDocState: () => Uint8Array): Promise<number> {
    return tracer.startActiveSpan("persistence.record_update", { attributes: { "collab.page_id": pageId } }, async (span) => {
      try {
        const seq = await appendOp(this.pool, pageId, update);
        span.setAttribute("collab.seq", seq);
        if (seq % SNAPSHOT_INTERVAL === 0) {
          await saveSnapshot(this.pool, pageId, seq, currentDocState());
          log.info({ event: "snapshot_taken", pageId, seq }, "wrote periodic snapshot");
        }
        return seq;
      } finally {
        span.end();
      }
    });
  }

  async currentSeq(pageId: string): Promise<number> {
    return getCurrentSeq(this.pool, pageId);
  }

  /** Version history: the seqs at which a full snapshot exists, newest first. */
  async listVersions(pageId: string): Promise<number[]> {
    return listSnapshotSeqs(this.pool, pageId);
  }

  /** Same seqs as `listVersions`, plus each one's creation time — what the
   *  version-history UI displays (see `SnapshotSummary`). */
  async listVersionDetails(pageId: string): Promise<SnapshotSummary[]> {
    return listSnapshots(this.pool, pageId);
  }

  /** Reconstructs document state as of a specific seq — the "time travel" read path. */
  async replayAt(pageId: string, seq: number): Promise<Y.Doc> {
    const { doc } = await replayDocument(this.pool, pageId, seq);
    return doc;
  }
}
