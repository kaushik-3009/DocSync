import * as Y from "yjs";
import { beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createTestPool } from "./helpers/test-db.js";
import { appendOp, getOpsInRange, getCurrentSeq, updateFingerprint } from "../src/persistence/ops-log.js";
import { saveSnapshot, getLatestSnapshot, listSnapshotSeqs, listSnapshots } from "../src/persistence/snapshots.js";
import { replayDocument } from "../src/persistence/replay.js";
import { PageStore } from "../src/persistence/page-store.js";
import { createBlock, getBlockText, serializeDocument } from "@collab/shared";

let pool: Pool;

beforeEach(async () => {
  pool = await createTestPool();
});

describe("ops-log", () => {
  it("allocates gap-free, per-page monotonic sequence numbers", async () => {
    const seq1 = await appendOp(pool, "page-a", new Uint8Array([1]));
    const seq2 = await appendOp(pool, "page-a", new Uint8Array([2]));
    const seqOtherPage = await appendOp(pool, "page-b", new Uint8Array([9]));

    expect(seq1).toBe(1);
    expect(seq2).toBe(2);
    expect(seqOtherPage).toBe(1); // separate counter per page

    expect(await getCurrentSeq(pool, "page-a")).toBe(2);
  });

  it("returns ops within a seq range in order", async () => {
    for (let i = 1; i <= 5; i++) {
      await appendOp(pool, "page-a", new Uint8Array([i]));
    }
    const middle = await getOpsInRange(pool, "page-a", 1, 3);
    expect(middle.map((o) => o.seq)).toEqual([2, 3]);

    const rest = await getOpsInRange(pool, "page-a", 3);
    expect(rest.map((o) => o.seq)).toEqual([4, 5]);
  });

  it("persists an exact-update fingerprint without changing the y-websocket wire frame", async () => {
    const update = new Uint8Array([1, 2, 3]);
    await appendOp(pool, "page-a", update);
    const result = await pool.query<{ update_fingerprint: string }>(
      "SELECT update_fingerprint FROM ops_log WHERE page_id = $1 AND seq = $2",
      ["page-a", 1]
    );

    expect(result.rows[0]?.update_fingerprint).toBe(updateFingerprint(update));
    expect(updateFingerprint(update)).toHaveLength(64);
  });

  it("persists optional benchmark mutation metadata beside the durable update", async () => {
    await appendOp(pool, "page-metadata", new Uint8Array([4, 5]), {
      enqueueFanout: true,
      clientMutationId: "run-1-0-0",
      clientCreatedAtMs: 1_725_000_000_000,
      traceparent: "00-abc-def-01",
    });

    const ops = await pool.query<{ client_mutation_id: string; client_created_at_ms: string | number }>(
      "SELECT client_mutation_id, client_created_at_ms FROM ops_log WHERE page_id = $1",
      ["page-metadata"]
    );
    const outbox = await pool.query<{ client_mutation_id: string; client_created_at_ms: string | number; traceparent: string }>(
      "SELECT client_mutation_id, client_created_at_ms, traceparent FROM fanout_outbox WHERE page_id = $1",
      ["page-metadata"]
    );

    expect(ops.rows[0]?.client_mutation_id).toBe("run-1-0-0");
    expect(Number(ops.rows[0]?.client_created_at_ms)).toBe(1_725_000_000_000);
    expect(outbox.rows[0]?.client_mutation_id).toBe("run-1-0-0");
    expect(Number(outbox.rows[0]?.client_created_at_ms)).toBe(1_725_000_000_000);
    expect(outbox.rows[0]?.traceparent).toBe("00-abc-def-01");
  });
});

describe("snapshots", () => {
  it("returns the latest snapshot at or before a given seq", async () => {
    await saveSnapshot(pool, "page-a", 10, new Uint8Array([1]));
    await saveSnapshot(pool, "page-a", 20, new Uint8Array([2]));

    expect((await getLatestSnapshot(pool, "page-a"))?.seq).toBe(20);
    expect((await getLatestSnapshot(pool, "page-a", 15))?.seq).toBe(10);
    expect(await getLatestSnapshot(pool, "page-a", 5)).toBeNull();
    expect(await listSnapshotSeqs(pool, "page-a")).toEqual([20, 10]);
  });

  it("listSnapshots includes each snapshot's creation time, newest first", async () => {
    await saveSnapshot(pool, "page-a", 10, new Uint8Array([1]));
    await saveSnapshot(pool, "page-a", 20, new Uint8Array([2]));

    const summaries = await listSnapshots(pool, "page-a");
    expect(summaries.map((s) => s.seq)).toEqual([20, 10]);
    for (const s of summaries) {
      expect(typeof s.createdAt).toBe("string");
      expect(Number.isNaN(Date.parse(s.createdAt))).toBe(false);
    }
  });
});

describe("replayDocument", () => {
  it("reconstructs identical state from snapshot + trailing ops", async () => {
    const doc = new Y.Doc();
    createBlock(doc, "b1", { type: "paragraph", text: "hello" });
    await appendOp(pool, "page-a", Y.encodeStateAsUpdate(doc));

    // snapshot at seq 1 captures the doc as it stood after that one op
    await saveSnapshot(pool, "page-a", 1, Y.encodeStateAsUpdate(doc));

    // a further op after the snapshot
    getBlockText(doc, "b1")?.insert(5, " world");
    await appendOp(pool, "page-a", Y.encodeStateAsUpdate(doc));

    const { doc: replayed, seq } = await replayDocument(pool, "page-a");
    expect(seq).toBe(2);
    expect(serializeDocument(replayed)).toEqual(serializeDocument(doc));
  });

  it("replays to an earlier version for version history", async () => {
    const doc = new Y.Doc();
    createBlock(doc, "b1", { type: "paragraph", text: "v1" });
    const store = new PageStore(pool);
    await store.recordUpdate("page-a", Y.encodeStateAsUpdate(doc), () => Y.encodeStateAsUpdate(doc));

    createBlock(doc, "b2", { type: "paragraph", text: "v2" });
    const seq2 = await store.recordUpdate("page-a", Y.encodeStateAsUpdate(doc), () => Y.encodeStateAsUpdate(doc));

    const atV1 = await store.replayAt("page-a", 1);
    const atV2 = await store.replayAt("page-a", seq2);

    expect(serializeDocument(atV1).map((b) => b.text)).toEqual(["v1"]);
    expect(serializeDocument(atV2).map((b) => b.text)).toEqual(["v1", "v2"]);
  });

});

describe("PageStore", () => {
  it("lists every durable operation as version history, not only snapshot checkpoints", async () => {
    const store = new PageStore(pool);
    const doc = new Y.Doc();

    for (let i = 1; i <= 2; i++) {
      createBlock(doc, `history-${i}`, { type: "paragraph", text: `version ${i}` });
      await store.recordUpdate("page-history", Y.encodeStateAsUpdate(doc), () => Y.encodeStateAsUpdate(doc));
    }

    expect(await store.listVersions("page-history")).toEqual([2, 1]);
    expect((await store.listVersionDetails("page-history")).map((version) => version.seq)).toEqual([2, 1]);
  });

  it("takes a snapshot every SNAPSHOT_INTERVAL ops", async () => {
    const store = new PageStore(pool);
    const doc = new Y.Doc();

    for (let i = 0; i < 50; i++) {
      createBlock(doc, `b${i}`, { type: "paragraph", text: `block ${i}` });
      await store.recordUpdate("page-a", Y.encodeStateAsUpdate(doc), () => Y.encodeStateAsUpdate(doc));
    }

    const versions = await store.listVersions("page-a");
    expect(versions).toContain(50);

    const details = await store.listVersionDetails("page-a");
    expect(details.map((v) => v.seq)).toContain(50);
    expect(Number.isNaN(Date.parse(details[0].createdAt))).toBe(false);
  });

  it("loadPage on a fresh PageStore reconstructs a previously-persisted room's state (simulated restart)", async () => {
    const store = new PageStore(pool);
    const doc = new Y.Doc();
    createBlock(doc, "b1", { type: "paragraph", text: "before restart" });
    await store.recordUpdate("page-a", Y.encodeStateAsUpdate(doc), () => Y.encodeStateAsUpdate(doc));

    // Simulate a process restart: a brand new PageStore instance (same pool/DB),
    // no in-memory Room state left over.
    const storeAfterRestart = new PageStore(pool);
    const { doc: reloaded, seq } = await storeAfterRestart.loadPage("page-a");

    expect(seq).toBe(1);
    expect(serializeDocument(reloaded)).toEqual(serializeDocument(doc));
  });

  it("loadPage on a page with no history returns an empty doc at seq 0", async () => {
    const store = new PageStore(pool);
    const { doc, seq } = await store.loadPage("never-touched-page");
    expect(seq).toBe(0);
    expect(serializeDocument(doc)).toEqual([]);
  });
});
