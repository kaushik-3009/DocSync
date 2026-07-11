import { describe, expect, it } from "vitest";
import { RoomRegistry } from "../src/room-registry.js";

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
});
