import { Worker } from "bullmq";
import type Redis from "ioredis";
import type { Pool } from "pg";
import type { PageStore } from "../persistence/page-store.js";
import { SEARCH_INDEX_QUEUE, PREVIEW_QUEUE, PDF_EXPORT_QUEUE } from "./queues.js";
import type { SearchIndexJobData, PreviewJobData, PdfExportJobData } from "./queues.js";
import { processSearchIndexJob, processPreviewJob, processPdfExportJob } from "./processors.js";
import { childLogger } from "../logger.js";
import { jobsCompletedTotal, jobsFailedTotal } from "../metrics/registry.js";
import { tracer } from "../tracing/tracer.js";
import { contextFromTraceparent } from "../tracing/propagation.js";

const log = childLogger({ module: "jobs/workers" });

/** Runs `fn` inside a "job.process.<name>" span that continues the enqueueing
 *  request's trace via the `traceparent` BullMQ carried in the job data
 *  (see tracing/propagation.ts) — a real cross-process trace link, not just
 *  an in-memory context.with(), since the worker consuming this job may well
 *  be a different Node process than the one that called `.add()`. */
export function traced<T>(name: string, traceparent: string | undefined, fn: () => Promise<T>): Promise<T> {
  const parentContext = contextFromTraceparent(traceparent);
  return tracer.startActiveSpan(name, {}, parentContext, async (span) => {
    try {
      return await fn();
    } finally {
      span.end();
    }
  });
}

/**
 * Starts in-process BullMQ Workers for all three queues. "In-process" is a
 * deliberate scope choice for this project, not an architectural dead end:
 * each Worker only touches Redis (to dequeue) and Postgres (to do the work),
 * exactly like the HTTP server does — nothing here assumes it's running in
 * the same process. Splitting workers into their own deployment later is an
 * infra change (a second container running this same function), not a code
 * change to Room, the queues, or the processors.
 */
export function startWorkers(connection: Redis, pool: Pool, pageStore: PageStore): { close(): Promise<void> } {
  const searchIndexWorker = new Worker<SearchIndexJobData>(
    SEARCH_INDEX_QUEUE,
    async (job) => traced("job.process.search_index", job.data.traceparent, () => processSearchIndexJob(pool, pageStore, job.data.pageId)),
    { connection }
  );
  const previewWorker = new Worker<PreviewJobData>(
    PREVIEW_QUEUE,
    async (job) => traced("job.process.preview", job.data.traceparent, () => processPreviewJob(pool, pageStore, job.data.pageId)),
    { connection }
  );
  const pdfExportWorker = new Worker<PdfExportJobData>(
    PDF_EXPORT_QUEUE,
    async (job) => traced("job.process.pdf_export", job.data.traceparent, () => processPdfExportJob(pool, pageStore, job.data.pageId)),
    { connection }
  );

  for (const [name, worker] of [
    ["search-index", searchIndexWorker],
    ["preview", previewWorker],
    ["pdf-export", pdfExportWorker],
  ] as const) {
    worker.on("completed", () => jobsCompletedTotal.inc({ queue: name }));
    worker.on("failed", (job, err) => {
      jobsFailedTotal.inc({ queue: name });
      log.error({ event: "job_failed", queue: name, jobId: job?.id, err }, "background job failed");
    });
  }

  return {
    async close() {
      await Promise.all([searchIndexWorker.close(), previewWorker.close(), pdfExportWorker.close()]);
    },
  };
}
