import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { RoomRegistry } from "../src/room-registry.js";
import { PageStore } from "../src/persistence/page-store.js";
import { createTestPool } from "./helpers/test-db.js";
import type { RoomBroadcaster } from "../src/redis/broadcaster.js";
import { createBlock, serializeDocument } from "@collab/shared";

describe("RoomRegistry", () => {
  it("creates a room lazily and reuses it for the same pageId", async () => {
    const registry = new RoomRegistry();
    const room1 = await registry.getOrCreateRoom("page-a");
    const room2 = await registry.getOrCreateRoom("page-a");
    expect(room1).toBe(room2);
    expect(registry.activeRoomCount).toBe(1);
  });

  it("shares one in-flight load for concurrent callers of a brand-new pageId", async () => {
    const registry = new RoomRegistry();
    const [room1, room2] = await Promise.all([
      registry.getOrCreateRoom("page-a"),
      registry.getOrCreateRoom("page-a"),
    ]);
    expect(room1).toBe(room2);
    expect(registry.activeRoomCount).toBe(1);
  });

  it("keeps separate rooms (and Y.Docs) per pageId", async () => {
    const registry = new RoomRegistry();
    const roomA = await registry.getOrCreateRoom("page-a");
    const roomB = await registry.getOrCreateRoom("page-b");
    expect(roomA.doc).not.toBe(roomB.doc);
    expect(registry.activeRoomCount).toBe(2);
  });

  it("destroys a room once its connection count reaches zero", async () => {
    const registry = new RoomRegistry();
    await registry.getOrCreateRoom("page-a");
    expect(registry.has("page-a")).toBe(true);

    registry.releaseRoom("page-a");
    expect(registry.has("page-a")).toBe(false);
  });

  it("does not destroy a room that still has connections", async () => {
    const registry = new RoomRegistry();
    const room = await registry.getOrCreateRoom("page-a");
    const fakeSocket = { readyState: 1, OPEN: 1, send: () => {} } as any;
    room.addConnection(fakeSocket);

    registry.releaseRoom("page-a");
    expect(registry.has("page-a")).toBe(true);
  });

  it("reconciles quiet active rooms when the broadcaster reports a Redis reconnect", async () => {
    const pool = await createTestPool();
    const store = new PageStore(pool);
    let reconnect: (() => void) | undefined;
    const broadcaster: RoomBroadcaster = {
      publishUpdate: () => undefined,
      publishAwareness: () => undefined,
      subscribeRoom: async () => undefined,
      unsubscribeRoom: () => undefined,
      setReconnectHandler: (handler) => {
        reconnect = handler;
      },
    };
    const registry = new RoomRegistry({ pageStore: store, broadcaster });
    const room = await registry.getOrCreateRoom("page-a");
    const source = new Y.Doc();
    createBlock(source, "b1", { type: "paragraph", text: "missed while Redis was down" });
    const update = Y.encodeStateAsUpdate(source);
    await store.recordUpdate("page-a", update, () => update);

    reconnect!();
    await waitFor(() => serializeDocument(room.doc).length === 1);
    expect(room.persistedSeq).toBe(1);
  });
});

async function waitFor(check: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for room reconciliation");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
