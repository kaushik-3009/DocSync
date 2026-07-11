import { Queue } from "bullmq";
import type Redis from "ioredis";
import { tracer } from "../tracing/tracer.js";
import { currentTraceparent } from "../tracing/propagation.js";

export const SEARCH_INDEX_QUEUE = "search-index";
export const PREVIEW_QUEUE = "preview";
export const PDF_EXPORT_QUEUE = "pdf-export";

// `traceparent` carries the enqueueing request's trace across the Redis/BullMQ
// boundary — see tracing/propagation.ts. Optional because a job enqueued with
// no active span (e.g. directly from a test) simply starts a new trace when
// the worker picks it up, same as any other untraced entry point.
export interface SearchIndexJobData {
  pageId: string;
  traceparent?: string;
}
export interface PreviewJobData {
  pageId: string;
  traceparent?: string;
}
export interface PdfExportJobData {
  pageId: string;
  traceparent?: string;
}

/**
 * Thin wrapper the rest of the server depends on instead of BullMQ directly —
 * same "seam, not a leaked implementation detail" pattern as RoomBroadcaster
 * (Phase 4) and PageStore (Phase 2). A Room only ever calls
 * `enqueueSearchIndex`/`enqueuePreview`; it has no idea BullMQ (or Redis)
 * is involved, so swapping job runners later doesn't touch Room.
 */
export class JobQueues {
  private readonly searchIndex: Queue<SearchIndexJobData>;
  private readonly preview: Queue<PreviewJobData>;
  private readonly pdfExport: Queue<PdfExportJobData>;

  constructor(connection: Redis) {
    this.searchIndex = new Queue(SEARCH_INDEX_QUEUE, { connection });
    this.preview = new Queue(PREVIEW_QUEUE, { connection });
    this.pdfExport = new Queue(PDF_EXPORT_QUEUE, { connection });
  }

  /** Uses pageId as the BullMQ jobId: a page with edits arriving faster than the
   *  job can process coalesces into a single pending re-index rather than queuing
   *  one job per keystroke — BullMQ ignores add() calls that reuse an already
   *  waiting/active job's id instead of erroring or duplicating. */
  async enqueueSearchIndex(pageId: string): Promise<void> {
    return tracer.startActiveSpan("job.enqueue.search_index", { attributes: { "collab.page_id": pageId } }, async (span) => {
      try {
        await this.searchIndex.add(
          "index",
          { pageId, traceparent: currentTraceparent() ?? undefined },
          { jobId: pageId, removeOnComplete: true, removeOnFail: 20 }
        );
      } finally {
        span.end();
      }
    });
  }

  async enqueuePreview(pageId: string): Promise<void> {
    return tracer.startActiveSpan("job.enqueue.preview", { attributes: { "collab.page_id": pageId } }, async (span) => {
      try {
        await this.preview.add(
          "preview",
          { pageId, traceparent: currentTraceparent() ?? undefined },
          { jobId: pageId, removeOnComplete: true, removeOnFail: 20 }
        );
      } finally {
        span.end();
      }
    });
  }

  /** Not deduplicated by pageId — each export request should produce its own artifact.
   *
   *  `removeOnComplete` is a bounded *retention window*, not `true` (unlike
   *  searchIndex/preview above, which nobody ever polls, so removing them the
   *  instant they finish is fine): the client polls `getPdfExportJobStatus`
   *  every ~1s specifically to read the completed job's `returnvalue`
   *  (`exportId`). `removeOnComplete: true` deleted the job from Redis the
   *  instant it finished — often faster than the client's next poll — so
   *  `getJob` below returned `null` and every export looked like it failed,
   *  even though the PDF itself was generated and saved successfully. Keeping
   *  completed jobs for an hour (or the most recent 500) is ample time for
   *  any real poller while still bounding Redis growth. */
  async enqueuePdfExport(pageId: string): Promise<string> {
    return tracer.startActiveSpan("job.enqueue.pdf_export", { attributes: { "collab.page_id": pageId } }, async (span) => {
      try {
        const job = await this.pdfExport.add(
          "export",
          { pageId, traceparent: currentTraceparent() ?? undefined },
          { removeOnComplete: { count: 500, age: 3600 }, removeOnFail: 20 }
        );
        return job.id ?? "";
      } finally {
        span.end();
      }
    });
  }

  /** Lets an HTTP caller poll a PDF export request by BullMQ job id. Once `state` is
   *  "completed", `exportId` is the row in the `exports` table to fetch via GET /exports/:id
   *  (the processor's return value becomes the job's `returnvalue`). */
  async getPdfExportJobStatus(jobId: string): Promise<{ state: string; exportId?: string } | null> {
    const job = await this.pdfExport.getJob(jobId);
    if (!job) return null;
    const state = await job.getState();
    return { state, exportId: state === "completed" ? (job.returnvalue as string) : undefined };
  }

  async close(): Promise<void> {
    await Promise.all([this.searchIndex.close(), this.preview.close(), this.pdfExport.close()]);
  }
}
