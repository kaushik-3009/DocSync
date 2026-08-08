import * as Y from "yjs";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import * as syncProtocol from "y-protocols/sync";
import { Awareness, encodeAwarenessUpdate, applyAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness";
import type { WebSocket } from "ws";
import { context, trace } from "@opentelemetry/api";
import { MessageType, getCommentsMap, extractMentionEmails, type ClientMutationMetadata } from "@collab/shared";
import { childLogger } from "./logger.js";
import type { PageStore } from "./persistence/page-store.js";
import { updateFingerprint } from "./persistence/ops-log.js";
import type { RoomBroadcaster } from "./redis/broadcaster.js";
import type { JobQueues } from "./jobs/queues.js";
import type { MentionsStore } from "./comments/mentions-store.js";
import type { Role } from "@collab/shared";
import { tracer } from "./tracing/tracer.js";
import { collabUpdateDurabilitySeconds, collabUpdatesPending, collabUpdatesTotal } from "./metrics/registry.js";
import type { FanoutOutbox } from "./persistence/fanout-outbox.js";

/** Transaction/awareness-update origin marker used when applying an update that arrived
 *  from another instance via Redis. Room checks `origin !== REMOTE_ORIGIN` before
 *  re-publishing to Redis or persisting — otherwise every instance would re-publish
 *  what it just received (infinite echo) and every instance would double-write the
 *  same op to the ops log. */
export const REMOTE_ORIGIN = Symbol("redis-remote-origin");

/** Re-checks the authoritative page role immediately before a queued client
 * mutation crosses the durable admission boundary. The WebSocket handshake
 * role is only a snapshot; an owner can revoke/downgrade it while the socket
 * remains open. */
export type MutationAuthorizer = (pageId: string, userId: string) => Promise<Role | null>;

export class MutationAuthorizationError extends Error {
  constructor() {
    super("page permission no longer allows mutations");
    this.name = "MutationAuthorizationError";
  }
}

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

/**
 * A Room owns exactly one Y.Doc (and its Awareness instance) for one pageId,
 * plus the set of currently-connected sockets. It knows nothing about HTTP,
 * ws upgrade, or process-wide routing — that isolation is what lets
 * RoomRegistry be swapped for a Redis-coordinated version in Phase 4 without
 * touching sync logic here.
 *
 * Persistence (Phase 2) is an optional collaborator, not a hard dependency:
 * a Room constructed with `pageStore: null` behaves exactly like Phase 1
 * (pure in-memory, nothing durable), which is what the existing convergence
 * tests still exercise. When a PageStore is supplied, client-originated sync
 * updates are appended to the ops log before they are applied to this Room or
 * sent to another client/replica. The sender's browser remains optimistic in
 * its own Y.Doc; a failed append closes that connection so y-websocket can
 * reconnect and replay its still-local state. This intentionally chooses
 * durable-before-fanout over the former lower-latency, fire-and-forget model.
 *
 * Multi-instance fanout (Phase 4) is likewise an optional collaborator: a
 * Room constructed with `broadcaster: null` is single-instance-only, exactly
 * like Phases 1-3. When a RoomBroadcaster is supplied, locally-originated
 * updates/awareness changes are also published to Redis, and updates
 * arriving from Redis (tagged with REMOTE_ORIGIN) are applied to the local
 * doc/awareness so they reach this instance's own connected clients —
 * without being re-published (no echo) or re-persisted (the originating
 * instance already persisted it; every instance persisting the same op
 * would corrupt the ops-log sequence).
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
  /** Last-seen text per comment id, keyed so a comment is only re-scanned for
   *  @mentions when its text actually changes (not on every unrelated edit
   *  to the page), while still catching a mention added via an edit to an
   *  already-existing comment. A tracked id no longer present in the live
   *  comments map means the comment was deleted (or cascade-deleted with
   *  its block, see blocks.ts's deleteBlock), which triggers cleanup of any
   *  mentions indexed for it. Resets when the Room does (e.g. after the
   *  last connection leaves and a new one recreates it), which just means
   *  comments existing before this process last restarted get re-scanned
   *  once more — recordMentions' ON CONFLICT DO NOTHING makes that a
   *  harmless no-op, not a duplicate. */
  private readonly lastScannedCommentText = new Map<string, string>();
  /** Which awareness clientIDs a given socket has published — the only way to know which
   *  awareness states to clear when that socket disconnects, since awareness clientIDs
   *  are chosen client-side and never otherwise reported to us. */
  private readonly awarenessClientIdsByConnection = new Map<WebSocket, Set<number>>();
  /** Role a connection was granted at join time (Phase 5). Absent entirely when auth is
   *  disabled, in which case every connection behaves as before — unrestricted. */
  private readonly rolesByConnection = new Map<WebSocket, Role>();
  private readonly userIdsByConnection = new Map<WebSocket, string>();
  /** Serializes durable admission for one page. Besides keeping `persistedSeq`
   * monotonic, this preserves the causal order of Yjs updates emitted by a
   * single room before they are applied and fanned out. */
  private durableUpdateQueue: Promise<void> = Promise.resolve();
  /** Ordered independently from local admission: a committed Redis envelope
   * can reveal a missing seq that must be replayed before a later envelope is
   * exposed to this instance's local clients. */
  private remoteUpdateQueue: Promise<void> = Promise.resolve();
  /** A source whose append failed may have sent more frames before it observed
   * the 1011 close. Drop those queued frames rather than persisting an update
   * that may causally depend on the failed one. */
  private readonly rejectedMutationConnections = new Set<WebSocket>();
  /** Optional metadata queued by the benchmark/client immediately before one
   * Sync update. Standard y-websocket clients leave this empty. */
  private readonly pendingMutationMetadata = new Map<WebSocket, ClientMutationMetadata>();
  private shuttingDown = false;
  private readonly onDocUpdate: (update: Uint8Array, origin: unknown) => void;
  private readonly onAwarenessUpdate: (
    changes: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown
  ) => void;

  constructor(
    pageId: string,
    initialDoc: Y.Doc,
    initialSeq: number,
    pageStore: PageStore | null,
    broadcaster: RoomBroadcaster | null = null,
    jobQueues: JobQueues | null = null,
    mentionsStore: MentionsStore | null = null,
    private readonly fanoutOutbox: FanoutOutbox | null = null,
    private readonly mutationAuthorizer: MutationAuthorizer | null = null
  ) {
    this.pageId = pageId;
    this.doc = initialDoc;
    this.awareness = new Awareness(this.doc);
    this.log = childLogger({ pageId });
    this.pageStore = pageStore;
    this.broadcaster = broadcaster;
    this.jobQueues = jobQueues;
    this.mentionsStore = mentionsStore;
    this.lastPersistedSeq = initialSeq;
    this.lastContiguousSeq = initialSeq;

    this.onDocUpdate = (update: Uint8Array, origin: unknown) => {
      const isRemote = origin === REMOTE_ORIGIN;
      const isDurableLocal = isDurableUpdateOrigin(origin);
      // A span per doc update, not per Room: "room.doc_update" for a locally
      // originated edit (parent of the persist/enqueue spans below, and — via
      // the traceparent injected into the Redis frame — of the same edit's
      // "room.apply_remote_update" span on every other instance), or the
      // latter for one arriving via Phase 4's Redis fanout, which only ever
      // fans out to local clients (never re-persisted/re-published — see
      // REMOTE_ORIGIN's doc comment above).
      const span = tracer.startSpan(isRemote ? "room.apply_remote_update" : "room.doc_update", {
        attributes: { "collab.page_id": this.pageId, "collab.update_bytes": update.length },
      });
      span.setAttribute("collab.update_fingerprint", updateFingerprint(update));
      context.with(trace.setSpan(context.active(), span), () => {
        if (isRemote) {
          // Redis-delivered updates are already durable and must reach only
          // this instance's local clients. Never publish them back onto the
          // same channel or instances will echo the update indefinitely.
          this.broadcastUpdate(update, undefined, false);
          span.end();
          return; // came from another instance — it already persisted and published this
        }

        if (isDurableLocal) {
          this.broadcastUpdate(update, origin.source);
          this.afterDurableUpdate();
          span.end();
          return;
        }

        if (!this.pageStore) {
          this.broadcastUpdate(update, this.conns.has(origin as WebSocket) ? (origin as WebSocket) : undefined);
          span.end();
          return;
        }

        // Server-initiated mutations (currently version restore) still enter
        // through Y.Doc directly. They cannot be pre-admitted like a wire
        // update, but they must obey the same no-fanout-before-commit rule.
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
      // Legacy direct broadcaster/test frame. The outbox publisher emits a
      // sequenced committed envelope; this branch preserves compatibility for
      // intentionally in-memory single-process collaborators.
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

    const missing = await this.pageStore.getOpsInRange(this.pageId, this.lastContiguousSeq, seq);
    if (missing.length === 0 || missing[missing.length - 1]!.seq !== seq) {
      throw new Error(`durable operation range does not reach received seq ${seq}`);
    }
    const alreadyApplied = new Set(this.outOfOrderAppliedSeqs);
    for (const operation of missing) {
      // A higher local append may already be in the document while its
      // lower cross-gateway predecessors are still in flight. Yjs is
      // idempotent, but skipping that known local operation avoids needless
      // observer/fanout work while still advancing contiguous sequence state.
      if (!alreadyApplied.has(operation.seq)) {
        Y.applyUpdate(this.doc, operation.update, REMOTE_ORIGIN);
      }
      this.markAppliedSeq(operation.seq);
    }
    this.log.warn(
      { event: "remote_gap_repaired", fromSeq: missing[0]!.seq, toSeq: seq, operationCount: missing.length },
      "replayed missing durable operations after Redis sequence gap"
    );
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
        const alreadyApplied = new Set(this.outOfOrderAppliedSeqs);
        for (const operation of missing) {
          if (!alreadyApplied.has(operation.seq)) {
            Y.applyUpdate(this.doc, operation.update, REMOTE_ORIGIN);
          }
          this.markAppliedSeq(operation.seq);
        }
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
   * This is important with two gateways: a local append can legitimately
   * commit seq=10 while this room has not yet received seq=9 from Redis.
   * `lastPersistedSeq` remains the highest durable sequence observed for the
   * existing public diagnostic getter; `lastContiguousSeq` drives repair. */
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
      encoding.writeVarUint8Array(
        awarenessEncoder,
        encodeAwarenessUpdate(this.awareness, Array.from(this.awareness.getStates().keys()))
      );
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
   * code while allowing an already admitted durable queue to finish. */
  beginShutdown(): void {
    this.shuttingDown = true;
    for (const connection of this.conns) connection.close(1012, "service restarting");
  }

  /** Resolves after every update admitted before shutdown reached its durable
   * outcome. A rejected append has already closed its source and is not
   * silently promoted to a success by this drain. */
  async flushDurableUpdates(): Promise<void> {
    await this.durableUpdateQueue;
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
        // Root span for a real-time edit's whole path: this is what's active
        // when Y.applyUpdate (inside readSyncMessage, below) synchronously
        // fires the doc.on("update") handler above, so "room.doc_update" (and
        // everything nested under it) shows up as a child of this span
        // rather than an orphaned root — not every Sync message produces one
        // (syncStep1 requests don't mutate the doc), which is fine; an
        // childless "room.handle_sync_message" span is still an accurate trace.
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
      // A viewer may still ask "what's your state" (syncStep1) and receive our
      // reply, but syncStep2/update messages carry actual content changes — those
      // get dropped before ever reaching Y.applyUpdate, not merely un-broadcast
      // after the fact, since applying-then-discarding would still mutate this
      // Room's doc (and get persisted/fanned-out to every other instance/client).
      if (subType === syncProtocol.messageYjsSyncStep1) {
        syncProtocol.readSyncStep1(decoder, encoder, this.doc);
        if (encoding.length(encoder) > 1) ws.send(encoding.toUint8Array(encoder));
      } else {
        this.log.warn(
          { event: "viewer_write_rejected", pageId: this.pageId },
          "dropped mutating sync message from a viewer connection"
        );
      }
      return;
    }

    switch (subType) {
      case syncProtocol.messageYjsSyncStep1:
        syncProtocol.readSyncStep1(decoder, encoder, this.doc);
        if (encoding.length(encoder) > 1) ws.send(encoding.toUint8Array(encoder));
        return;
      case syncProtocol.messageYjsSyncStep2:
      case syncProtocol.messageYjsUpdate:
        const mutationMetadata = this.pendingMutationMetadata.get(ws);
        this.pendingMutationMetadata.delete(ws);
        this.enqueueIncomingUpdate(decoding.readVarUint8Array(decoder), ws, mutationMetadata);
        return;
      default:
        throw new Error("Unknown Yjs sync message type");
    }
  }

  /** Queues a client update behind its Postgres append. No peer, replica, or
   * server-owned Y.Doc observes it until `recordUpdate` resolves. */
  private enqueueIncomingUpdate(update: Uint8Array, source: WebSocket, mutationMetadata?: ClientMutationMetadata): void {
    // A standard y-websocket client answers the gateway's initial SyncStep1
    // with SyncStep2 even when it has no local state to contribute. That
    // frame decodes to an empty Yjs update; recording it would consume a
    // page sequence and make durable-throughput evidence count a handshake
    // no-op as an edit. Delete-only updates are retained because their
    // delete set is meaningful even when they contain no structs.
    if (isEmptyYjsUpdate(update)) {
      this.log.debug({ event: "empty_sync_update_dropped" }, "dropped empty Yjs sync update");
      return;
    }
    this.enqueueDurableApplication(update, source, mutationMetadata).catch((err) => {
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
      this.log.error(
        { event: "persist_before_apply_failed", err },
        "rejected update because it did not commit; closing source for replay"
      );
      source.close(1011, "update was not persisted; reconnect to replay");
    });
  }

  /** Enters a mutation through the one pre-commit admission queue. The public
   * server-side entry point lets HTTP mutations use the exact same success
   * boundary as WebSocket mutations. */
  async applyServerUpdate(update: Uint8Array): Promise<number> {
    if (isEmptyYjsUpdate(update)) return this.lastPersistedSeq;
    return this.enqueueDurableApplication(update);
  }

  private enqueueDurableApplication(update: Uint8Array, source?: WebSocket, mutationMetadata?: ClientMutationMetadata): Promise<number> {
    const admittedAt = process.hrtime.bigint();
    collabUpdatesTotal.inc({ outcome: "accepted" });
    collabUpdatesPending.inc();
    const operation = this.durableUpdateQueue.then(async () => {
      try {
        if (source && this.rejectedMutationConnections.has(source)) return this.lastPersistedSeq;
        if (source && this.mutationAuthorizer) {
          const userId = this.userIdsByConnection.get(source);
          if (!userId) throw new MutationAuthorizationError();
          const currentRole = await this.mutationAuthorizer(this.pageId, userId);
          if (currentRole !== "owner" && currentRole !== "editor") {
            throw new MutationAuthorizationError();
          }
          // Keep the in-memory role snapshot honest for diagnostics and for
          // the next frame while the socket is still closing.
          this.rolesByConnection.set(source, currentRole);
        }
        if (!this.pageStore) {
          Y.applyUpdate(this.doc, update, source);
          collabUpdatesTotal.inc({ outcome: "in_memory_applied" });
          collabUpdateDurabilitySeconds.observe({ outcome: "in_memory" }, elapsedSeconds(admittedAt));
          return this.lastPersistedSeq;
        }
        const seq = await this.pageStore.recordUpdate(this.pageId, update, () => this.stateAfterApplying(update), {
          enqueueFanout: this.fanoutOutbox !== null,
          clientMutationId: mutationMetadata?.mutationId,
          clientCreatedAtMs: mutationMetadata?.createdAtMs,
        });
        this.markAppliedSeq(seq);
        Y.applyUpdate(this.doc, update, { [DURABLE_UPDATE_ORIGIN]: true, source });
        collabUpdatesTotal.inc({ outcome: "durable" });
        collabUpdateDurabilitySeconds.observe({ outcome: "committed" }, elapsedSeconds(admittedAt));
        return seq;
      } catch (err) {
        collabUpdatesTotal.inc({ outcome: "failed" });
        collabUpdateDurabilitySeconds.observe({ outcome: "failed" }, elapsedSeconds(admittedAt));
        throw err;
      } finally {
        collabUpdatesPending.dec();
      }
    });
    // Keep the sequencing chain alive after a failed append while still
    // returning the original rejection to the caller that owns this update.
    this.durableUpdateQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  /** Keeps legacy direct Y.Doc mutations (currently test helpers) from being
   * published before their append commits. Product write paths must use
   * `applyServerUpdate` or client sync admission above. */
  private enqueueAlreadyAppliedUpdate(update: Uint8Array, origin: unknown): Promise<void> {
    this.durableUpdateQueue = this.durableUpdateQueue
      .then(async () => {
        try {
          const seq = await this.pageStore!.recordUpdate(this.pageId, update, () => Y.encodeStateAsUpdate(this.doc), {
            enqueueFanout: this.fanoutOutbox !== null,
          });
          this.markAppliedSeq(seq);
          this.broadcastUpdate(update, this.conns.has(origin as WebSocket) ? (origin as WebSocket) : undefined);
          this.afterDurableUpdate();
        } catch (err) {
          this.log.error(
            { event: "persist_after_server_mutation_failed", err },
            "server-side update was not published because it did not commit"
          );
        }
      });
    return this.durableUpdateQueue;
  }

  /** Builds the exact state to snapshot for an incoming update without
   * mutating the authoritative live Room before its operation is durable. */
  private stateAfterApplying(update: Uint8Array): Uint8Array {
    const snapshotDoc = new Y.Doc();
    try {
      Y.applyUpdate(snapshotDoc, Y.encodeStateAsUpdate(this.doc));
      Y.applyUpdate(snapshotDoc, update);
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
    if (!publish) return;
    if (this.fanoutOutbox) this.fanoutOutbox.wake();
    else this.broadcaster?.publishUpdate(this.pageId, update);
  }

  /** Runs only after an append has committed, regardless of whether the
   * update arrived from a client or server-side restore path. */
  private afterDurableUpdate(): void {
    // A busy page's rapid edits coalesce into one pending job per queue (see
    // JobQueues' jobId-based dedup), so this does not create one job per key.
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

  /** Indexes @mentions in any comment whose text has changed since it was last
   *  scanned (see `lastScannedCommentText`'s doc comment), and removes indexed
   *  mentions for any comment that's disappeared since the last scan. Runs
   *  after a successful persist, not on every raw doc event, so a page with no
   *  comments (the common case) pays only a `Y.Map.forEach` over an empty map,
   *  not a query. */
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
