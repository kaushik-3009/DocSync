import * as Y from "yjs";
import type { Pool } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestPool } from "./helpers/test-db.js";
import { PageStore } from "../src/persistence/page-store.js";
import { FanoutOutbox, type CommittedUpdatePublisher } from "../src/persistence/fanout-outbox.js";
import { Room } from "../src/room.js";
import type { RoomBroadcaster } from "../src/redis/broadcaster.js";
import { createBlock } from "@collab/shared";

let pool: Pool;

beforeEach(async () => {
  pool = await createTestPool();
});

function committedUpdate(): Uint8Array {
  const doc = new Y.Doc();
  createBlock(doc, "block-1", { type: "paragraph", text: "outbox event" });
  return Y.encodeStateAsUpdate(doc);
}

async function waitFor(check: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for outbox delivery");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("transactional fanout outbox", () => {
  it("records exactly one pending fanout event in the same durable operation and marks it delivered after Redis acknowledges", async () => {
    const store = new PageStore(pool);
    const update = committedUpdate();
    await store.recordUpdate("page-a", update, () => update, { enqueueFanout: true });

    const publisher: CommittedUpdatePublisher = { publishCommittedUpdate: vi.fn(async () => undefined) };
    const outbox = new FanoutOutbox(pool, publisher, { retryBaseMs: 0 });
    expect(await outbox.pendingCount()).toBe(1);

    await outbox.drain();

    expect(publisher.publishCommittedUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ pageId: "page-a", seq: 1, update })
    );
    expect(await outbox.pendingCount()).toBe(0);
  });

  it("retains a failed Redis publish for a later retry instead of dropping the committed mutation", async () => {
    const store = new PageStore(pool);
    const update = committedUpdate();
    await store.recordUpdate("page-a", update, () => update, { enqueueFanout: true });

    const publisher: CommittedUpdatePublisher = {
      publishCommittedUpdate: vi.fn().mockRejectedValueOnce(new Error("redis unavailable")).mockResolvedValueOnce(undefined),
    };
    const outbox = new FanoutOutbox(pool, publisher, { retryBaseMs: 0 });

    await outbox.drain();
    expect(await outbox.pendingCount()).toBe(1);

    await outbox.drain();
    expect(publisher.publishCommittedUpdate).toHaveBeenCalledTimes(2);
    expect(await outbox.pendingCount()).toBe(0);
  });

  it("does not create an outbox event when fanout was intentionally disabled", async () => {
    const store = new PageStore(pool);
    const update = committedUpdate();
    await store.recordUpdate("page-a", update, () => update);

    const publisher: CommittedUpdatePublisher = { publishCommittedUpdate: vi.fn(async () => undefined) };
    const outbox = new FanoutOutbox(pool, publisher);
    expect(await outbox.pendingCount()).toBe(0);
  });

  it("publishes committed updates in page-local sequence order", async () => {
    const store = new PageStore(pool);
    const first = committedUpdate();
    const second = new Uint8Array([...first, 1]);
    await store.recordUpdate("page-a", first, () => first, { enqueueFanout: true });
    await store.recordUpdate("page-a", second, () => second, { enqueueFanout: true });

    const publishedSeqs: number[] = [];
    const publisher: CommittedUpdatePublisher = {
      publishCommittedUpdate: vi.fn(async ({ seq }) => {
        publishedSeqs.push(seq);
      }),
    };
    const outbox = new FanoutOutbox(pool, publisher);

    await outbox.drain();

    expect(publishedSeqs).toEqual([1, 2]);
    expect(await outbox.pendingCount()).toBe(0);
  });

  it("uses the outbox instead of directly publishing a durable Room update", async () => {
    const store = new PageStore(pool);
    const publisher: CommittedUpdatePublisher = { publishCommittedUpdate: vi.fn(async () => undefined) };
    const outbox = new FanoutOutbox(pool, publisher);
    const directPublish = vi.fn();
    const broadcaster: RoomBroadcaster = {
      publishUpdate: directPublish,
      publishAwareness: vi.fn(),
      subscribeRoom: vi.fn(async () => undefined),
      unsubscribeRoom: vi.fn(),
    };
    const room = new Room("page-a", new Y.Doc(), 0, { pageStore: store, broadcaster, fanoutOutbox: outbox });

    createBlock(room.doc, "block-1", { type: "paragraph", text: "through outbox" });
    await waitFor(() => vi.mocked(publisher.publishCommittedUpdate).mock.calls.length === 1);

    expect(directPublish).not.toHaveBeenCalled();
    expect(await outbox.pendingCount()).toBe(0);
  });

  it("leaves rows younger than the sweep grace window to the committing gateway", async () => {
    const store = new PageStore(pool);
    const update = committedUpdate();
    await store.recordUpdate("page-a", update, () => update, { enqueueFanout: true });
    const publisher: CommittedUpdatePublisher = { publishCommittedUpdate: vi.fn(async () => undefined) };
    const outbox = new FanoutOutbox(pool, publisher);

    await outbox.drain({ minAgeMs: 60_000 });
    expect(publisher.publishCommittedUpdate).not.toHaveBeenCalled();
    await outbox.drain();
    expect(publisher.publishCommittedUpdate).toHaveBeenCalledTimes(1);
  });

  it("acknowledges fast-path publishes so the sweeper never republishes them", async () => {
    const store = new PageStore(pool);
    const update = committedUpdate();
    const seq = await store.recordUpdate("page-a", update, () => update, { enqueueFanout: true });
    const publisher: CommittedUpdatePublisher = { publishCommittedUpdate: vi.fn(async () => undefined) };
    const outbox = new FanoutOutbox(pool, publisher);

    await outbox.publishCommitted([{ pageId: "page-a", seq, update, traceparent: null }]);
    expect(await outbox.pendingCount()).toBe(0);
    await outbox.drain();
    expect(publisher.publishCommittedUpdate).toHaveBeenCalledTimes(1);
  });

  it("keeps a fast-path row whose publish failed for the sweeper", async () => {
    const store = new PageStore(pool);
    const update = committedUpdate();
    const seq = await store.recordUpdate("page-a", update, () => update, { enqueueFanout: true });
    const publisher: CommittedUpdatePublisher = {
      publishCommittedUpdate: vi.fn().mockRejectedValueOnce(new Error("redis unavailable")).mockResolvedValue(undefined),
    };
    const outbox = new FanoutOutbox(pool, publisher);

    await outbox.publishCommitted([{ pageId: "page-a", seq, update, traceparent: null }]);
    expect(await outbox.pendingCount()).toBe(1);
    await outbox.drain();
    expect(await outbox.pendingCount()).toBe(0);
  });

  it("lets only one of two concurrent sweepers lease a row", async () => {
    const store = new PageStore(pool);
    for (let i = 0; i < 5; i += 1) {
      const update = new Uint8Array([...committedUpdate(), i]);
      await store.recordUpdate("page-a", update, () => update, { enqueueFanout: true });
    }
    const published: number[] = [];
    const publisher: CommittedUpdatePublisher = {
      publishCommittedUpdate: vi.fn(async ({ seq }) => {
        published.push(seq);
      }),
    };
    await Promise.all([new FanoutOutbox(pool, publisher).drain(), new FanoutOutbox(pool, publisher).drain()]);

    expect(published.sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it("prunes delivered rows past the retention window", async () => {
    const store = new PageStore(pool);
    const update = committedUpdate();
    await store.recordUpdate("page-a", update, () => update, { enqueueFanout: true });
    const outbox = new FanoutOutbox(pool, { publishCommittedUpdate: vi.fn(async () => undefined) });
    await outbox.drain();

    expect(await outbox.prune(60_000)).toBe(0);
    expect(await outbox.prune(-1)).toBe(1);
    const { rows } = await pool.query("SELECT 1 FROM fanout_outbox");
    expect(rows).toHaveLength(0);
  });
});
