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
 * the row is marked delivered may publish the same Yjs update again, which is
 * safe (receivers drop already-applied sequences) and is deliberately
 * at-least-once delivery. */
export interface CommittedUpdatePublisher {
  publishCommittedUpdate(update: CommittedFanoutUpdate): Promise<void>;
}

export interface FanoutOutboxOptions {
  /** How often the sweeper looks for orphaned rows. */
  pollIntervalMs?: number;
  /** Rows younger than this are left to the committing gateway's fast path. */
  sweepGraceMs?: number;
  leaseMs?: number;
  retryBaseMs?: number;
  /** Rows claimed per sweeper round trip. */
  claimBatchSize?: number;
  /** Delivered rows older than this are deleted. */
  retentionMs?: number;
  pruneIntervalMs?: number;
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
}

const RETURNING_COLUMNS = "page_id, seq, update, update_fingerprint, client_mutation_id, client_created_at_ms, traceparent, attempt_count";

function fromRow(row: OutboxRow): CommittedFanoutUpdate & { attemptCount: number } {
  return {
    pageId: row.page_id,
    seq: Number(row.seq),
    update: new Uint8Array(Buffer.from(row.update, "base64")),
    updateFingerprint: row.update_fingerprint,
    clientMutationId: row.client_mutation_id,
    clientCreatedAtMs: row.client_created_at_ms === null ? null : Number(row.client_created_at_ms),
    traceparent: row.traceparent,
    attemptCount: row.attempt_count,
  };
}

/** `(page_id = $a AND seq = $b) OR ...` — row-value IN lists are not portable
 * to pg-mem, which the unit tests use. */
function rowKeyPredicate(rows: Array<{ pageId: string; seq: number }>, firstParam: number): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const clauses = rows.map((row) => {
    params.push(row.pageId, row.seq);
    return `(page_id = $${firstParam + params.length - 2} AND seq = $${firstParam + params.length - 1})`;
  });
  return { sql: `(${clauses.join(" OR ")})`, params };
}

/**
 * Delivers committed updates from the Postgres outbox to Redis.
 *
 * Fast path: the gateway that committed a batch calls `publishCommitted`
 * immediately after COMMIT and marks the rows delivered with one query — no
 * polling and no claim round trips on the hot path.
 *
 * Recovery path: a sweeper claims rows the fast path did not deliver (Redis
 * publish failed, or the committing gateway died) once they are older than
 * `sweepGraceMs`. Claiming is a conditional UPDATE, which Postgres re-checks
 * after acquiring each row lock, so only one sweeper leases a given row; the
 * lease lets a dead sweeper's rows be retried. Delivered rows are pruned after
 * `retentionMs` so the table stays small.
 */
export class FanoutOutbox {
  private readonly ownerId = randomUUID();
  private sweeping: Promise<void> | null = null;
  private readonly inFlight = new Set<Promise<void>>();
  private pollTimer: NodeJS.Timeout | null = null;
  private pruneTimer: NodeJS.Timeout | null = null;
  private closing = false;

  constructor(
    private readonly pool: Pool,
    private readonly publisher: CommittedUpdatePublisher,
    private readonly options: FanoutOutboxOptions = {}
  ) {}

  start(): void {
    if (this.pollTimer || this.closing) return;
    const sweep = () =>
      void this.drain({ minAgeMs: this.options.sweepGraceMs ?? 2_000 }).catch((err) =>
        log.error({ event: "outbox_sweep_failed", err }, "fanout outbox sweep failed")
      );
    this.pollTimer = setInterval(sweep, this.options.pollIntervalMs ?? 1_000);
    this.pollTimer.unref();
    this.pruneTimer = setInterval(() => {
      void this.prune().catch((err) => log.error({ event: "outbox_prune_failed", err }, "fanout outbox prune failed"));
    }, this.options.pruneIntervalMs ?? 60_000);
    this.pruneTimer.unref();
    sweep();
  }

  /**
   * Fast path, called by a Room right after its commit with that commit's rows
   * in sequence order. Publishes are issued back to back on one Redis
   * connection, which preserves their order, then acknowledged together.
   * Never throws: undelivered rows stay in the outbox for the sweeper.
   */
  publishCommitted(rows: CommittedFanoutUpdate[]): Promise<void> {
    if (rows.length === 0 || this.closing) return Promise.resolve();
    const operation = (async () => {
      const results = await Promise.allSettled(rows.map((row) => this.publisher.publishCommittedUpdate(row)));
      const delivered = rows.filter((_, index) => results[index]!.status === "fulfilled");
      collabFanoutOutboxTotal.inc({ outcome: "delivered" }, delivered.length);
      const failures = rows.length - delivered.length;
      if (failures > 0) {
        collabFanoutOutboxTotal.inc({ outcome: "failed" }, failures);
        const firstError = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
        log.warn(
          { event: "outbox_fast_path_publish_failed", failures, err: firstError.reason },
          "left committed updates for the outbox sweeper"
        );
      }
      if (delivered.length > 0) await this.markDelivered(delivered, null);
    })().catch((err) => {
      log.error({ event: "outbox_fast_path_ack_failed", err }, "failed to acknowledge published outbox rows; sweeper will republish");
    });
    this.inFlight.add(operation);
    void operation.finally(() => this.inFlight.delete(operation));
    return operation;
  }

  /** Sweep every row that is currently leasable and at least `minAgeMs` old.
   * Concurrent callers share one sweep. Returns after the first publish
   * failure so a Redis outage cannot cause a hot retry loop. */
  drain(options: { minAgeMs?: number } = {}): Promise<void> {
    if (this.sweeping) return this.sweeping;
    const operation = this.sweepLeasableRows(options.minAgeMs ?? 0);
    const tracked = operation.finally(() => {
      if (this.sweeping === tracked) this.sweeping = null;
    });
    this.sweeping = tracked;
    return tracked;
  }

  /** Stop the timers, let fast-path publishes finish, and give remaining
   * durable rows a bounded final sweep. Returns whether nothing is pending. */
  async close(drainTimeoutMs = 5_000): Promise<boolean> {
    this.closing = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.pollTimer = null;
    this.pruneTimer = null;
    const drainCompleted = await Promise.race([
      Promise.allSettled([...this.inFlight])
        .then(() => this.drain())
        .then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), drainTimeoutMs).unref()),
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

  /** Deletes delivered rows past the retention window. */
  async prune(retentionMs = this.options.retentionMs ?? 60 * 60 * 1_000): Promise<number> {
    const result = await this.pool.query("DELETE FROM fanout_outbox WHERE delivered_at IS NOT NULL AND delivered_at < $1", [
      new Date(Date.now() - retentionMs),
    ]);
    const deleted = result.rowCount ?? 0;
    if (deleted > 0) log.info({ event: "outbox_pruned", deleted }, "pruned delivered outbox rows");
    return deleted;
  }

  private async sweepLeasableRows(minAgeMs: number): Promise<void> {
    while (true) {
      const rows = await this.claimBatch(minAgeMs);
      if (rows.length === 0) break;
      collabFanoutOutboxTotal.inc({ outcome: "claimed" }, rows.length);
      for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index]!;
        try {
          await this.publisher.publishCommittedUpdate(row);
        } catch (err) {
          const delivered = rows.slice(0, index);
          if (delivered.length > 0) await this.markDelivered(delivered, this.ownerId);
          collabFanoutOutboxTotal.inc({ outcome: "delivered" }, delivered.length);
          await this.releaseForRetry(rows.slice(index), err);
          collabFanoutOutboxTotal.inc({ outcome: "failed" });
          log.error(
            { event: "outbox_publish_failed", pageId: row.pageId, seq: row.seq, err },
            "fanout publish failed; retained outbox rows for retry"
          );
          collabFanoutOutboxPending.set(await this.pendingCount());
          return;
        }
      }
      await this.markDelivered(rows, this.ownerId);
      collabFanoutOutboxTotal.inc({ outcome: "delivered" }, rows.length);
    }
    collabFanoutOutboxPending.set(await this.pendingCount());
  }

  private async claimBatch(minAgeMs: number): Promise<Array<CommittedFanoutUpdate & { attemptCount: number }>> {
    const now = new Date();
    const candidates = await this.pool.query<{ page_id: string; seq: string }>(
      `SELECT page_id, seq FROM fanout_outbox
       WHERE delivered_at IS NULL
         AND created_at <= $1
         AND available_at <= $2
         AND (lease_expires_at IS NULL OR lease_expires_at <= $2)
       ORDER BY page_id ASC, seq ASC
       LIMIT ${Math.max(1, Math.floor(this.options.claimBatchSize ?? 100))}`,
      [new Date(now.getTime() - minAgeMs), now]
    );
    if (candidates.rows.length === 0) return [];

    const keys = rowKeyPredicate(
      candidates.rows.map((row) => ({ pageId: row.page_id, seq: Number(row.seq) })),
      4
    );
    const claimed = await this.pool.query<OutboxRow>(
      `UPDATE fanout_outbox
       SET lease_owner = $1, lease_expires_at = $2, attempt_count = attempt_count + 1
       WHERE ${keys.sql}
         AND delivered_at IS NULL
         AND (lease_expires_at IS NULL OR lease_expires_at <= $3)
       RETURNING ${RETURNING_COLUMNS}`,
      [this.ownerId, new Date(now.getTime() + (this.options.leaseMs ?? 30_000)), now, ...keys.params]
    );
    return claimed.rows.map(fromRow).sort((a, b) => (a.pageId === b.pageId ? a.seq - b.seq : a.pageId < b.pageId ? -1 : 1));
  }

  /** `leaseOwner` null acknowledges fast-path rows that were never leased. */
  private async markDelivered(rows: Array<{ pageId: string; seq: number }>, leaseOwner: string | null): Promise<void> {
    const keys = rowKeyPredicate(rows, 2);
    await this.pool.query(
      `UPDATE fanout_outbox
       SET delivered_at = $1, lease_owner = NULL, lease_expires_at = NULL, last_error = NULL
       WHERE ${keys.sql} AND delivered_at IS NULL${leaseOwner ? ` AND lease_owner = $${keys.params.length + 2}` : ""}`,
      leaseOwner ? [new Date(), ...keys.params, leaseOwner] : [new Date(), ...keys.params]
    );
  }

  private async releaseForRetry(rows: Array<CommittedFanoutUpdate & { attemptCount: number }>, error: unknown): Promise<void> {
    const lastError = error instanceof Error ? error.message.slice(0, 1_000) : String(error).slice(0, 1_000);
    const attempts = Math.max(...rows.map((row) => row.attemptCount));
    const retryDelayMs = Math.min(30_000, (this.options.retryBaseMs ?? 1_000) * 2 ** Math.max(0, attempts - 1));
    const keys = rowKeyPredicate(rows, 4);
    await this.pool.query(
      `UPDATE fanout_outbox
       SET lease_owner = NULL, lease_expires_at = NULL, available_at = $1, last_error = $2
       WHERE ${keys.sql} AND lease_owner = $3`,
      [new Date(Date.now() + retryDelayMs), lastError, this.ownerId, ...keys.params]
    );
  }
}
