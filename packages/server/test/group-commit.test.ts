import * as Y from "yjs";
import * as encoding from "lib0/encoding";
import * as syncProtocol from "y-protocols/sync";
import type { WebSocket } from "ws";
import { describe, expect, it, vi } from "vitest";
import { MessageType, type Role } from "@docsync/shared";
import { Room } from "../src/room.js";
import { PageStore } from "../src/persistence/page-store.js";
import { appendOps, getOpsInRange } from "../src/persistence/ops-log.js";
import { getLatestSnapshot } from "../src/persistence/snapshots.js";
import { createTestPool } from "./helpers/test-db.js";

function fakeSocket() {
  return { OPEN: 1, readyState: 1, send: vi.fn(), close: vi.fn() } as unknown as WebSocket;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function updateMessage(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MessageType.Sync);
  syncProtocol.writeUpdate(encoder, update);
  return encoding.toUint8Array(encoder);
}

/** A distinct, independent Yjs update setting `key`. */
function keyedUpdate(key: string): Uint8Array {
  const doc = new Y.Doc();
  doc.getMap<string>("values").set(key, key);
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
}

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("group commit", () => {
  it("commits updates that queue behind an in-flight transaction as one batch, in arrival order", async () => {
    const firstCommit = deferred<number[]>();
    const batches: number[] = [];
    const recordUpdates = vi.fn(async (_pageId: string, entries: unknown[]) => {
      batches.push(entries.length);
      if (batches.length === 1) return firstCommit.promise;
      return entries.map((_, index) => 2 + index);
    });
    const room = new Room("page-a", new Y.Doc(), 0, { pageStore: { recordUpdates } as unknown as PageStore });
    const source = fakeSocket();
    room.addConnection(source);

    room.handleMessage(source, updateMessage(keyedUpdate("k0")));
    await waitFor(() => recordUpdates.mock.calls.length === 1);
    for (let i = 1; i <= 5; i += 1) room.handleMessage(source, updateMessage(keyedUpdate(`k${i}`)));

    firstCommit.resolve([1]);
    await room.flushDurableUpdates();

    expect(batches).toEqual([1, 5]);
    expect(room.persistedSeq).toBe(6);
    expect([...room.doc.getMap("values").keys()].sort()).toEqual(["k0", "k1", "k2", "k3", "k4", "k5"]);
  });

  it("re-checks roles once per batch and rejects only the revoked user's updates", async () => {
    const firstCommit = deferred<number[]>();
    const committed: number[] = [];
    const recordUpdates = vi.fn(async (_pageId: string, entries: unknown[]) => {
      committed.push(entries.length);
      if (committed.length === 1) return firstCommit.promise;
      return entries.map((_, index) => 2 + index);
    });
    const roles = new Map<string, Role>([
      ["editor-user", "editor"],
      ["revoked-user", "editor"],
    ]);
    const mutationAuthorizer = vi.fn(async () => new Map(roles));
    const room = new Room("page-a", new Y.Doc(), 0, {
      pageStore: { recordUpdates } as unknown as PageStore,
      mutationAuthorizer,
    });
    const editor = fakeSocket();
    const revoked = fakeSocket();
    room.addConnection(editor, "editor", "editor-user");
    room.addConnection(revoked, "editor", "revoked-user");

    room.handleMessage(editor, updateMessage(keyedUpdate("first")));
    await waitFor(() => recordUpdates.mock.calls.length === 1);
    roles.delete("revoked-user");
    room.handleMessage(revoked, updateMessage(keyedUpdate("revoked-1")));
    room.handleMessage(editor, updateMessage(keyedUpdate("kept")));
    room.handleMessage(revoked, updateMessage(keyedUpdate("revoked-2")));
    firstCommit.resolve([1]);
    await room.flushDurableUpdates();
    await waitFor(() => vi.mocked(revoked.close).mock.calls.length === 1);

    expect(mutationAuthorizer).toHaveBeenCalledTimes(2);
    expect(mutationAuthorizer).toHaveBeenLastCalledWith("page-a", expect.arrayContaining(["editor-user", "revoked-user"]));
    expect(committed).toEqual([1, 1]);
    expect(revoked.close).toHaveBeenCalledWith(4403, "page mutation permission revoked");
    expect(editor.close).not.toHaveBeenCalled();
    expect([...room.doc.getMap("values").keys()].sort()).toEqual(["first", "kept"]);
  });

  it("fails every update of a batch whose transaction fails, without applying any", async () => {
    const firstCommit = deferred<number[]>();
    let calls = 0;
    const recordUpdates = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return firstCommit.promise;
      throw new Error("postgres unavailable");
    });
    const room = new Room("page-a", new Y.Doc(), 0, { pageStore: { recordUpdates } as unknown as PageStore });
    const a = fakeSocket();
    const b = fakeSocket();
    room.addConnection(a);
    room.addConnection(b);

    room.handleMessage(a, updateMessage(keyedUpdate("ok")));
    await waitFor(() => calls === 1);
    room.handleMessage(a, updateMessage(keyedUpdate("lost-a")));
    room.handleMessage(b, updateMessage(keyedUpdate("lost-b")));
    firstCommit.resolve([1]);
    await room.flushDurableUpdates();
    await waitFor(() => vi.mocked(b.close).mock.calls.length === 1);

    expect([...room.doc.getMap("values").keys()]).toEqual(["ok"]);
    expect(a.close).toHaveBeenCalledWith(1011, "update was not persisted; reconnect to replay");
    expect(b.close).toHaveBeenCalledWith(1011, "update was not persisted; reconnect to replay");
  });

  it("splits a backlog by the configured batch limit", async () => {
    const firstCommit = deferred<number[]>();
    const sizes: number[] = [];
    let next = 1;
    const recordUpdates = vi.fn(async (_pageId: string, entries: unknown[]) => {
      sizes.push(entries.length);
      const seqs = entries.map(() => next++);
      return sizes.length === 1 ? firstCommit.promise.then(() => seqs) : seqs;
    });
    const room = new Room("page-a", new Y.Doc(), 0, { pageStore: { recordUpdates } as unknown as PageStore, maxBatchUpdates: 3 });
    const source = fakeSocket();
    room.addConnection(source);

    for (let i = 0; i < 8; i += 1) room.handleMessage(source, updateMessage(keyedUpdate(`k${i}`)));
    await waitFor(() => sizes.length === 1);
    firstCommit.resolve([]);
    await room.flushDurableUpdates();

    expect(sizes).toEqual([1, 3, 3, 1]);
    expect(room.persistedSeq).toBe(8);
  });
});

describe("appendOps", () => {
  it("allocates contiguous sequences per page across batches", async () => {
    const pool = await createTestPool();
    const first = await appendOps(pool, "page-a", [{ update: new Uint8Array([1]) }, { update: new Uint8Array([2]) }]);
    const other = await appendOps(pool, "page-b", [{ update: new Uint8Array([9]) }]);
    const second = await appendOps(pool, "page-a", [
      { update: new Uint8Array([3]) },
      { update: new Uint8Array([4]) },
      { update: new Uint8Array([5]) },
    ]);

    expect(first).toEqual([1, 2]);
    expect(other).toEqual([1]);
    expect(second).toEqual([3, 4, 5]);
    const ops = await getOpsInRange(pool, "page-a", 0);
    expect(ops.map((op) => [op.seq, op.update[0]])).toEqual([
      [1, 1],
      [2, 2],
      [3, 3],
      [4, 4],
      [5, 5],
    ]);
  });

  it("writes outbox rows in the same transaction when asked", async () => {
    const pool = await createTestPool();
    await appendOps(
      pool,
      "page-a",
      [
        { update: new Uint8Array([1]), traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01" },
        { update: new Uint8Array([2]) },
      ],
      {
        enqueueFanout: true,
      }
    );
    const { rows } = await pool.query<{ seq: string; traceparent: string | null }>(
      "SELECT seq, traceparent FROM fanout_outbox ORDER BY seq"
    );
    expect(rows.map((row) => [Number(row.seq), row.traceparent])).toEqual([
      [1, "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01"],
      [2, null],
    ]);
  });

  it("snapshots when a batch crosses a snapshot interval, at the batch's last sequence", async () => {
    const pool = await createTestPool();
    const store = new PageStore(pool);
    const doc = new Y.Doc();
    const entries = (count: number) => Array.from({ length: count }, (_, i) => ({ update: keyedUpdate(`k${i}`) }));

    await store.recordUpdates("page-a", entries(48), () => Y.encodeStateAsUpdate(doc));
    expect(await getLatestSnapshot(pool, "page-a")).toBeNull();
    await store.recordUpdates("page-a", entries(5), () => Y.encodeStateAsUpdate(doc));
    expect((await getLatestSnapshot(pool, "page-a"))?.seq).toBe(53);
  });
});
