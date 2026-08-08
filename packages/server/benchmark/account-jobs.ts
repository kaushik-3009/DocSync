/**
 * Captures bounded, page-scoped BullMQ accounting for the persistent chaos
 * workload. Search and preview jobs use the page id as their BullMQ job id and
 * their processors materialize one Postgres row each. Completed jobs are
 * removed from Redis by design, so the output rows are the durable completion
 * evidence; a missing job and missing output is reported as unaccounted rather
 * than being silently called success.
 *
 * Usage (inside the Compose server image):
 *   tsx benchmark/account-jobs.ts <page-id> <phase> [timeout-ms]
 */
import { Queue } from "bullmq";
import Redis from "ioredis";
import pg from "pg";

const { Pool } = pg;

const QUEUES = [
  { name: "search-index", outputTable: "search_index" },
  { name: "preview", outputTable: "page_previews" },
] as const;

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function timeoutMs(): number {
  const value = Number(process.argv[4] ?? 0);
  if (!Number.isInteger(value) || value < 0) throw new Error("timeout-ms must be a non-negative integer");
  return value;
}

type QueueObservation = {
  queue: string;
  jobId: string;
  state: string | null;
  outputPresent: boolean;
  accountedAs: "completed" | "failed" | "remaining" | "unaccounted";
  counts: Record<string, number>;
};

async function observe(pageId: string, pool: pg.Pool, queues: Array<Queue<any>>): Promise<QueueObservation[]> {
  const observations: QueueObservation[] = [];
  for (const [index, definition] of QUEUES.entries()) {
    const queue = queues[index];
    const job = await queue.getJob(pageId);
    const state = job ? String(await job.getState()) : null;
    const output = await pool.query<{ present: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM ${definition.outputTable} WHERE page_id = $1) AS present`,
      [pageId]
    );
    const outputPresent = Boolean(output.rows[0]?.present);
    const accountedAs: QueueObservation["accountedAs"] = outputPresent
      ? "completed"
      : state === "failed"
        ? "failed"
        : state === "waiting" || state === "active" || state === "delayed" || state === "paused"
          ? "remaining"
          : "unaccounted";
    const rawCounts = await queue.getJobCounts("waiting", "active", "completed", "failed", "delayed", "paused");
    observations.push({
      queue: definition.name,
      jobId: pageId,
      state,
      outputPresent,
      accountedAs,
      counts: Object.fromEntries(Object.entries(rawCounts).map(([key, value]) => [key, Number(value)])),
    });
  }
  return observations;
}

async function main(): Promise<void> {
  const pageId = process.argv[2];
  const phase = process.argv[3] ?? "snapshot";
  if (!pageId || !/^[A-Za-z0-9_-]+$/.test(pageId)) throw new Error("page-id must contain only letters, digits, _ or -");

  const redisUrl = required("REDIS_URL");
  const databaseUrl = required("DATABASE_URL");
  const pool = new Pool({ connectionString: databaseUrl });
  const redisConnections = QUEUES.map(() => new Redis(redisUrl, { maxRetriesPerRequest: null }));
  const queues = QUEUES.map((definition, index) => new Queue(definition.name, { connection: redisConnections[index] }));
  const waitMs = timeoutMs();
  const deadline = Date.now() + waitMs;
  let observations = await observe(pageId, pool, queues);
  while (waitMs > 0 && observations.some((item) => item.accountedAs === "remaining" || item.accountedAs === "unaccounted") && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    observations = await observe(pageId, pool, queues);
  }

  const completedJobs = observations.filter((item) => item.accountedAs === "completed").length;
  const failedJobs = observations.filter((item) => item.accountedAs === "failed").length;
  const remainingJobs = observations.filter((item) => item.accountedAs === "remaining").length;
  const unaccountedJobs = observations.filter((item) => item.accountedAs === "unaccounted").length;
  const result = {
    schemaVersion: 1,
    pageId,
    phase,
    observedAt: new Date().toISOString(),
    expectedJobs: QUEUES.length,
    completedJobs,
    failedJobs,
    remainingJobs,
    unaccountedJobs,
    terminal: remainingJobs === 0 && unaccountedJobs === 0,
    queues: observations,
    claimBoundary: "Expected is one coalesced search-index and one preview job for this page. Completed is the processor output row; failed is the BullMQ failed state; remaining is a waiting/active/delayed/paused job. Missing Redis job and output is unaccounted, not success.",
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  await Promise.all(queues.map((queue) => queue.close().catch(() => undefined)));
  await Promise.all(redisConnections.map((connection) => connection.quit().catch(() => undefined)));
  await pool.end().catch(() => undefined);
  if (!result.terminal) process.exitCode = 2;
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
