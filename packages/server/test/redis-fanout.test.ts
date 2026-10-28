import type Redis from "ioredis";
import { createTestRedis } from "./helpers/test-redis.js";
import * as Y from "yjs";
import { afterEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createTestPool } from "./helpers/test-db.js";
import { RoomRegistry } from "../src/room-registry.js";
import { RedisRoomBroadcaster } from "../src/redis/broadcaster.js";
import { PageStore } from "../src/persistence/page-store.js";
import { Room } from "../src/room.js";
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
  const pub = createTestRedis();
  const sub = createTestRedis();
  redisClients.push(pub, sub);
  const broadcaster = new RedisRoomBroadcaster(pub, sub);
  const registry = new RoomRegistry({ pageStore, broadcaster });
  return { registry, broadcaster };
}

const redisClients: Redis[] = [];

afterEach(() => {
  for (const client of redisClients.splice(0)) client.disconnect();
});

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

  it("repairs an active room that receives a later committed sequence after missing an earlier Redis message", async () => {
    const pool: Pool = await createTestPool();
    const store = new PageStore(pool);
    const source = new Y.Doc();
    const updates: Uint8Array[] = [];
    source.on("update", (update: Uint8Array) => updates.push(update));
    createBlock(source, "b1", { type: "paragraph", text: "first durable op" });
    createBlock(source, "b2", { type: "paragraph", text: "second durable op" });
    await store.recordUpdate("shared-page", updates[0]!, () => Y.encodeStateAsUpdate(source));
    await store.recordUpdate("shared-page", updates[1]!, () => Y.encodeStateAsUpdate(source));

    const recoveringRoom = new Room("shared-page", new Y.Doc(), 0, { pageStore: store });
    // Sequence 1 is deliberately never sent to this room. The seq=2 envelope
    // must make it load ops 1..2 from Postgres before broadcasting locally.
    recoveringRoom.applyRemoteUpdate(updates[1]!, 2);

    await vi_waitFor(() => serializeDocument(recoveringRoom.doc).length === 2);
    expect(recoveringRoom.persistedSeq).toBe(2);
    expect(serializeDocument(recoveringRoom.doc).map((block) => block.id)).toEqual(["b1", "b2"]);
  });

  it("does not drop a late lower sequence after a concurrent local append", async () => {
    const pool: Pool = await createTestPool();
    const store = new PageStore(pool);
    const source = new Y.Doc();
    const updates: Uint8Array[] = [];
    source.on("update", (update: Uint8Array) => updates.push(update));
    createBlock(source, "b1", { type: "paragraph", text: "remote predecessor" });
    createBlock(source, "b2", { type: "paragraph", text: "local successor" });

    // Another gateway commits seq=1 before this room exists, but Redis delivery
    // is delayed. This room then admits the independent update as seq=2 and
    // applies it locally while its contiguous durable cursor is still zero.
    await store.recordUpdate("shared-page", updates[0]!, () => Y.encodeStateAsUpdate(source));
    const room = new Room("shared-page", new Y.Doc(), 0, { pageStore: store });
    await room.applyServerUpdate(updates[1]!);

    // The late seq=1 envelope must fill the gap rather than being treated as a
    // duplicate merely because this room already knows that seq=2 is durable.
    room.applyRemoteUpdate(updates[0]!, 1);
    await vi_waitFor(() => serializeDocument(room.doc).length === 2);
    expect(serializeDocument(room.doc).map((block) => block.id)).toEqual(["b1", "b2"]);
    expect(room.persistedSeq).toBe(2);
  });

  it("carries the durable operation sequence in an outbox-published Redis envelope", async () => {
    const senderPub = createTestRedis();
    const senderSub = createTestRedis();
    const receiverPub = createTestRedis();
    const receiverSub = createTestRedis();
    redisClients.push(senderPub, senderSub, receiverPub, receiverSub);
    const sender = new RedisRoomBroadcaster(senderPub, senderSub);
    const receiver = new RedisRoomBroadcaster(receiverPub, receiverSub);
    const envelopeDoc = new Y.Doc();
    createBlock(envelopeDoc, "envelope-block", { type: "paragraph", text: "valid Yjs payload" });
    const update = Y.encodeStateAsUpdate(envelopeDoc);
    let observed: { update: Uint8Array; seq: number | undefined } | null = null;
    await receiver.subscribeRoom("shared-page", {
      onUpdate: (received, seq) => {
        observed = { update: received, seq };
      },
      onAwareness: () => undefined,
    });

    await sender.publishCommittedUpdate({ pageId: "shared-page", seq: 42, update, traceparent: null });
    await vi_waitFor(() => observed !== null);

    expect(observed).toEqual({ update, seq: 42 });
  });

  it("delivers a committed outbox self-echo so a non-originating claimant can reconcile its room", async () => {
    const pub = createTestRedis();
    const sub = createTestRedis();
    redisClients.push(pub, sub);
    const broadcaster = new RedisRoomBroadcaster(pub, sub);
    const envelopeDoc = new Y.Doc();
    createBlock(envelopeDoc, "self-echo-block", { type: "paragraph", text: "claimed by another worker" });
    const update = Y.encodeStateAsUpdate(envelopeDoc);
    let observed: { update: Uint8Array; seq: number | undefined } | null = null;
    await broadcaster.subscribeRoom("shared-page", {
      onUpdate: (received, seq) => {
        observed = { update: received, seq };
      },
      onAwareness: () => undefined,
    });

    await broadcaster.publishCommittedUpdate({ pageId: "shared-page", seq: 7, update, traceparent: null });
    await vi_waitFor(() => observed !== null);

    expect(observed).toEqual({ update, seq: 7 });
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
