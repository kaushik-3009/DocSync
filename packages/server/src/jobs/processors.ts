import { randomUUID } from "node:crypto";
import PDFDocument from "pdfkit";
import type { Pool } from "pg";
import type * as Y from "yjs";
import { serializeDocument } from "@collab/shared";
import type { PageStore } from "../persistence/page-store.js";
import { childLogger } from "../logger.js";

const log = childLogger({ module: "jobs/processors" });

const PREVIEW_LENGTH = 200;

/**
 * The actual business logic for each background job, deliberately kept as
 * plain async functions independent of BullMQ. BullMQ's Worker wiring
 * (jobs/workers.ts) is a thin adapter around these — which is also why
 * these are unit-tested directly against pg-mem rather than through a real
 * queue: BullMQ relies on Redis Lua scripting for its atomicity guarantees,
 * which ioredis-mock (used for Phase 4's fanout tests) doesn't reliably
 * support. Testing "does the job body do the right thing to Postgres"
 * doesn't require also proving "does BullMQ dequeue it" — that part is
 * covered by the manual verification steps in TESTING.md against a real
 * Redis via docker-compose.
 */

// Joined with a space, not a newline: besides reading fine for search/preview
// purposes, pg-mem's ILIKE doesn't match a `%` wildcard across a literal
// newline character (real Postgres has no such limitation, but there's no
// reason to depend on the difference when a space works everywhere).
function extractPlainText(doc: Y.Doc): string {
  return serializeDocument(doc)
    .map((b) => b.text)
    .join(" ")
    .trim();
}

export async function processSearchIndexJob(pool: Pool, pageStore: PageStore, pageId: string): Promise<void> {
  const doc = await pageStore.replayAt(pageId, await pageStore.currentSeq(pageId));
  const content = extractPlainText(doc);
  await pool.query(
    `INSERT INTO search_index (page_id, content, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (page_id) DO UPDATE SET content = EXCLUDED.content, updated_at = now()`,
    [pageId, content]
  );
  log.info({ event: "search_index_updated", pageId }, "search index refreshed");
}

export async function processPreviewJob(pool: Pool, pageStore: PageStore, pageId: string): Promise<void> {
  const doc = await pageStore.replayAt(pageId, await pageStore.currentSeq(pageId));
  const content = extractPlainText(doc);
  const preview = content.length > PREVIEW_LENGTH ? content.slice(0, PREVIEW_LENGTH) + "…" : content;
  await pool.query(
    `INSERT INTO page_previews (page_id, preview, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (page_id) DO UPDATE SET preview = EXCLUDED.preview, updated_at = now()`,
    [pageId, preview]
  );
  log.info({ event: "preview_updated", pageId }, "page preview refreshed");
}

/** Renders a page's current blocks as a simple text PDF (pdfkit — pure JS, no
 *  headless-browser dependency) and stores the result, returning the export's id. */
export async function processPdfExportJob(pool: Pool, pageStore: PageStore, pageId: string): Promise<string> {
  const doc = await pageStore.replayAt(pageId, await pageStore.currentSeq(pageId));
  const blocks = serializeDocument(doc);

  const pdfBuffer = await new Promise<Buffer>((resolve, reject) => {
    const pdf = new PDFDocument({ margin: 50 });
    const chunks: Buffer[] = [];
    pdf.on("data", (chunk: Buffer) => chunks.push(chunk));
    pdf.on("end", () => resolve(Buffer.concat(chunks)));
    pdf.on("error", reject);

    if (blocks.length === 0) {
      pdf.fontSize(12).text("(empty page)");
    }
    for (const block of blocks) {
      if (block.type === "heading") {
        pdf.fontSize(18).text(block.text || " ", { paragraphGap: 8 });
      } else {
        pdf.fontSize(12).text(block.text || " ", { paragraphGap: 6 });
      }
    }
    pdf.end();
  });

  const id = randomUUID();
  await pool.query("INSERT INTO exports (id, page_id, format, data) VALUES ($1, $2, 'pdf', $3)", [
    id,
    pageId,
    pdfBuffer.toString("base64"),
  ]);
  log.info({ event: "pdf_export_complete", pageId, exportId: id }, "PDF export generated");
  return id;
}
