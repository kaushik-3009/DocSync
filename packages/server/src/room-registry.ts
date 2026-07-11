import * as Y from "yjs";
import { Room } from "./room.js";
import { childLogger } from "./logger.js";
import type { PageStore } from "./persistence/page-store.js";
import type { RoomBroadcaster } from "./redis/broadcaster.js";
import type { JobQueues } from "./jobs/queues.js";
import type { MentionsStore } from "./comments/mentions-store.js";

const log = childLogger({ module: "room-registry" });

/**
 * In-process room lookup by pageId. This is intentionally the *only* place
 * that knows "rooms live in this process." Callers (ws-gateway.ts) only
 * ever call getOrCreateRoom/releaseRoom, so swapping the fanout mechanism
 * (Phase 4: Redis pub/sub) never touches sync logic in Room or the gateway.
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

  constructor(
    private readonly pageStore: PageStore | null = null,
    private readonly broadcaster: RoomBroadcaster | null = null,
    private readonly jobQueues: JobQueues | null = null,
    private readonly mentionsStore: MentionsStore | null = null
  ) {}

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
    const room = new Room(pageId, doc, seq, this.pageStore, this.broadcaster, this.jobQueues, this.mentionsStore);

    if (this.broadcaster) {
      await this.broadcaster.subscribeRoom(pageId, {
        onUpdate: (update) => room.applyRemoteUpdate(update),
        onAwareness: (encoded) => room.applyRemoteAwareness(encoded),
      });
    }

    log.info({ event: "room_created", pageId, seq, activeRooms: this.rooms.size + 1 }, "room created");
    return room;
  }

  /** Call after a connection is removed; drops the room once nobody is left. */
  releaseRoom(pageId: string): void {
    const room = this.rooms.get(pageId);
    if (room && room.connectionCount === 0) {
      this.rooms.delete(pageId);
      this.broadcaster?.unsubscribeRoom(pageId);
      log.info({ event: "room_destroyed", pageId, activeRooms: this.rooms.size }, "room destroyed (empty)");
    }
  }

  get activeRoomCount(): number {
    return this.rooms.size;
  }

  has(pageId: string): boolean {
    return this.rooms.has(pageId);
  }

  /** Non-creating lookup — for read-only endpoints (e.g. presence) that must never spin up an empty room. */
  peekRoom(pageId: string): Room | undefined {
    return this.rooms.get(pageId);
  }
}
