import * as Y from "yjs";
import type { Pool } from "pg";
import { appendOp, getCurrentSeq, getOpsInRange, listLogicalVersionSummaries, listOpSummaries, type LogicalVersionSummary, type OpRow, type OpSummary } from "./ops-log.js";
import { saveSnapshot } from "./snapshots.js";
import { replayDocument } from "./replay.js";
import { childLogger } from "../logger.js";
import { tracer } from "../tracing/tracer.js";
import { currentTraceparent } from "../tracing/propagation.js";

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
  async recordUpdate(
    pageId: string,
    update: Uint8Array,
    currentDocState: () => Uint8Array,
    options: { enqueueFanout?: boolean; clientMutationId?: string; clientCreatedAtMs?: number } = {}
  ): Promise<number> {
    return tracer.startActiveSpan("persistence.record_update", { attributes: { "collab.page_id": pageId } }, async (span) => {
      try {
        const seq = await appendOp(this.pool, pageId, update, {
          enqueueFanout: options.enqueueFanout,
          traceparent: options.enqueueFanout ? currentTraceparent() ?? undefined : undefined,
          clientMutationId: options.clientMutationId,
          clientCreatedAtMs: options.clientCreatedAtMs,
        });
        span.setAttribute("collab.seq", seq);
        if (seq % SNAPSHOT_INTERVAL === 0) {
          try {
            await saveSnapshot(this.pool, pageId, seq, currentDocState());
            log.info({ event: "snapshot_taken", pageId, seq }, "wrote periodic snapshot");
          } catch (err) {
            // The operation and (when enabled) outbox row already committed.
            // Treating a later optimization failure as a mutation failure would
            // close the source and misreport a durable update as rejected.
            log.error({ event: "snapshot_failed_after_commit", pageId, seq, err }, "snapshot failed after durable op commit; replay remains available from ops log");
          }
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

  /** Durable range used to repair an active replica that detects a Redis
   * Pub/Sub sequence gap. */
  async getOpsInRange(pageId: string, afterSeq: number, uptoSeq: number): Promise<OpRow[]> {
    return getOpsInRange(this.pool, pageId, afterSeq, uptoSeq);
  }

  /** Version history: every durable operation, newest first. */
  async listVersions(pageId: string): Promise<number[]> {
    const versions = await listOpSummaries(this.pool, pageId);
    return versions.map((version) => version.seq);
  }

  /** Same versions as `listVersions`, plus creation time for the UI. */
  async listVersionDetails(pageId: string): Promise<OpSummary[]> {
    return listOpSummaries(this.pool, pageId);
  }

  /** User-facing history groups rapid durable operations into logical edits. */
  async listLogicalVersionDetails(pageId: string): Promise<LogicalVersionSummary[]> {
    return listLogicalVersionSummaries(this.pool, pageId);
  }

  /** Reconstructs document state as of a specific seq — the "time travel" read path. */
  async replayAt(pageId: string, seq: number): Promise<Y.Doc> {
    const { doc } = await replayDocument(this.pool, pageId, seq);
    return doc;
  }
}
