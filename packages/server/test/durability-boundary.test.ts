import * as Y from "yjs";
import * as encoding from "lib0/encoding";
import * as syncProtocol from "y-protocols/sync";
import type { WebSocket } from "ws";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBlock, serializeDocument, MessageType } from "@collab/shared";
import { Room } from "../src/room.js";
import type { PageStore } from "../src/persistence/page-store.js";
import type { RoomBroadcaster } from "../src/redis/broadcaster.js";
import { metricsRegistry } from "../src/metrics/registry.js";

beforeEach(() => {
  metricsRegistry.resetMetrics();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function fakeSocket() {
  return {
    OPEN: 1,
    readyState: 1,
    send: vi.fn(),
    close: vi.fn(),
  } as unknown as WebSocket;
}

function fakeBroadcaster(): RoomBroadcaster & { publishUpdate: ReturnType<typeof vi.fn> } {
  return {
    publishUpdate: vi.fn(),
    publishAwareness: vi.fn(),
    subscribeRoom: vi.fn(async () => undefined),
    unsubscribeRoom: vi.fn(),
  };
}

function encodeUpdateMessage(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MessageType.Sync);
  syncProtocol.writeUpdate(encoder, update);
  return encoding.toUint8Array(encoder);
}

function clientUpdate(): Uint8Array {
  const clientDoc = new Y.Doc();
  createBlock(clientDoc, "block-1", { type: "paragraph", text: "must commit first" });
  return Y.encodeStateAsUpdate(clientDoc);
}

async function waitFor(check: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("durable-before-fanout boundary", () => {
  it("drops the empty SyncStep2 handshake update without consuming a durable sequence", async () => {
    const recordUpdates = vi.fn(async () => [1]);
    const broadcaster = fakeBroadcaster();
    const room = new Room("page-a", new Y.Doc(), 0, { pageStore: { recordUpdates } as unknown as PageStore, broadcaster });
    const source = fakeSocket();

    // A fresh y-websocket client answers the gateway's SyncStep1 with this
    // valid empty Yjs update. It is a synchronization no-op, not an edit.
    const emptyDoc = new Y.Doc();
    const emptyUpdate = Y.encodeStateAsUpdate(emptyDoc);
    emptyDoc.destroy();
    room.handleMessage(source, encodeUpdateMessage(emptyUpdate));
    await new Promise((resolve) => setImmediate(resolve));

    expect(recordUpdates).not.toHaveBeenCalled();
    expect(room.persistedSeq).toBe(0);
    expect(broadcaster.publishUpdate).not.toHaveBeenCalled();
  });

  it("repairs a lower cross-gateway sequence after a higher local commit", async () => {
    const source = new Y.Doc();
    const updates: Uint8Array[] = [];
    source.on("update", (update: Uint8Array) => updates.push(update));
    source.getMap<string>("benchmark").set("first", "one");
    source.getMap<string>("benchmark").set("second", "two");

    const recordUpdates = vi.fn(async () => [2]);
    const getOpsInRange = vi.fn(async (_pageId: string, afterSeq: number, uptoSeq: number) =>
      updates.slice(afterSeq, uptoSeq).map((update, index) => ({ seq: afterSeq + index + 1, update }))
    );
    const store = { recordUpdates, getOpsInRange } as unknown as PageStore;
    const room = new Room("page-a", new Y.Doc(), 0, { pageStore: store });

    // This room owns seq=2, but seq=1 was committed by the other gateway and
    // has not arrived through Redis yet. The tracker must not treat seq=2 as
    // proof that seq=1 is already present.
    await room.applyServerUpdate(updates[1]!);
    expect(room.persistedSeq).toBe(2);
    room.applyRemoteUpdate(updates[0]!, 1);
    await new Promise((resolve) => setImmediate(resolve));

    expect(room.persistedSeq).toBe(2);
    // seq=1 is exactly the next expected sequence, so the envelope itself is
    // the missing operation and no durable range read is needed.
    expect(getOpsInRange).not.toHaveBeenCalled();
    const values = room.doc.getMap<string>("benchmark");
    expect(values.get("first")).toBe("one");
    expect(values.get("second")).toBe("two");
  });

  it("does not apply or fan out a client update until its Postgres append resolves", async () => {
    const append = deferred<number[]>();
    const recordUpdates = vi.fn(() => append.promise);
    const broadcaster = fakeBroadcaster();
    const room = new Room("page-a", new Y.Doc(), 0, { pageStore: { recordUpdates } as unknown as PageStore, broadcaster });
    const source = fakeSocket();
    const peer = fakeSocket();
    room.addConnection(source);
    room.addConnection(peer);
    vi.mocked(source.send).mockClear();
    vi.mocked(peer.send).mockClear();

    room.handleMessage(source, encodeUpdateMessage(clientUpdate()));
    await waitFor(() => recordUpdates.mock.calls.length === 1);
    let drainSettled = false;
    const drain = room.flushDurableUpdates().then(() => {
      drainSettled = true;
    });

    // The sender remains optimistic in its own browser Doc, but the server's
    // authoritative Room, same-replica peer, and Redis channel see nothing.
    expect(serializeDocument(room.doc)).toEqual([]);
    expect(peer.send).not.toHaveBeenCalled();
    expect(broadcaster.publishUpdate).not.toHaveBeenCalled();
    expect(await metricsRegistry.metrics()).toContain('collab_updates_total{outcome="accepted"} 1');
    expect(await metricsRegistry.metrics()).toContain("collab_updates_pending 1");
    expect(drainSettled).toBe(false);

    append.resolve([7]);
    await waitFor(() => serializeDocument(room.doc).length === 1);

    expect(room.persistedSeq).toBe(7);
    await drain;
    expect(drainSettled).toBe(true);
    expect(peer.send).toHaveBeenCalledTimes(1);
    expect(broadcaster.publishUpdate).toHaveBeenCalledTimes(1);
    expect(await metricsRegistry.metrics()).toContain('collab_updates_total{outcome="durable"} 1');
    expect(await metricsRegistry.metrics()).toContain("collab_updates_pending 0");
  });

  it("does not leak an update when its append fails and closes the source for replay", async () => {
    const recordUpdates = vi.fn(async () => {
      throw new Error("postgres unavailable");
    });
    const broadcaster = fakeBroadcaster();
    const room = new Room("page-a", new Y.Doc(), 0, { pageStore: { recordUpdates } as unknown as PageStore, broadcaster });
    const source = fakeSocket();
    const peer = fakeSocket();
    room.addConnection(source);
    room.addConnection(peer);
    vi.mocked(source.send).mockClear();
    vi.mocked(peer.send).mockClear();

    room.handleMessage(source, encodeUpdateMessage(clientUpdate()));
    await waitFor(() => vi.mocked(source.close).mock.calls.length === 1);

    expect(serializeDocument(room.doc)).toEqual([]);
    expect(room.persistedSeq).toBe(0);
    expect(peer.send).not.toHaveBeenCalled();
    expect(broadcaster.publishUpdate).not.toHaveBeenCalled();
    expect(source.close).toHaveBeenCalledWith(1011, "update was not persisted; reconnect to replay");
    expect(await metricsRegistry.metrics()).toContain('collab_updates_total{outcome="failed"} 1');
  });

  it("re-checks the authoritative role before append and closes a revoked session", async () => {
    const recordUpdates = vi.fn(async () => [1]);
    const broadcaster = fakeBroadcaster();
    const room = new Room("page-a", new Y.Doc(), 0, {
      pageStore: { recordUpdates } as unknown as PageStore,
      broadcaster,
      mutationAuthorizer: vi.fn(async () => new Map()),
    });
    const source = fakeSocket();
    const peer = fakeSocket();
    room.addConnection(source, "editor", "user-1");
    room.addConnection(peer, "owner", "user-2");
    vi.mocked(peer.send).mockClear();

    room.handleMessage(source, encodeUpdateMessage(clientUpdate()));
    await waitFor(() => vi.mocked(source.close).mock.calls.length === 1);

    expect(source.close).toHaveBeenCalledWith(4403, "page mutation permission revoked");
    expect(recordUpdates).not.toHaveBeenCalled();
    expect(serializeDocument(room.doc)).toEqual([]);
    expect(peer.send).not.toHaveBeenCalled();
  });

  it("makes server-side mutations await the same commit boundary before reporting success", async () => {
    const append = deferred<number[]>();
    const recordUpdates = vi.fn(() => append.promise);
    const broadcaster = fakeBroadcaster();
    const room = new Room("page-a", new Y.Doc(), 0, { pageStore: { recordUpdates } as unknown as PageStore, broadcaster });
    const peer = fakeSocket();
    room.addConnection(peer);
    vi.mocked(peer.send).mockClear();

    const admission = room.applyServerUpdate(clientUpdate());
    await waitFor(() => recordUpdates.mock.calls.length === 1);
    expect(serializeDocument(room.doc)).toEqual([]);
    expect(peer.send).not.toHaveBeenCalled();

    append.resolve([8]);
    await expect(admission).resolves.toBe(8);
    expect(serializeDocument(room.doc)).toHaveLength(1);
    expect(peer.send).toHaveBeenCalledTimes(1);
  });

  it("fans a durable Redis update to local peers without publishing an echo", () => {
    const broadcaster = fakeBroadcaster();
    const room = new Room("page-a", new Y.Doc(), 0, { broadcaster });
    const peer = fakeSocket();
    room.addConnection(peer);
    vi.mocked(peer.send).mockClear();

    room.applyRemoteUpdate(clientUpdate());

    expect(serializeDocument(room.doc)).toHaveLength(1);
    expect(peer.send).toHaveBeenCalledTimes(1);
    expect(broadcaster.publishUpdate).not.toHaveBeenCalled();
  });
});
