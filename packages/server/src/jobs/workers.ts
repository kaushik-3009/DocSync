import type { ExportStorage } from "../exports/storage.js";
import type { SemanticIndex } from "../search/semantic.js";
import { Queue, Worker } from "bullmq";
import type Redis from "ioredis";
import type { Pool } from "pg";
import type { PageStore } from "../persistence/page-store.js";
import { randomUUID } from "node:crypto";
import type { Agent } from "undici";
import {
  SEARCH_INDEX_QUEUE,
  PREVIEW_QUEUE,
  PDF_EXPORT_QUEUE,
  WEBHOOK_EVENTS_QUEUE,
  WEBHOOK_DELIVERY_QUEUE,
  WEBHOOK_DEBOUNCE_MS,
  type JobQueues,
} from "./queues.js";
import { deliverWebhook, type DeliveryJob } from "../webhooks/delivery.js";
import { webhookTargets } from "../webhooks/store.js";
import type { SearchIndexJobData, PreviewJobData, PdfExportJobData } from "./queues.js";
import { processUntilClean, requeueIfDirty } from "./coalescing.js";
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
export interface WorkerDependencies {
  pool: Pool;
  /** Fans page events out into per-webhook deliveries. */
  jobQueues: JobQueues;
  /** HTTP agent that refuses private destinations (see safe-fetch.ts). */
  webhookAgent: Agent;
  pageStore: PageStore;
  exportStorage: ExportStorage;
  /** Null when pgvector is unavailable; keyword indexing still runs. */
  semanticIndex: SemanticIndex | null;
}

export function startWorkers(
  connection: Redis,
  { pool, pageStore, exportStorage, semanticIndex, jobQueues, webhookAgent }: WorkerDependencies
): { close(): Promise<void> } {
  const searchIndexWorker = new Worker<SearchIndexJobData>(
    SEARCH_INDEX_QUEUE,
    async (job) =>
      traced("job.process.search_index", job.data.traceparent, () =>
        processUntilClean(connection, SEARCH_INDEX_QUEUE, job.data.pageId, () =>
          processSearchIndexJob(pool, pageStore, job.data.pageId, semanticIndex)
        )
      ),
    { connection }
  );
  const previewWorker = new Worker<PreviewJobData>(
    PREVIEW_QUEUE,
    async (job) =>
      traced("job.process.preview", job.data.traceparent, () =>
        processUntilClean(connection, PREVIEW_QUEUE, job.data.pageId, () => processPreviewJob(pool, pageStore, job.data.pageId))
      ),
    { connection }
  );

  const webhookEventsWorker = new Worker<{ pageId: string }>(
    WEBHOOK_EVENTS_QUEUE,
    async (job) =>
      processUntilClean(connection, WEBHOOK_EVENTS_QUEUE, job.data.pageId, async () => {
        const targets = await webhookTargets(pool, job.data.pageId);
        if (targets.length === 0) return;
        const payload = { pageId: job.data.pageId, seq: await pageStore.currentSeq(job.data.pageId), occurredAt: new Date().toISOString() };
        for (const target of targets) {
          await jobQueues.enqueueWebhookDelivery({ deliveryId: randomUUID(), webhookId: target.id, event: "page.updated", payload });
        }
      }),
    { connection }
  );
  const webhookDeliveryWorker = new Worker<DeliveryJob>(
    WEBHOOK_DELIVERY_QUEUE,
    async (job) => deliverWebhook({ pool, agent: webhookAgent }, job.data, job.attemptsMade + 1),
    { connection, concurrency: 8 }
  );

  // Close the last gap: an edit that marked the page dirty after the
  // processor's final check, while the job was still active.
  const requeueQueues = {
    search: new Queue(SEARCH_INDEX_QUEUE, { connection }),
    preview: new Queue(PREVIEW_QUEUE, { connection }),
    webhooks: new Queue(WEBHOOK_EVENTS_QUEUE, { connection }),
  };
  webhookEventsWorker.on(
    "completed",
    (job) => void requeueIfDirty(connection, requeueQueues.webhooks, job.data.pageId, WEBHOOK_DEBOUNCE_MS).catch(() => undefined)
  );
  searchIndexWorker.on("completed", (job) => void requeueIfDirty(connection, requeueQueues.search, job.data.pageId).catch(() => undefined));
  previewWorker.on("completed", (job) => void requeueIfDirty(connection, requeueQueues.preview, job.data.pageId).catch(() => undefined));
  const pdfExportWorker = new Worker<PdfExportJobData>(
    PDF_EXPORT_QUEUE,
    async (job) =>
      traced("job.process.pdf_export", job.data.traceparent, () => processPdfExportJob(exportStorage, pageStore, job.data.pageId)),
    { connection }
  );

  for (const [name, worker] of [
    ["search-index", searchIndexWorker],
    ["preview", previewWorker],
    ["pdf-export", pdfExportWorker],
    ["webhook-events", webhookEventsWorker],
    ["webhook-delivery", webhookDeliveryWorker],
  ] as const) {
    worker.on("completed", () => jobsCompletedTotal.inc({ queue: name }));
    worker.on("failed", (job, err) => {
      jobsFailedTotal.inc({ queue: name });
      log.error({ event: "job_failed", queue: name, jobId: job?.id, err }, "background job failed");
    });
  }

  return {
    async close() {
      await Promise.all([
        searchIndexWorker.close(),
        previewWorker.close(),
        pdfExportWorker.close(),
        webhookEventsWorker.close(),
        webhookDeliveryWorker.close(),
      ]);
      await Promise.all(Object.values(requeueQueues).map((queue) => queue.close()));
    },
  };
}
