import { randomUUID } from "node:crypto";
import type { Queue } from "bullmq";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dirtyKey, markDirty, processUntilClean, requeueIfDirty } from "../src/jobs/coalescing.js";
import { createTestRedis } from "./helpers/test-redis.js";

const redis = createTestRedis();
const fakeQueue = (name: string) => ({ name, add: vi.fn(async () => undefined) }) as unknown as Queue & { add: ReturnType<typeof vi.fn> };

afterEach(() => vi.restoreAllMocks());

describe("coalescing page jobs", () => {
  it("runs once when nothing changes during processing", async () => {
    const page = randomUUID();
    await redis.set(dirtyKey("q", page), "1");
    const process = vi.fn(async () => undefined);
    await processUntilClean(redis, "q", page, process);
    expect(process).toHaveBeenCalledTimes(1);
    expect(await redis.exists(dirtyKey("q", page))).toBe(0);
  });

  it("re-runs when an edit lands while the job is processing", async () => {
    const page = randomUUID();
    let runs = 0;
    await processUntilClean(redis, "q", page, async () => {
      runs += 1;
      // An edit commits mid-run: its add() would be ignored by BullMQ because
      // this job is active, but its dirty mark is not.
      if (runs === 1) await redis.set(dirtyKey("q", page), "1");
    });
    expect(runs).toBe(2);
  });

  it("re-queues after completion when an edit landed after the final check", async () => {
    const page = randomUUID();
    const queue = fakeQueue("q");
    await requeueIfDirty(redis, queue, page);
    expect(queue.add).not.toHaveBeenCalled();
    await redis.set(dirtyKey("q", page), "1");
    await requeueIfDirty(redis, queue, page);
    expect(queue.add).toHaveBeenCalledWith("q", { pageId: page }, expect.objectContaining({ jobId: page }));
  });

  it("marks the page dirty before enqueueing", async () => {
    const page = randomUUID();
    const queue = fakeQueue("q");
    queue.add.mockImplementation(async () => {
      expect(await redis.exists(dirtyKey("q", page))).toBe(1);
    });
    await markDirty(redis, queue, page, { traceparent: "t" });
    expect(queue.add).toHaveBeenCalledWith("q", { pageId: page, traceparent: "t" }, expect.objectContaining({ jobId: page }));
  });
});
