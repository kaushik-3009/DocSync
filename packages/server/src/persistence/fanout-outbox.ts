import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { childLogger } from "../logger.js";
import { collabFanoutOutboxTotal, collabFanoutOutboxPending } from "../metrics/registry.js";

const log = childLogger({ module: "fanout-outbox" });

export interface CommittedFanoutUpdate {
  pageId: string;
  seq: number;
  update: Uint8Array;
  /** SHA-256 of the exact Yjs update bytes; not a client-provided UUID. */
  updateFingerprint?: string | null;
  clientMutationId?: string | null;
  clientCreatedAtMs?: number | null;
  traceparent: string | null;
}

/** Implemented by RedisRoomBroadcaster. Publish acknowledgement means Redis
 * accepted the pub/sub command; a crash after that acknowledgement but before
 * `markDelivered` may publish the same Yjs update again, which is safe at the
 * CRDT state layer and deliberately recorded as at-least-once delivery. */
export interface CommittedUpdatePublisher {
  publishCommittedUpdate(update: CommittedFanoutUpdate): Promise<void>;
}

interface OutboxRow {
  page_id: string;
  seq: string;
  update: string;
  update_fingerprint: string | null;
  client_mutation_id: string | null;
  client_created_at_ms: string | number | null;
  traceparent: string | null;
  attempt_count: number;
  available_at: Date;
  lease_expires_at: Date | null;
}

/**
 * Leases and publishes Postgres outbox rows. Claiming is optimistic rather
 * than `FOR UPDATE SKIP LOCKED` so the same SQL works in pg-mem tests; the
 * conditional update makes only one gateway lease any given row. The lease
 * prevents a dead gateway from blocking delivery forever.
 */
export class FanoutOutbox {
  private readonly ownerId = randomUUID();
  private draining: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private closing = false;

  constructor(
    private readonly pool: Pool,
    private readonly publisher: CommittedUpdatePublisher,
    private readonly options: { pollIntervalMs?: number; leaseMs?: number; retryBaseMs?: number } = {}
  ) {}

  start(): void {
    if (this.timer || this.closing) return;
    const pollIntervalMs = this.options.pollIntervalMs ?? 1_000;
    this.timer = setInterval(() => {
      void this.drain().catch((err) => log.error({ event: "outbox_drain_failed", err }, "fanout outbox drain failed"));
    }, pollIntervalMs);
    this.timer.unref();
    void this.drain().catch((err) => log.error({ event: "outbox_initial_drain_failed", err }, "initial fanout outbox drain failed"));
  }

  /** Schedule an immediate best-effort drain after a new operation commits. */
  wake(): void {
    if (this.closing) return;
    void this.drain().catch((err) => log.error({ event: "outbox_wake_drain_failed", err }, "fanout outbox wake drain failed"));
  }

  /** Drain all currently leasable work. Returns after the first publish
   * failure so a Redis outage cannot cause a hot retry loop. */
  drain(): Promise<void> {
    if (this.draining) return this.draining;
    const operation = this.drainLeasedRows();
    const tracked = operation.finally(() => {
      if (this.draining === tracked) this.draining = null;
    });
    this.draining = tracked;
    return tracked;
  }

  /** Stop polling and give already durable outbox rows a bounded final drain. */
  async close(drainTimeoutMs = 5_000): Promise<boolean> {
    this.closing = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const drainCompleted = await Promise.race([
      this.drain().then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), drainTimeoutMs)),
    ]);
    if (!drainCompleted) {
      log.warn({ event: "outbox_shutdown_drain_timed_out", drainTimeoutMs }, "fanout outbox drain timed out during shutdown");
      return false;
    }
    const pending = await this.pendingCount();
    collabFanoutOutboxPending.set(pending);
    if (pending > 0) {
      log.warn({ event: "outbox_shutdown_pending", pending }, "outbox has durable rows pending retry at shutdown");
      return false;
    }
    return true;
  }

  async pendingCount(): Promise<number> {
    const result = await this.pool.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM fanout_outbox WHERE delivered_at IS NULL");
    return Number(result.rows[0]?.count ?? 0);
  }

  private async drainLeasedRows(): Promise<void> {
    while (true) {
      const row = await this.claimNext();
      if (!row) {
        collabFanoutOutboxPending.set(await this.pendingCount());
        return;
      }
      collabFanoutOutboxTotal.inc({ outcome: "claimed" });
      try {
        await this.publisher.publishCommittedUpdate(row);
        await this.markDelivered(row);
        collabFanoutOutboxTotal.inc({ outcome: "delivered" });
      } catch (err) {
        await this.releaseForRetry(row, err);
        collabFanoutOutboxTotal.inc({ outcome: "failed" });
        collabFanoutOutboxPending.set(await this.pendingCount());
        log.error({ event: "outbox_publish_failed", pageId: row.pageId, seq: row.seq, err }, "fanout publish failed; retained outbox row for retry");
        return;
      }
    }
  }

  private async claimNext(): Promise<CommittedFanoutUpdate | null> {
    const now = new Date();
    // Select every page's first undelivered row, then only lease one that is
    // currently available. This preserves page order even if an earlier row
    // is leased by another gateway. The small-batch SQL deliberately avoids
    // `SKIP LOCKED` so deterministic pg-mem tests exercise the same branch;
    // production load tests will set the batch/claim strategy from evidence.
    const candidates = await this.pool.query<OutboxRow>(
      `SELECT page_id, seq, update, update_fingerprint, client_mutation_id, client_created_at_ms, traceparent, attempt_count, available_at, lease_expires_at
       FROM fanout_outbox
       WHERE delivered_at IS NULL
       ORDER BY page_id ASC, seq ASC`
    );
    const seenPages = new Set<string>();
    const row = candidates.rows.find((candidate) => {
      if (seenPages.has(candidate.page_id)) return false;
      seenPages.add(candidate.page_id);
      const availableAt = new Date(candidate.available_at).getTime();
      const leaseExpiresAt = candidate.lease_expires_at ? new Date(candidate.lease_expires_at).getTime() : 0;
      return availableAt <= now.getTime() && (!leaseExpiresAt || leaseExpiresAt <= now.getTime());
    });
    if (!row) return null;

    const leaseExpiresAt = new Date(now.getTime() + (this.options.leaseMs ?? 30_000));
    const claimed = await this.pool.query<OutboxRow>(
      `UPDATE fanout_outbox
       SET lease_owner = $1, lease_expires_at = $2, attempt_count = attempt_count + 1
       WHERE page_id = $3 AND seq = $4 AND delivered_at IS NULL
         AND available_at <= $5
         AND (lease_expires_at IS NULL OR lease_expires_at <= $5)
       RETURNING page_id, seq, update, update_fingerprint, client_mutation_id, client_created_at_ms, traceparent, attempt_count`,
      [this.ownerId, leaseExpiresAt, row.page_id, Number(row.seq), now]
    );
    const claimedRow = claimed.rows[0];
    if (!claimedRow) return null;
    return {
      pageId: claimedRow.page_id,
      seq: Number(claimedRow.seq),
      update: new Uint8Array(Buffer.from(claimedRow.update, "base64")),
      updateFingerprint: claimedRow.update_fingerprint,
      clientMutationId: claimedRow.client_mutation_id,
      clientCreatedAtMs: claimedRow.client_created_at_ms === null ? null : Number(claimedRow.client_created_at_ms),
      traceparent: claimedRow.traceparent,
    };
  }

  private async markDelivered(row: CommittedFanoutUpdate): Promise<void> {
    await this.pool.query(
      `UPDATE fanout_outbox
       SET delivered_at = $1, lease_owner = NULL, lease_expires_at = NULL, last_error = NULL
       WHERE page_id = $2 AND seq = $3 AND lease_owner = $4`,
      [new Date(), row.pageId, row.seq, this.ownerId]
    );
  }

  private async releaseForRetry(row: CommittedFanoutUpdate, error: unknown): Promise<void> {
    const lastError = error instanceof Error ? error.message.slice(0, 1_000) : String(error).slice(0, 1_000);
    const attempts = await this.pool.query<{ attempt_count: number }>(
      "SELECT attempt_count FROM fanout_outbox WHERE page_id = $1 AND seq = $2",
      [row.pageId, row.seq]
    );
    const retryDelayMs = Math.min(
      30_000,
      (this.options.retryBaseMs ?? 1_000) * 2 ** Math.max(0, Number(attempts.rows[0]?.attempt_count ?? 1) - 1)
    );
    await this.pool.query(
      `UPDATE fanout_outbox
       SET lease_owner = NULL, lease_expires_at = NULL, available_at = $1, last_error = $2
       WHERE page_id = $3 AND seq = $4 AND lease_owner = $5`,
      [new Date(Date.now() + retryDelayMs), lastError, row.pageId, row.seq, this.ownerId]
    );
  }
}
