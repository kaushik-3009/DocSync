import * as Y from "yjs";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import * as syncProtocol from "y-protocols/sync";
import { Awareness, encodeAwarenessUpdate, applyAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness";
import type { WebSocket } from "ws";
import { context, trace, type Context, type Link } from "@opentelemetry/api";
import { MessageType, getCommentsMap, extractMentionEmails, type ClientMutationMetadata } from "@collab/shared";
import { childLogger } from "./logger.js";
import type { PageStore } from "./persistence/page-store.js";
import { updateFingerprint } from "./persistence/ops-log.js";
import { clientIdsInUpdate } from "./authorship/attribution.js";
import type { RoomBroadcaster } from "./redis/broadcaster.js";
import type { JobQueues } from "./jobs/queues.js";
import type { MentionsStore } from "./comments/mentions-store.js";
import type { Role } from "@collab/shared";
import { tracer } from "./tracing/tracer.js";
import { currentTraceparent } from "./tracing/propagation.js";
import { collabCommitBatchSize, collabUpdateDurabilitySeconds, collabUpdatesPending, collabUpdatesTotal } from "./metrics/registry.js";
import type { FanoutOutbox } from "./persistence/fanout-outbox.js";

/** Transaction/awareness origin for updates that arrived from another gateway
 *  via Redis. They are already durable, so they are never re-persisted or
 *  re-published (which would double-write the ops log and echo forever). */
export const REMOTE_ORIGIN = Symbol("redis-remote-origin");

/** Re-checks the authoritative page roles immediately before queued client
 * mutations cross the durable admission boundary. The WebSocket handshake
 * role is only a snapshot; an owner can revoke/downgrade it while the socket
 * remains open. Batched so a group commit costs one lookup, not one per edit.
 * Users without a grant are absent from the returned map. */
export type MutationAuthorizer = (pageId: string, userIds: string[]) => Promise<Map<string, Role>>;

export class MutationAuthorizationError extends Error {
  constructor() {
    super("page permission no longer allows mutations");
    this.name = "MutationAuthorizationError";
  }
}

/** Optional collaborators. Each is absent in narrower deployments and tests:
 * no `pageStore` means in-memory only, no `broadcaster` means single gateway,
 * no `mutationAuthorizer` means auth is disabled. */
export interface RoomDependencies {
  pageStore?: PageStore | null;
  broadcaster?: RoomBroadcaster | null;
  jobQueues?: JobQueues | null;
  mentionsStore?: MentionsStore | null;
  fanoutOutbox?: FanoutOutbox | null;
  mutationAuthorizer?: MutationAuthorizer | null;
  /** Records which user each Yjs client id belongs to (authorship view). */
  authorship?: { record(pageId: string, entries: Array<{ clientId: number; userId: string }>): Promise<void> } | null;
  /** Upper bounds for one group commit. */
  maxBatchUpdates?: number;
  maxBatchBytes?: number;
}

const DEFAULT_MAX_BATCH_UPDATES = 256;
const DEFAULT_MAX_BATCH_BYTES = 4 * 1024 * 1024;

/**
 * Marks the *application* of a client update that already committed to the
 * append-only log. It carries the sender so the gateway can fan the update
 * out to every other client without echoing it back to the optimistic sender.
 *
 * This is deliberately different from using the WebSocket as the Yjs origin:
 * the latter means the update was applied before persistence, which is exactly
 * the acknowledged-versus-durable gap this marker closes.
 */
const DURABLE_UPDATE_ORIGIN = Symbol("durable-update-origin");

interface DurableUpdateOrigin {
  [DURABLE_UPDATE_ORIGIN]: true;
  source?: WebSocket;
}

function isDurableUpdateOrigin(origin: unknown): origin is DurableUpdateOrigin {
  return typeof origin === "object" && origin !== null && DURABLE_UPDATE_ORIGIN in origin;
}

/** One update waiting for the next group commit. */
interface PendingMutation {
  update: Uint8Array;
  source?: WebSocket;
  metadata?: ClientMutationMetadata;
  /** Captured at admission so each outbox row continues its own edit's trace. */
  traceparent?: string;
  traceContext: Context;
  /** Set for server-side writes that mutated the live Y.Doc directly; they
   *  are persisted and then broadcast, never re-applied. */
  alreadyAppliedOrigin?: { origin: unknown };
  admittedAt: bigint;
  resolve: (seq: number) => void;
  reject: (err: unknown) => void;
}

/**
 * A Room owns one Y.Doc (and its Awareness) for one pageId plus the sockets
 * connected to it on this gateway. It knows nothing about HTTP or upgrade
 * routing.
 *
 * Durability: with a PageStore, client updates are appended to the ops log
 * *before* they are applied to this Room or sent to any other client/replica.
 * The sender stays optimistic in its own browser Y.Doc; a failed append closes
 * that connection so y-websocket reconnects and replays its local state.
 *
 * Throughput: admission is a group commit. Updates that arrive while a
 * transaction is in flight queue up and are committed together in the next
 * one, so a busy page pays one transaction per batch instead of per keystroke,
 * while an idle page still commits a lone update immediately (no added delay).
 *
 * Fanout: with a broadcaster, committed updates reach other gateways through
 * the Postgres outbox → Redis; updates arriving from Redis are applied with
 * REMOTE_ORIGIN and only fan out to this gateway's local sockets.
 */
export class Room {
  readonly pageId: string;
  readonly doc: Y.Doc;
  readonly awareness: Awareness;
  private readonly conns = new Set<WebSocket>();
  private readonly log;
  private readonly pageStore: PageStore | null;
  private readonly broadcaster: RoomBroadcaster | null;
  private readonly jobQueues: JobQueues | null;
  private readonly mentionsStore: MentionsStore | null;
  private readonly fanoutOutbox: FanoutOutbox | null;
  private readonly mutationAuthorizer: MutationAuthorizer | null;
  private readonly authorship: RoomDependencies["authorship"];
  /** Client ids already attributed from this room, so each is written once. */
  private readonly attributedClientIds = new Set<number>();
  private readonly maxBatchUpdates: number;
  private readonly maxBatchBytes: number;
  private lastPersistedSeq: number;
  /** Highest contiguous sequence applied to this Room's Y.Doc. This can lag
   * `lastPersistedSeq` while a local gateway commit is ahead of a missing
   * cross-gateway Redis envelope. */
  private lastContiguousSeq: number;
  /** Local appends can commit a higher page sequence before this room has
   * observed lower sequences committed by another gateway. Keep only those
   * out-of-order sequence numbers so Redis gap repair can distinguish an
   * already-applied local operation from a genuinely missing one. */
  private readonly outOfOrderAppliedSeqs = new Set<number>();
  /** Last-seen text per comment id, so a comment is only re-scanned for
   *  @mentions when its text changes. A tracked id missing from the live
   *  comments map means the comment was deleted, which triggers cleanup of its
   *  indexed mentions. Resets with the Room; recordMentions' ON CONFLICT DO
   *  NOTHING makes the resulting re-scan harmless. */
  private readonly lastScannedCommentText = new Map<string, string>();
  /** Which awareness clientIDs a given socket has published — the only way to know which
   *  awareness states to clear when that socket disconnects, since awareness clientIDs
   *  are chosen client-side and never otherwise reported to us. */
  private readonly awarenessClientIdsByConnection = new Map<WebSocket, Set<number>>();
  /** Role granted at join time. Absent when auth is disabled. */
  private readonly rolesByConnection = new Map<WebSocket, Role>();
  private readonly userIdsByConnection = new Map<WebSocket, string>();
  /** Updates admitted but not yet committed, in arrival order. */
  private pendingMutations: PendingMutation[] = [];
  /** The single in-flight commit loop; at most one per Room keeps page order. */
  private committing: Promise<void> | null = null;
  /** Ordered independently from local admission: a committed Redis envelope
   * can reveal a missing seq that must be replayed before a later envelope is
   * exposed to this instance's local clients. */
  private remoteUpdateQueue: Promise<void> = Promise.resolve();
  /** A source whose append failed may have sent more frames before it observed
   * the close. Drop those queued frames rather than persisting an update that
   * may causally depend on the failed one. */
  private readonly rejectedMutationConnections = new Set<WebSocket>();
  /** Optional metadata queued by the benchmark/client immediately before one
   * Sync update. Standard y-websocket clients leave this empty. */
  private readonly pendingMutationMetadata = new Map<WebSocket, ClientMutationMetadata>();
  private shuttingDown = false;
  private readonly onDocUpdate: (update: Uint8Array, origin: unknown) => void;
  private readonly onAwarenessUpdate: (changes: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => void;

  constructor(pageId: string, initialDoc: Y.Doc, initialSeq: number, dependencies: RoomDependencies = {}) {
    this.pageId = pageId;
    this.doc = initialDoc;
    this.awareness = new Awareness(this.doc);
    this.log = childLogger({ pageId });
    this.pageStore = dependencies.pageStore ?? null;
    this.broadcaster = dependencies.broadcaster ?? null;
    this.jobQueues = dependencies.jobQueues ?? null;
    this.mentionsStore = dependencies.mentionsStore ?? null;
    this.fanoutOutbox = dependencies.fanoutOutbox ?? null;
    this.mutationAuthorizer = dependencies.mutationAuthorizer ?? null;
    this.authorship = dependencies.authorship ?? null;
    this.maxBatchUpdates = dependencies.maxBatchUpdates ?? DEFAULT_MAX_BATCH_UPDATES;
    this.maxBatchBytes = dependencies.maxBatchBytes ?? DEFAULT_MAX_BATCH_BYTES;
    this.lastPersistedSeq = initialSeq;
    this.lastContiguousSeq = initialSeq;

    this.onDocUpdate = (update: Uint8Array, origin: unknown) => {
      const isRemote = origin === REMOTE_ORIGIN;
      // "room.doc_update" for a local edit, or "room.apply_remote_update" for
      // one that arrived via Redis — the latter continues the originating
      // gateway's trace through the traceparent carried in the Redis frame.
      const span = tracer.startSpan(isRemote ? "room.apply_remote_update" : "room.doc_update", {
        attributes: { "collab.page_id": this.pageId, "collab.update_bytes": update.length },
      });
      span.setAttribute("collab.update_fingerprint", updateFingerprint(update));
      context.with(trace.setSpan(context.active(), span), () => {
        if (isRemote) {
          // Already durable; reach only this gateway's local clients.
          this.broadcastUpdate(update, undefined, false);
          span.end();
          return;
        }

        if (isDurableUpdateOrigin(origin)) {
          this.broadcastUpdate(update, origin.source);
          span.end();
          return;
        }

        if (!this.pageStore) {
          this.broadcastUpdate(update, this.conns.has(origin as WebSocket) ? (origin as WebSocket) : undefined);
          span.end();
          return;
        }

        // A direct Y.Doc mutation (test helpers, legacy callers) cannot be
        // pre-admitted like a wire update, but it must still obey the
        // no-fanout-before-commit rule.
        this.enqueueAlreadyAppliedUpdate(update, origin).finally(() => span.end());
      });
    };
    this.doc.on("update", this.onDocUpdate);

    this.onAwarenessUpdate = ({ added, updated, removed }, origin) => {
      const changedClients = added.concat(updated, removed);
      const encodedUpdate = encodeAwarenessUpdate(this.awareness, changedClients);
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MessageType.Awareness);
      encoding.writeVarUint8Array(encoder, encodedUpdate);
      const excludeWs = this.conns.has(origin as WebSocket) ? (origin as WebSocket) : undefined;
      this.broadcast(encoding.toUint8Array(encoder), excludeWs);

      if (origin && this.conns.has(origin as WebSocket)) {
        const ws = origin as WebSocket;
        const ids = this.awarenessClientIdsByConnection.get(ws) ?? new Set<number>();
        for (const id of added.concat(updated)) ids.add(id);
        for (const id of removed) ids.delete(id);
        this.awarenessClientIdsByConnection.set(ws, ids);
      }

      if (origin !== REMOTE_ORIGIN) {
        this.broadcaster?.publishAwareness(this.pageId, encodedUpdate);
      }
    };
    this.awareness.on("update", this.onAwarenessUpdate);
  }

  /** Applies an update received from another instance via Redis to this instance's local doc.
   *  Tagging with REMOTE_ORIGIN is what stops the update/awareness handlers above from
   *  re-publishing it or re-persisting it. */
  applyRemoteUpdate(update: Uint8Array, seq?: number): void {
    if (seq === undefined) {
      // Unsequenced frame from the direct (non-outbox) broadcaster used by
      // in-memory deployments and tests.
      Y.applyUpdate(this.doc, update, REMOTE_ORIGIN);
      return;
    }
    this.remoteUpdateQueue = this.remoteUpdateQueue
      .catch(() => undefined)
      .then(() => this.applySequencedRemoteUpdate(update, seq))
      .catch((err) => {
        this.log.error({ event: "remote_gap_repair_failed", seq, err }, "failed to repair sequenced Redis update gap");
      });
  }

  private async applySequencedRemoteUpdate(update: Uint8Array, seq: number): Promise<void> {
    if (seq <= this.lastContiguousSeq || this.outOfOrderAppliedSeqs.has(seq)) {
      this.log.debug({ event: "remote_duplicate_dropped", seq }, "dropped already-applied committed Redis update");
      return;
    }
    if (!this.pageStore) {
      Y.applyUpdate(this.doc, update, REMOTE_ORIGIN);
      this.markAppliedSeq(seq);
      return;
    }
    if (seq === this.lastContiguousSeq + 1) {
      // Common case: the next expected sequence. No gap, no read.
      Y.applyUpdate(this.doc, update, REMOTE_ORIGIN);
      this.markAppliedSeq(seq);
      return;
    }

    const missing = await this.pageStore.getOpsInRange(this.pageId, this.lastContiguousSeq, seq);
    if (missing.length === 0 || missing[missing.length - 1]!.seq !== seq) {
      throw new Error(`durable operation range does not reach received seq ${seq}`);
    }
    this.applyDurableRange(missing);
    this.log.warn(
      { event: "remote_gap_repaired", fromSeq: missing[0]!.seq, toSeq: seq, operationCount: missing.length },
      "replayed missing durable operations after Redis sequence gap"
    );
  }

  /** Applies a contiguous range of durable operations, skipping ones this
   * gateway already applied out of order (its own local commits). */
  private applyDurableRange(operations: Array<{ seq: number; update: Uint8Array }>): void {
    const alreadyApplied = new Set(this.outOfOrderAppliedSeqs);
    for (const operation of operations) {
      if (operation.seq <= this.lastContiguousSeq) continue;
      if (!alreadyApplied.has(operation.seq)) {
        Y.applyUpdate(this.doc, operation.update, REMOTE_ORIGIN);
      }
      this.markAppliedSeq(operation.seq);
    }
  }

  /** Reconcile a quiet active room after its Redis subscription reconnects.
   * Unlike gap repair, this runs even when no later envelope arrives to make a
   * missed sequence observable. */
  async reconcileFromStore(): Promise<void> {
    if (!this.pageStore) return;
    this.remoteUpdateQueue = this.remoteUpdateQueue
      .catch(() => undefined)
      .then(async () => {
        const currentSeq = await this.pageStore!.currentSeq(this.pageId);
        if (currentSeq <= this.lastContiguousSeq) return;
        const missing = await this.pageStore!.getOpsInRange(this.pageId, this.lastContiguousSeq, currentSeq);
        if (missing.length === 0 || missing[missing.length - 1]!.seq !== currentSeq) {
          throw new Error(`durable operation range does not reach current seq ${currentSeq}`);
        }
        this.applyDurableRange(missing);
        this.log.warn(
          { event: "room_reconciled_after_redis_reconnect", fromSeq: missing[0]!.seq, toSeq: currentSeq, operationCount: missing.length },
          "replayed durable operations after Redis subscription reconnect"
        );
      });
    await this.remoteUpdateQueue;
  }

  applyRemoteAwareness(encoded: Uint8Array): void {
    applyAwarenessUpdate(this.awareness, encoded, REMOTE_ORIGIN);
  }

  get connectionCount(): number {
    return this.conns.size;
  }

  /** Records an applied operation and advances the contiguous page cursor.
   * With two gateways a local append can legitimately commit seq=10 while
   * this room has not yet received seq=9 from Redis. `lastPersistedSeq` is
   * the highest durable sequence observed; `lastContiguousSeq` drives repair. */
  private markAppliedSeq(seq: number): void {
    if (seq > this.lastPersistedSeq) this.lastPersistedSeq = seq;
    if (seq <= this.lastContiguousSeq) return;
    this.outOfOrderAppliedSeqs.add(seq);
    while (this.outOfOrderAppliedSeqs.delete(this.lastContiguousSeq + 1)) {
      this.lastContiguousSeq += 1;
    }
  }

  /** Highest seq we've confirmed is durable — best-effort, lags in-memory state under load. */
  get persistedSeq(): number {
    return this.lastPersistedSeq;
  }

  addConnection(ws: WebSocket, role: Role | null = null, userId: string | null = null): void {
    this.conns.add(ws);
    if (role) this.rolesByConnection.set(ws, role);
    if (userId) this.userIdsByConnection.set(ws, userId);
    this.log.info({ event: "connection_added", connections: this.conns.size, role }, "client joined room");

    // Initial handshake: tell the new client our state vector so it can
    // compute (and later send us) exactly the updates it's missing.
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MessageType.Sync);
    syncProtocol.writeSyncStep1(encoder, this.doc);
    ws.send(encoding.toUint8Array(encoder));

    if (this.awareness.getStates().size > 0) {
      const awarenessEncoder = encoding.createEncoder();
      encoding.writeVarUint(awarenessEncoder, MessageType.Awareness);
      encoding.writeVarUint8Array(awarenessEncoder, encodeAwarenessUpdate(this.awareness, Array.from(this.awareness.getStates().keys())));
      ws.send(encoding.toUint8Array(awarenessEncoder));
    }
  }

  removeConnection(ws: WebSocket): void {
    this.conns.delete(ws);
    this.rolesByConnection.delete(ws);
    this.userIdsByConnection.delete(ws);
    this.rejectedMutationConnections.delete(ws);
    this.pendingMutationMetadata.delete(ws);
    const ids = this.awarenessClientIdsByConnection.get(ws);
    this.awarenessClientIdsByConnection.delete(ws);
    if (ids && ids.size > 0) {
      removeAwarenessStates(this.awareness, Array.from(ids), null);
    }
    this.log.info({ event: "connection_removed", connections: this.conns.size }, "client left room");
  }

  /** Releases Yjs observers and state once the registry evicts an empty room. */
  destroy(): void {
    this.doc.off("update", this.onDocUpdate);
    this.awareness.off("update", this.onAwarenessUpdate);
    this.conns.clear();
    this.rolesByConnection.clear();
    this.userIdsByConnection.clear();
    this.rejectedMutationConnections.clear();
    this.pendingMutationMetadata.clear();
    this.awarenessClientIdsByConnection.clear();
    this.lastScannedCommentText.clear();
    this.awareness.destroy();
    this.doc.destroy();
  }

  /** Force active sessions to reconnect after an administrator changes their role. */
  disconnectUser(userId: string): void {
    for (const [connection, connectionUserId] of this.userIdsByConnection) {
      if (connectionUserId === userId) connection.close(4001, "page permissions changed");
    }
  }

  /** Rejects new mutations and closes clients with the standard service-restart
   * code while allowing already admitted updates to finish committing. */
  beginShutdown(): void {
    this.shuttingDown = true;
    for (const connection of this.conns) connection.close(1012, "service restarting");
  }

  /** Resolves after every update admitted so far reached its durable outcome.
   * A rejected append has already closed its source and is not silently
   * promoted to a success by this drain. */
  async flushDurableUpdates(): Promise<void> {
    while (this.committing) await this.committing;
  }

  handleMessage(ws: WebSocket, message: Uint8Array): void {
    if (this.shuttingDown) {
      this.log.warn({ event: "mutation_rejected_during_shutdown" }, "dropped message while room is draining for shutdown");
      return;
    }
    const decoder = decoding.createDecoder(message);
    const messageType = decoding.readVarUint(decoder);

    switch (messageType) {
      case MessageType.Sync: {
        // Root span for an edit's path: Y.applyUpdate (inside readSyncMessage)
        // synchronously fires doc.on("update"), so "room.doc_update" nests here.
        const span = tracer.startSpan("room.handle_sync_message", {
          attributes: { "collab.page_id": this.pageId },
        });
        const messageContext = trace.setSpan(context.active(), span);
        try {
          return context.with(messageContext, () => this.handleSyncMessage(decoder, ws));
        } finally {
          span.end();
        }
      }
      case MessageType.Awareness: {
        applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), ws);
        break;
      }
      case MessageType.MutationMetadata: {
        try {
          const value = JSON.parse(decoding.readVarString(decoder)) as Partial<ClientMutationMetadata>;
          if (
            typeof value.mutationId === "string" &&
            /^[A-Za-z0-9._:-]{1,160}$/.test(value.mutationId) &&
            typeof value.createdAtMs === "number" &&
            Number.isSafeInteger(value.createdAtMs) &&
            value.createdAtMs > 0
          ) {
            this.pendingMutationMetadata.set(ws, { mutationId: value.mutationId, createdAtMs: value.createdAtMs });
          } else {
            this.log.warn({ event: "invalid_mutation_metadata" }, "dropped invalid mutation metadata");
          }
        } catch (err) {
          this.log.warn({ event: "invalid_mutation_metadata", err }, "dropped malformed mutation metadata");
        }
        break;
      }
      default:
        this.log.warn({ event: "unknown_message_type", messageType }, "dropped unrecognized message");
    }
  }

  private handleSyncMessage(decoder: decoding.Decoder, ws: WebSocket): void {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MessageType.Sync);

    const subType = decoding.readVarUint(decoder);

    const role = this.rolesByConnection.get(ws);
    if (role === "viewer") {
      // A viewer may ask for state (syncStep1) but its syncStep2/update frames
      // are dropped before Y.applyUpdate — applying-then-discarding would still
      // mutate, persist and fan out the change.
      if (subType === syncProtocol.messageYjsSyncStep1) {
        syncProtocol.readSyncStep1(decoder, encoder, this.doc);
        if (encoding.length(encoder) > 1) ws.send(encoding.toUint8Array(encoder));
      } else {
        this.log.warn({ event: "viewer_write_rejected", pageId: this.pageId }, "dropped mutating sync message from a viewer connection");
      }
      return;
    }

    switch (subType) {
      case syncProtocol.messageYjsSyncStep1:
        syncProtocol.readSyncStep1(decoder, encoder, this.doc);
        if (encoding.length(encoder) > 1) ws.send(encoding.toUint8Array(encoder));
        return;
      case syncProtocol.messageYjsSyncStep2:
      case syncProtocol.messageYjsUpdate: {
        const mutationMetadata = this.pendingMutationMetadata.get(ws);
        this.pendingMutationMetadata.delete(ws);
        this.enqueueIncomingUpdate(decoding.readVarUint8Array(decoder), ws, mutationMetadata);
        return;
      }
      default:
        throw new Error("Unknown Yjs sync message type");
    }
  }

  /** Queues a client update for the next group commit. No peer, replica, or
   * server-owned Y.Doc observes it until that commit resolves. */
  private enqueueIncomingUpdate(update: Uint8Array, source: WebSocket, mutationMetadata?: ClientMutationMetadata): void {
    // A standard y-websocket client answers the gateway's initial SyncStep1
    // with SyncStep2 even when it has no local state to contribute. That
    // frame decodes to an empty Yjs update; recording it would consume a page
    // sequence for a handshake no-op. Delete-only updates are kept because
    // their delete set is meaningful even when they contain no structs.
    if (isEmptyYjsUpdate(update)) {
      this.log.debug({ event: "empty_sync_update_dropped" }, "dropped empty Yjs sync update");
      return;
    }
    this.admit({ update, source, metadata: mutationMetadata }).catch((err) => {
      if (!this.pageStore) {
        this.log.error({ event: "apply_in_memory_update_failed", err }, "failed to apply in-memory client update");
        source.close(1011, "update could not be applied");
        return;
      }
      this.rejectedMutationConnections.add(source);
      if (err instanceof MutationAuthorizationError) {
        this.log.warn({ event: "mutation_rejected_role_revoked" }, "closed a session after its page mutation permission changed");
        source.close(4403, "page mutation permission revoked");
        return;
      }
      this.log.error({ event: "persist_before_apply_failed", err }, "rejected update because it did not commit; closing source for replay");
      source.close(1011, "update was not persisted; reconnect to replay");
    });
  }

  /** Server-side writes (version restore, AI edits) use the same admission
   * queue and success boundary as WebSocket mutations. */
  async applyServerUpdate(update: Uint8Array): Promise<number> {
    if (isEmptyYjsUpdate(update)) return this.lastPersistedSeq;
    return this.admit({ update });
  }

  /** Keeps direct Y.Doc mutations from being published before their append
   * commits. Product write paths use `applyServerUpdate` or client sync. */
  private enqueueAlreadyAppliedUpdate(update: Uint8Array, origin: unknown): Promise<void> {
    return this.admit({ update, alreadyAppliedOrigin: { origin } }).then(
      () => undefined,
      (err) => {
        this.log.error(
          { event: "persist_after_server_mutation_failed", err },
          "server-side update was not published because it did not commit"
        );
      }
    );
  }

  private admit(mutation: Pick<PendingMutation, "update" | "source" | "metadata" | "alreadyAppliedOrigin">): Promise<number> {
    collabUpdatesTotal.inc({ outcome: "accepted" });
    collabUpdatesPending.inc();
    return new Promise<number>((resolve, reject) => {
      this.pendingMutations.push({
        ...mutation,
        traceparent: currentTraceparent() ?? undefined,
        traceContext: context.active(),
        admittedAt: process.hrtime.bigint(),
        resolve,
        reject,
      });
      this.startCommitLoop();
    });
  }

  private startCommitLoop(): void {
    if (this.committing) return;
    this.committing = (async () => {
      while (this.pendingMutations.length > 0) {
        await this.commitBatch(this.takeBatch());
      }
    })().finally(() => {
      this.committing = null;
    });
  }

  private takeBatch(): PendingMutation[] {
    let bytes = 0;
    let count = 0;
    for (const mutation of this.pendingMutations) {
      if (count > 0 && (count >= this.maxBatchUpdates || bytes + mutation.update.byteLength > this.maxBatchBytes)) break;
      bytes += mutation.update.byteLength;
      count += 1;
    }
    return this.pendingMutations.splice(0, count);
  }

  /** Commits one batch and settles every mutation in it. Never throws: each
   * mutation's promise carries its own outcome. */
  private async commitBatch(batch: PendingMutation[]): Promise<void> {
    const settle = (mutation: PendingMutation, outcome: "durable" | "failed" | "in_memory_applied" | "dropped", seqOrError: unknown) => {
      collabUpdatesPending.dec();
      if (outcome !== "dropped") {
        collabUpdatesTotal.inc({ outcome });
        const durabilityOutcome = outcome === "durable" ? "committed" : outcome === "failed" ? "failed" : "in_memory";
        collabUpdateDurabilitySeconds.observe({ outcome: durabilityOutcome }, elapsedSeconds(mutation.admittedAt));
      }
      if (outcome === "failed") mutation.reject(seqOrError);
      else mutation.resolve(seqOrError as number);
    };

    const accepted = await this.authorizeBatch(batch, settle);
    if (accepted.length === 0) return;

    if (!this.pageStore) {
      for (const mutation of accepted) {
        try {
          Y.applyUpdate(this.doc, mutation.update, mutation.source);
          settle(mutation, "in_memory_applied", this.lastPersistedSeq);
        } catch (err) {
          settle(mutation, "failed", err);
        }
      }
      return;
    }

    // One span per transaction, parented to the first edit's trace and linked
    // to every other edit that rode along in the same commit.
    const links: Link[] = accepted.slice(1).flatMap((mutation) => {
      const spanContext = trace.getSpanContext(mutation.traceContext);
      return spanContext ? [{ context: spanContext }] : [];
    });
    const span = tracer.startSpan(
      "room.commit_batch",
      { attributes: { "collab.page_id": this.pageId, "collab.batch_size": accepted.length }, links },
      accepted[0]!.traceContext
    );
    const pageStore = this.pageStore;
    let seqs: number[];
    try {
      seqs = await context.with(trace.setSpan(accepted[0]!.traceContext, span), () =>
        pageStore.recordUpdates(
          this.pageId,
          accepted.map((mutation) => ({
            update: mutation.update,
            traceparent: this.fanoutOutbox ? mutation.traceparent : undefined,
            clientMutationId: mutation.metadata?.mutationId,
            clientCreatedAtMs: mutation.metadata?.createdAtMs,
          })),
          () => this.stateAfterApplying(accepted.filter((mutation) => !mutation.alreadyAppliedOrigin).map((mutation) => mutation.update)),
          { enqueueFanout: this.fanoutOutbox !== null }
        )
      );
    } catch (err) {
      span.recordException(err as Error);
      span.end();
      for (const mutation of accepted) settle(mutation, "failed", err);
      return;
    }
    span.end();
    collabCommitBatchSize.observe(accepted.length);

    accepted.forEach((mutation, index) => {
      const seq = seqs[index]!;
      this.markAppliedSeq(seq);
      if (mutation.alreadyAppliedOrigin) {
        const { origin } = mutation.alreadyAppliedOrigin;
        this.broadcastUpdate(mutation.update, this.conns.has(origin as WebSocket) ? (origin as WebSocket) : undefined);
      } else {
        Y.applyUpdate(this.doc, mutation.update, { [DURABLE_UPDATE_ORIGIN]: true, source: mutation.source });
      }
      settle(mutation, "durable", seq);
    });
    this.fanoutOutbox?.publishCommitted(
      accepted.map((mutation, index) => ({
        pageId: this.pageId,
        seq: seqs[index]!,
        update: mutation.update,
        traceparent: mutation.traceparent ?? null,
      }))
    );
    this.recordAuthorship(accepted);
    this.afterDurableCommit();
  }

  /** Drops mutations from already-rejected sockets and re-checks every
   * remaining socket's current role with one lookup. Returns the mutations
   * allowed to commit; the rest are settled here. */
  private async authorizeBatch(
    batch: PendingMutation[],
    settle: (mutation: PendingMutation, outcome: "failed" | "dropped", seqOrError: unknown) => void
  ): Promise<PendingMutation[]> {
    const live = batch.filter((mutation) => {
      if (mutation.source && this.rejectedMutationConnections.has(mutation.source)) {
        settle(mutation, "dropped", this.lastPersistedSeq);
        return false;
      }
      return true;
    });
    if (!this.mutationAuthorizer || !live.some((mutation) => mutation.source)) return live;

    const userIds = new Set<string>();
    for (const mutation of live) {
      const userId = mutation.source ? this.userIdsByConnection.get(mutation.source) : undefined;
      if (userId) userIds.add(userId);
    }
    let roles: Map<string, Role>;
    try {
      roles = await this.mutationAuthorizer(this.pageId, [...userIds]);
    } catch (err) {
      // Can't prove authorization: fail only the client mutations; server
      // mutations were authorized by their HTTP route.
      return live.filter((mutation) => {
        if (!mutation.source) return true;
        settle(mutation, "failed", err);
        return false;
      });
    }

    const revoked = new Set<WebSocket>();
    return live.filter((mutation) => {
      const source = mutation.source;
      if (!source) return true;
      if (revoked.has(source)) {
        // Later frames from a socket rejected earlier in this same batch.
        settle(mutation, "dropped", this.lastPersistedSeq);
        return false;
      }
      const userId = this.userIdsByConnection.get(source);
      const role = userId ? roles.get(userId) : undefined;
      if (role !== "owner" && role !== "editor") {
        revoked.add(source);
        this.rejectedMutationConnections.add(source);
        settle(mutation, "failed", new MutationAuthorizationError());
        return false;
      }
      // Keep the in-memory role snapshot honest for diagnostics.
      this.rolesByConnection.set(source, role);
      return true;
    });
  }

  /** Builds the exact state to snapshot after a batch without mutating the
   * authoritative live Room before its operations are durable. */
  private stateAfterApplying(updates: Uint8Array[]): Uint8Array {
    const snapshotDoc = new Y.Doc();
    try {
      Y.applyUpdate(snapshotDoc, Y.encodeStateAsUpdate(this.doc));
      for (const update of updates) Y.applyUpdate(snapshotDoc, update);
      return Y.encodeStateAsUpdate(snapshotDoc);
    } finally {
      snapshotDoc.destroy();
    }
  }

  private broadcastUpdate(update: Uint8Array, exclude?: WebSocket, publish = true): void {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MessageType.Sync);
    syncProtocol.writeUpdate(encoder, update);
    this.broadcast(encoding.toUint8Array(encoder), exclude);
    // With an outbox, cross-gateway publish happens once per commit (see
    // commitBatch); only the direct broadcaster publishes per update.
    if (publish && !this.fanoutOutbox) this.broadcaster?.publishUpdate(this.pageId, update);
  }

  /** Attributes new Yjs client ids in a committed batch to the users whose
   *  sockets sent them. Best effort: authorship is informational and must
   *  never fail or delay an edit. */
  private recordAuthorship(committed: PendingMutation[]): void {
    if (!this.authorship) return;
    const entries: Array<{ clientId: number; userId: string }> = [];
    for (const mutation of committed) {
      const userId = mutation.source ? this.userIdsByConnection.get(mutation.source) : undefined;
      if (!userId) continue;
      for (const clientId of clientIdsInUpdate(mutation.update)) {
        if (this.attributedClientIds.has(clientId)) continue;
        this.attributedClientIds.add(clientId);
        entries.push({ clientId, userId });
      }
    }
    if (entries.length === 0) return;
    this.authorship.record(this.pageId, entries).catch((err) => {
      for (const entry of entries) this.attributedClientIds.delete(entry.clientId);
      this.log.warn({ event: "record_authorship_failed", err }, "failed to record client authorship");
    });
  }

  /** Side effects that need to happen once per commit, not once per update. */
  private afterDurableCommit(): void {
    // A busy page's edits coalesce into one pending job per queue (see
    // JobQueues' jobId-based dedup).
    this.jobQueues?.enqueueSearchIndex(this.pageId).catch((err) => {
      this.log.error({ event: "enqueue_search_index_failed", err }, "failed to enqueue search index job");
    });
    this.jobQueues?.enqueuePreview(this.pageId).catch((err) => {
      this.log.error({ event: "enqueue_preview_failed", err }, "failed to enqueue preview job");
    });
    this.scanForNewMentions();
  }

  private broadcast(payload: Uint8Array, exclude?: WebSocket): void {
    for (const conn of this.conns) {
      if (conn !== exclude && conn.readyState === conn.OPEN) {
        conn.send(payload);
      }
    }
  }

  /** Indexes @mentions in any comment whose text changed since its last scan
   *  and removes indexed mentions for comments that disappeared. Runs after a
   *  commit, so a page without comments pays only an empty Y.Map iteration. */
  private scanForNewMentions(): void {
    if (!this.mentionsStore) return;
    const commentsMap = getCommentsMap(this.doc);
    const liveCommentIds = new Set<string>();

    commentsMap.forEach((comment, commentId) => {
      liveCommentIds.add(commentId);
      const text = (comment.get("text") as string) ?? "";
      if (this.lastScannedCommentText.get(commentId) === text) return;
      this.lastScannedCommentText.set(commentId, text);

      const mentionedEmails = extractMentionEmails(text);
      if (mentionedEmails.length === 0) return;

      this.mentionsStore!.recordMentions({
        pageId: this.pageId,
        commentId,
        blockId: (comment.get("blockId") as string) ?? "",
        authorUserId: (comment.get("authorId") as string) ?? null,
        commentText: text,
        mentionedEmails,
      }).catch((err) => {
        this.log.error({ event: "record_mentions_failed", commentId, err }, "failed to record mentions");
      });
    });

    for (const commentId of this.lastScannedCommentText.keys()) {
      if (liveCommentIds.has(commentId)) continue;
      this.lastScannedCommentText.delete(commentId);
      this.mentionsStore!.deleteMentionsForComment(this.pageId, commentId).catch((err) => {
        this.log.error({ event: "delete_mentions_failed", commentId, err }, "failed to delete mentions for removed comment");
      });
    }
  }
}

function elapsedSeconds(start: bigint): number {
  return Number(process.hrtime.bigint() - start) / 1_000_000_000;
}

function isEmptyYjsUpdate(update: Uint8Array): boolean {
  try {
    const decoded = Y.decodeUpdate(update);
    return decoded.structs.length === 0 && decoded.ds.clients.size === 0;
  } catch {
    // Invalid bytes continue through the normal admission/error path; this
    // helper is only an optimization for valid no-op SyncStep2 frames.
    return false;
  }
}
