import * as Y from "yjs";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import * as syncProtocol from "y-protocols/sync";
import { Awareness, encodeAwarenessUpdate, applyAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness";
import type { WebSocket } from "ws";
import { context, trace } from "@opentelemetry/api";
import { MessageType, getCommentsMap, extractMentionEmails } from "@collab/shared";
import { childLogger } from "./logger.js";
import type { PageStore } from "./persistence/page-store.js";
import type { RoomBroadcaster } from "./redis/broadcaster.js";
import type { JobQueues } from "./jobs/queues.js";
import type { MentionsStore } from "./comments/mentions-store.js";
import type { Role } from "@collab/shared";
import { tracer } from "./tracing/tracer.js";

/** Transaction/awareness-update origin marker used when applying an update that arrived
 *  from another instance via Redis. Room checks `origin !== REMOTE_ORIGIN` before
 *  re-publishing to Redis or persisting — otherwise every instance would re-publish
 *  what it just received (infinite echo) and every instance would double-write the
 *  same op to the ops log. */
export const REMOTE_ORIGIN = Symbol("redis-remote-origin");

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
 * tests still exercise. When a PageStore is supplied, every local doc update
 * is appended to the ops log — broadcast to peers and persistence happen
 * off the same event, but broadcast is synchronous while persistence is
 * fire-and-forget (logged on failure) so a slow disk/DB never adds latency
 * to real-time sync.
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

  constructor(
    pageId: string,
    initialDoc: Y.Doc,
    initialSeq: number,
    pageStore: PageStore | null,
    broadcaster: RoomBroadcaster | null = null,
    jobQueues: JobQueues | null = null,
    mentionsStore: MentionsStore | null = null
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

    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      const isRemote = origin === REMOTE_ORIGIN;
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
      context.with(trace.setSpan(context.active(), span), () => {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MessageType.Sync);
        syncProtocol.writeUpdate(encoder, update);
        const excludeWs = this.conns.has(origin as WebSocket) ? (origin as WebSocket) : undefined;
        this.broadcast(encoding.toUint8Array(encoder), excludeWs);

        if (isRemote) {
          span.end();
          return; // came from another instance — it already persisted and published this
        }

        if (this.pageStore) {
          this.pageStore
            .recordUpdate(this.pageId, update, () => Y.encodeStateAsUpdate(this.doc))
            .then((seq) => {
              this.lastPersistedSeq = seq;
              // Fire-and-forget, same tradeoff as persistence itself: a busy page's
              // rapid edits coalesce into one pending job per queue (see JobQueues'
              // jobId-based dedup), so this doesn't mean "one job per keystroke."
              this.jobQueues?.enqueueSearchIndex(this.pageId).catch((err) => {
                this.log.error({ event: "enqueue_search_index_failed", err }, "failed to enqueue search index job");
              });
              this.jobQueues?.enqueuePreview(this.pageId).catch((err) => {
                this.log.error({ event: "enqueue_preview_failed", err }, "failed to enqueue preview job");
              });
              this.scanForNewMentions();
            })
            .catch((err) => {
              this.log.error({ event: "persist_failed", err }, "failed to persist update — in-memory state is still correct, but durability is behind");
            })
            .finally(() => span.end());
        } else {
          span.end();
        }

        this.broadcaster?.publishUpdate(this.pageId, update);
      });
    });

    this.awareness.on(
      "update",
      ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
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
      }
    );
  }

  /** Applies an update received from another instance via Redis to this instance's local doc.
   *  Tagging with REMOTE_ORIGIN is what stops the update/awareness handlers above from
   *  re-publishing it or re-persisting it. */
  applyRemoteUpdate(update: Uint8Array): void {
    Y.applyUpdate(this.doc, update, REMOTE_ORIGIN);
  }

  applyRemoteAwareness(encoded: Uint8Array): void {
    applyAwarenessUpdate(this.awareness, encoded, REMOTE_ORIGIN);
  }

  get connectionCount(): number {
    return this.conns.size;
  }

  /** Highest seq we've confirmed is durable — best-effort, lags in-memory state under load. */
  get persistedSeq(): number {
    return this.lastPersistedSeq;
  }

  addConnection(ws: WebSocket, role: Role | null = null): void {
    this.conns.add(ws);
    if (role) this.rolesByConnection.set(ws, role);
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
    const ids = this.awarenessClientIdsByConnection.get(ws);
    this.awarenessClientIdsByConnection.delete(ws);
    if (ids && ids.size > 0) {
      removeAwarenessStates(this.awareness, Array.from(ids), null);
    }
    this.log.info({ event: "connection_removed", connections: this.conns.size }, "client left room");
  }

  handleMessage(ws: WebSocket, message: Uint8Array): void {
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
      default:
        this.log.warn({ event: "unknown_message_type", messageType }, "dropped unrecognized message");
    }
  }

  private handleSyncMessage(decoder: decoding.Decoder, ws: WebSocket): void {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MessageType.Sync);

    const role = this.rolesByConnection.get(ws);
    if (role === "viewer") {
      // A viewer may still ask "what's your state" (syncStep1) and receive our
      // reply, but syncStep2/update messages carry actual content changes — those
      // get dropped before ever reaching Y.applyUpdate, not merely un-broadcast
      // after the fact, since applying-then-discarding would still mutate this
      // Room's doc (and get persisted/fanned-out to every other instance/client).
      const subType = decoding.readVarUint(decoder);
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

    syncProtocol.readSyncMessage(decoder, encoder, this.doc, ws);
    if (encoding.length(encoder) > 1) {
      ws.send(encoding.toUint8Array(encoder));
    }
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
