import type Redis from "ioredis";
import type { Queue } from "bullmq";

/**
 * Per-page jobs that must eventually see a page's latest state (search index,
 * preview) while coalescing bursts of edits into few runs.
 *
 * BullMQ ignores `add()` for a jobId that exists in *any* state, including
 * active, so jobId-based dedup alone silently drops an edit that commits
 * while its page's job is running. A Redis "dirty" key closes that gap:
 *
 * 1. `markDirty` sets the key, then adds the job (which may be ignored).
 * 2. The processor clears the key *before* reading the page and loops while
 *    the key was set again during the run.
 * 3. After the job finishes, `requeueIfDirty` re-adds it if the key is set,
 *    covering an edit that landed after the processor's last check.
 *
 * Every edit therefore happens before some run's read, while a burst still
 * collapses into one or two runs.
 */
export function dirtyKey(queue: string, pageId: string): string {
  return `jobs:dirty:${queue}:${pageId}`;
}

export async function markDirty(redis: Redis, queue: Queue, pageId: string, data: Record<string, unknown>): Promise<void> {
  await redis.set(dirtyKey(queue.name, pageId), "1");
  await queue.add(queue.name, { pageId, ...data }, { jobId: pageId, removeOnComplete: true, removeOnFail: 20 });
}

/** Runs `process` until the page stops changing underneath it (bounded so a
 *  page under constant editing can't pin a worker). */
export async function processUntilClean(
  redis: Redis,
  queue: string,
  pageId: string,
  process: () => Promise<void>,
  maxRounds = 5
): Promise<void> {
  const key = dirtyKey(queue, pageId);
  for (let round = 0; round < maxRounds; round += 1) {
    await redis.del(key);
    await process();
    if (!(await redis.exists(key))) return;
  }
}

export async function requeueIfDirty(redis: Redis, queue: Queue, pageId: string): Promise<void> {
  if (await redis.exists(dirtyKey(queue.name, pageId))) {
    await queue.add(queue.name, { pageId }, { jobId: pageId, removeOnComplete: true, removeOnFail: 20 });
  }
}
