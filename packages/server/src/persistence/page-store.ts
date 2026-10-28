import type * as Y from "yjs";
import type { Pool } from "pg";
import {
  appendOps,
  getCurrentSeq,
  getOpsInRange,
  listLogicalVersionSummaries,
  listOpSummaries,
  type AppendEntry,
  type LogicalVersionSummary,
  type OpRow,
  type OpSummary,
} from "./ops-log.js";
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

  /** Single-update form of `recordUpdates`. */
  async recordUpdate(
    pageId: string,
    update: Uint8Array,
    currentDocState: () => Uint8Array,
    options: { enqueueFanout?: boolean; clientMutationId?: string; clientCreatedAtMs?: number } = {}
  ): Promise<number> {
    const [seq] = await this.recordUpdates(
      pageId,
      [
        {
          update,
          traceparent: options.enqueueFanout ? (currentTraceparent() ?? undefined) : undefined,
          clientMutationId: options.clientMutationId,
          clientCreatedAtMs: options.clientCreatedAtMs,
        },
      ],
      currentDocState,
      { enqueueFanout: options.enqueueFanout }
    );
    return seq!;
  }

  /**
   * Appends a batch of Yjs updates in one transaction (group commit) and, when
   * the batch crosses a SNAPSHOT_INTERVAL boundary, writes a snapshot at the
   * batch's last sequence from the caller's merged doc state — cheaper than
   * replaying, since the caller already holds the document.
   */
  async recordUpdates(
    pageId: string,
    entries: AppendEntry[],
    currentDocState: () => Uint8Array,
    options: { enqueueFanout?: boolean } = {}
  ): Promise<number[]> {
    return tracer.startActiveSpan(
      "persistence.record_updates",
      { attributes: { "collab.page_id": pageId, "collab.batch_size": entries.length } },
      async (span) => {
        try {
          const seqs = await appendOps(this.pool, pageId, entries, options);
          const firstSeq = seqs[0]!;
          const lastSeq = seqs[seqs.length - 1]!;
          span.setAttribute("collab.seq", lastSeq);
          if (Math.floor(lastSeq / SNAPSHOT_INTERVAL) > Math.floor((firstSeq - 1) / SNAPSHOT_INTERVAL)) {
            try {
              await saveSnapshot(this.pool, pageId, lastSeq, currentDocState());
              log.info({ event: "snapshot_taken", pageId, seq: lastSeq }, "wrote periodic snapshot");
            } catch (err) {
              // The operations (and outbox rows) already committed. Treating a
              // later optimization failure as a mutation failure would close
              // the sources and misreport durable updates as rejected.
              log.error(
                { event: "snapshot_failed_after_commit", pageId, seq: lastSeq, err },
                "snapshot failed after durable op commit; replay remains available from ops log"
              );
            }
          }
          return seqs;
        } finally {
          span.end();
        }
      }
    );
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
