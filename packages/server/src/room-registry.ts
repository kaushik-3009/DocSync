import * as Y from "yjs";
import { Room, type RoomDependencies } from "./room.js";
import { childLogger } from "./logger.js";
import type { PageStore } from "./persistence/page-store.js";
import type { RoomBroadcaster } from "./redis/broadcaster.js";

const log = childLogger({ module: "room-registry" });

/**
 * In-process room lookup by pageId — the only place that knows rooms live in
 * this process. Callers only use getOrCreateRoom/releaseRoom.
 *
 * getOrCreateRoom is async because creating a Room may mean loading its
 * document from Postgres (Phase 2 persistence) first. Concurrent callers
 * for the same brand-new pageId share one in-flight load via `pending`,
 * so two clients connecting to the same new page at once don't trigger two
 * separate replays.
 *
 * When a RoomBroadcaster is supplied, a room subscribes to its Redis
 * channel as soon as it's created (before any local client connects) and
 * unsubscribes once it's destroyed — otherwise a page with zero local
 * connections would sit there receiving updates for nothing.
 */
export class RoomRegistry {
  private readonly rooms = new Map<string, Room>();
  private readonly pending = new Map<string, Promise<Room>>();
  private shuttingDown = false;

  private readonly pageStore: PageStore | null;
  private readonly broadcaster: RoomBroadcaster | null;

  constructor(private readonly dependencies: RoomDependencies = {}) {
    this.pageStore = dependencies.pageStore ?? null;
    this.broadcaster = dependencies.broadcaster ?? null;
    this.broadcaster?.setReconnectHandler?.(() => {
      void this.reconcileAllRooms().catch((err) =>
        log.error({ event: "redis_reconnect_reconcile_failed", err }, "failed to reconcile rooms after Redis reconnect")
      );
    });
  }

  async getOrCreateRoom(pageId: string): Promise<Room> {
    const existing = this.rooms.get(pageId);
    if (existing) return existing;

    const inFlight = this.pending.get(pageId);
    if (inFlight) return inFlight;

    const creation = this.createRoom(pageId);
    this.pending.set(pageId, creation);
    try {
      const room = await creation;
      this.rooms.set(pageId, room);
      return room;
    } finally {
      this.pending.delete(pageId);
    }
  }

  private async createRoom(pageId: string): Promise<Room> {
    const { doc, seq } = this.pageStore ? await this.pageStore.loadPage(pageId) : { doc: new Y.Doc(), seq: 0 };
    const room = new Room(pageId, doc, seq, this.dependencies);

    if (this.broadcaster) {
      await this.broadcaster.subscribeRoom(pageId, {
        onUpdate: (update, seq) => room.applyRemoteUpdate(update, seq),
        onAwareness: (encoded) => room.applyRemoteAwareness(encoded),
      });
    }

    log.info({ event: "room_created", pageId, seq, activeRooms: this.rooms.size + 1 }, "room created");
    return room;
  }

  /** Call after a connection is removed; drops the room once nobody is left. */
  releaseRoom(pageId: string): void {
    const room = this.rooms.get(pageId);
    if (room && room.connectionCount === 0 && !this.shuttingDown) {
      this.rooms.delete(pageId);
      this.broadcaster?.unsubscribeRoom(pageId);
      room.destroy();
      log.info({ event: "room_destroyed", pageId, activeRooms: this.rooms.size }, "room destroyed (empty)");
    }
  }

  get activeRoomCount(): number {
    return this.rooms.size;
  }

  has(pageId: string): boolean {
    return this.rooms.has(pageId);
  }

  disconnectUser(pageId: string, userId: string): void {
    this.rooms.get(pageId)?.disconnectUser(userId);
  }

  /** Freeze every active room before a rolling restart. Existing clients get
   * 1012 and no later frame can enter a durable queue. */
  beginShutdown(): void {
    this.shuttingDown = true;
    for (const room of this.rooms.values()) room.beginShutdown();
  }

  async drainAllMutations(): Promise<void> {
    await Promise.all(Array.from(this.rooms.values(), (room) => room.flushDurableUpdates()));
  }

  async reconcileAllRooms(): Promise<void> {
    await Promise.all(Array.from(this.rooms.values(), (room) => room.reconcileFromStore()));
  }

  /** Called after a completed/expired shutdown drain, not during normal room
   * release. The process exits immediately afterward, so no re-subscription
   * is needed. */
  destroyAll(): void {
    for (const [pageId, room] of this.rooms) {
      this.broadcaster?.unsubscribeRoom(pageId);
      room.destroy();
    }
    this.rooms.clear();
  }

  /** Non-creating lookup — for read-only endpoints (e.g. presence) that must never spin up an empty room. */
  peekRoom(pageId: string): Room | undefined {
    return this.rooms.get(pageId);
  }
}
