import RedisMock from "ioredis-mock";
import { beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createTestPool } from "./helpers/test-db.js";
import { RoomRegistry } from "../src/room-registry.js";
import { RedisRoomBroadcaster } from "../src/redis/broadcaster.js";
import { PageStore } from "../src/persistence/page-store.js";
import { getCurrentSeq } from "../src/persistence/ops-log.js";
import { createBlock, getBlockText, serializeDocument } from "@collab/shared";
import type { PresenceState } from "@collab/shared";

/**
 * Simulates two separate server processes sharing one Redis backend by
 * constructing two independent RoomRegistry + RedisRoomBroadcaster pairs.
 * ioredis-mock instances constructed with the same connection "name" share
 * an in-memory pub/sub bus, which is exactly the property needed here —
 * no live Redis required, same rationale as pg-mem standing in for Postgres.
 */
function makeInstance(pageStore: PageStore | null = null) {
  const pub = new RedisMock();
  const sub = new RedisMock();
  const broadcaster = new RedisRoomBroadcaster(pub as never, sub as never);
  const registry = new RoomRegistry(pageStore, broadcaster);
  return { registry, broadcaster };
}

describe("Redis pub/sub fanout across instances", () => {
  it("propagates a doc update from one instance's room to another instance's room for the same page", async () => {
    const a = makeInstance();
    const b = makeInstance();

    const roomA = await a.registry.getOrCreateRoom("shared-page");
    const roomB = await b.registry.getOrCreateRoom("shared-page");

    createBlock(roomA.doc, "b1", { type: "paragraph", text: "hello from A" });

    await vi_waitFor(() => serializeDocument(roomB.doc).length === 1);

    expect(getBlockText(roomB.doc, "b1")?.toString()).toBe("hello from A");

    // and the reverse direction
    createBlock(roomB.doc, "b2", { type: "paragraph", text: "hello from B" });
    await vi_waitFor(() => serializeDocument(roomA.doc).length === 2);
    expect(getBlockText(roomA.doc, "b2")?.toString()).toBe("hello from B");
  });

  it("mirrors awareness/presence between instances", async () => {
    const a = makeInstance();
    const b = makeInstance();

    const roomA = await a.registry.getOrCreateRoom("shared-page");
    const roomB = await b.registry.getOrCreateRoom("shared-page");

    const presence: PresenceState = { user: { id: "a", name: "Alice", color: "#111" }, cursor: null };
    roomA.awareness.setLocalState({ presence });

    await vi_waitFor(() => {
      const states = Array.from(roomB.awareness.getStates().values());
      return states.some((s) => (s.presence as PresenceState | undefined)?.user.id === "a");
    });
  });

  it("persists a fanned-out update exactly once, not once per instance", async () => {
    const pool: Pool = await createTestPool();
    const pageStore = new PageStore(pool);

    const a = makeInstance(pageStore);
    const b = makeInstance(pageStore);

    const roomA = await a.registry.getOrCreateRoom("shared-page");
    const roomB = await b.registry.getOrCreateRoom("shared-page");

    createBlock(roomA.doc, "b1", { type: "paragraph", text: "one edit" });
    await vi_waitFor(() => serializeDocument(roomB.doc).length === 1);

    // give any (incorrect) duplicate persistence attempt a moment to land
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(await getCurrentSeq(pool, "shared-page")).toBe(1);
  });
});

function vi_waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (check()) return resolve();
    const interval = setInterval(() => {
      if (check()) {
        clearInterval(interval);
        clearTimeout(timeout);
        resolve();
      }
    }, 10);
    const timeout = setTimeout(() => {
      clearInterval(interval);
      reject(new Error("timed out waiting for condition"));
    }, timeoutMs);
  });
}
