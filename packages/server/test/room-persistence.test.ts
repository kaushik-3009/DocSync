import type { Pool } from "pg";
import { beforeEach, describe, expect, it } from "vitest";
import { createTestPool } from "./helpers/test-db.js";
import { PageStore } from "../src/persistence/page-store.js";
import { RoomRegistry } from "../src/room-registry.js";
import { createBlock, deleteBlock, serializeDocument, restoreBlocksFromSnapshot } from "@collab/shared";

let pool: Pool;

beforeEach(async () => {
  pool = await createTestPool();
});

describe("Room + RoomRegistry with persistence", () => {
  it("persists a doc update made through a Room and reloads it after the Room is destroyed", async () => {
    const registry1 = new RoomRegistry(new PageStore(pool));
    const room1 = await registry1.getOrCreateRoom("page-a");
    createBlock(room1.doc, "b1", { type: "paragraph", text: "durable" });

    await waitFor(() => room1.persistedSeq === 1);
    expect(room1.persistedSeq).toBe(1);

    // Simulate the room being evicted (process restart / another instance
    // taking over the page) and re-created from a fresh registry.
    const registry2 = new RoomRegistry(new PageStore(pool));
    const room2 = await registry2.getOrCreateRoom("page-a");

    expect(serializeDocument(room2.doc)).toEqual(serializeDocument(room1.doc));
  });

  it("runs with no PageStore (Phase 1 behavior) when none is supplied", async () => {
    const registry = new RoomRegistry();
    const room = await registry.getOrCreateRoom("page-a");
    createBlock(room.doc, "b1", { type: "paragraph", text: "in-memory only" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(room.persistedSeq).toBe(0);
  });

  it("restores a page to an old version via the same replay+transact path the HTTP restore route uses", async () => {
    const pageStore = new PageStore(pool);
    const registry = new RoomRegistry(pageStore);
    const room = await registry.getOrCreateRoom("page-a");

    createBlock(room.doc, "b1", { type: "paragraph", text: "original" });
    createBlock(room.doc, "b2", { type: "paragraph", text: "second block" });
    await waitFor(() => room.persistedSeq === 2);
    const seqAtOriginal = room.persistedSeq;

    // Simulate further edits made after the version we'll restore to.
    deleteBlock(room.doc, "b2");
    createBlock(room.doc, "b3", { type: "paragraph", text: "this text should be gone after restore" });
    await waitFor(() => room.persistedSeq === 4);
    expect(serializeDocument(room.doc).map((b) => b.id)).toEqual(["b1", "b3"]);

    // The restore route's actual mechanism: replay the target seq into a
    // detached snapshot doc, then diff-and-patch it onto the *live* room's
    // doc inside a transaction (not a fresh doc), so persistence/broadcast
    // fire exactly as for any other edit.
    const snapshotDoc = await pageStore.replayAt("page-a", seqAtOriginal);
    const snapshotBlocks = serializeDocument(snapshotDoc);
    room.doc.transact(() => restoreBlocksFromSnapshot(room.doc, snapshotBlocks));

    expect(serializeDocument(room.doc)).toEqual(snapshotBlocks);

    // And the restore itself is durable — reloading the page from Postgres
    // from scratch reflects the restored state, not the pre-restore edits.
    await waitFor(() => room.persistedSeq === 5);
    const registry2 = new RoomRegistry(new PageStore(pool));
    const reloadedRoom = await registry2.getOrCreateRoom("page-a");
    expect(serializeDocument(reloadedRoom.doc)).toEqual(snapshotBlocks);
  });
});

function waitFor(check: () => boolean, timeoutMs = 1_000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (check()) return resolve();
    const interval = setInterval(() => {
      if (!check()) return;
      clearInterval(interval);
      clearTimeout(timeout);
      resolve();
    }, 5);
    const timeout = setTimeout(() => {
      clearInterval(interval);
      reject(new Error("timed out waiting for persisted update"));
    }, timeoutMs);
  });
}
