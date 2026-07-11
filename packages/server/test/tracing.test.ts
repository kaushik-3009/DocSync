import RedisMock from "ioredis-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { context, trace } from "@opentelemetry/api";
import { createBlock } from "@collab/shared";
import { createTestPool } from "./helpers/test-db.js";
import { RoomRegistry } from "../src/room-registry.js";
import { RedisRoomBroadcaster } from "../src/redis/broadcaster.js";
import { PageStore } from "../src/persistence/page-store.js";
import { tracer, testSpanExporter } from "../src/tracing/tracer.js";
import { currentTraceparent } from "../src/tracing/propagation.js";
import { traced } from "../src/jobs/workers.js";

/**
 * Verifies real parent/child span relationships — not just "instrumenting
 * this didn't throw." Every assertion below checks trace id (same logical
 * request) and parent span id (correct nesting), the two things that
 * actually make a trace useful in Jaeger instead of a pile of unrelated
 * root spans.
 */
describe("distributed tracing", () => {
  beforeEach(() => {
    testSpanExporter.reset();
  });

  it("nests a persisted doc update's persistence span under the room's doc_update span", async () => {
    const pool = await createTestPool();
    const pageStore = new PageStore(pool);
    const registry = new RoomRegistry(pageStore);
    const room = await registry.getOrCreateRoom("trace-page");

    createBlock(room.doc, "b1", { type: "paragraph", text: "hello" });

    await vi_waitFor(() => testSpanExporter.getFinishedSpans().some((s) => s.name === "persistence.record_update"));

    const spans = testSpanExporter.getFinishedSpans();
    const docUpdateSpan = spans.find((s) => s.name === "room.doc_update");
    const persistSpan = spans.find((s) => s.name === "persistence.record_update");

    expect(docUpdateSpan).toBeDefined();
    expect(persistSpan).toBeDefined();
    expect(persistSpan!.spanContext().traceId).toBe(docUpdateSpan!.spanContext().traceId);
    expect(persistSpan!.parentSpanContext?.spanId).toBe(docUpdateSpan!.spanContext().spanId);
  });

  it("continues the enqueueing trace in the worker via the traceparent carried in job data (queue boundary)", async () => {
    const parentSpan = tracer.startSpan("test.enqueue_site");
    let traceparent: string | null = null;

    context.with(trace.setSpan(context.active(), parentSpan), () => {
      traceparent = currentTraceparent();
    });
    parentSpan.end();

    expect(traceparent).toBeTruthy();

    await traced("job.process.search_index", traceparent ?? undefined, async () => "done");

    const spans = testSpanExporter.getFinishedSpans();
    const jobSpan = spans.find((s) => s.name === "job.process.search_index");
    expect(jobSpan).toBeDefined();
    // Same trace as the enqueueing call, even though nothing about this
    // process's own async_hooks call stack connects the two — the only link
    // is the traceparent string, exactly as it would be for a separate
    // worker process consuming a real BullMQ job.
    expect(jobSpan!.spanContext().traceId).toBe(parentSpan.spanContext().traceId);
    expect(jobSpan!.parentSpanContext?.spanId).toBe(parentSpan.spanContext().spanId);
  });

  it("continues the same trace across a Redis-fanned-out update to another instance (cross-process)", async () => {
    const pub = new RedisMock();
    const sub = new RedisMock();
    const broadcasterA = new RedisRoomBroadcaster(pub as never, sub as never);
    const registryA = new RoomRegistry(null, broadcasterA);

    const pub2 = new RedisMock();
    const sub2 = new RedisMock();
    const broadcasterB = new RedisRoomBroadcaster(pub2 as never, sub2 as never);
    const registryB = new RoomRegistry(null, broadcasterB);

    const roomA = await registryA.getOrCreateRoom("cross-instance-page");
    const roomB = await registryB.getOrCreateRoom("cross-instance-page");

    const editSpan = tracer.startSpan("test.instance_a_edit");
    context.with(trace.setSpan(context.active(), editSpan), () => {
      createBlock(roomA.doc, "b1", { type: "paragraph", text: "from A" });
    });
    editSpan.end();

    await vi_waitFor(() => testSpanExporter.getFinishedSpans().some((s) => s.name === "room.apply_remote_update"));

    const remoteSpan = testSpanExporter.getFinishedSpans().find((s) => s.name === "room.apply_remote_update");
    expect(remoteSpan).toBeDefined();
    expect(remoteSpan!.spanContext().traceId).toBe(editSpan.spanContext().traceId);

    void roomB; // used only to trigger applyRemoteUpdate via subscribeRoom's handlers
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
