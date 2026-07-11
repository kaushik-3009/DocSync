import * as Y from "yjs";
import { beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createTestPool } from "./helpers/test-db.js";
import { PageStore } from "../src/persistence/page-store.js";
import { processSearchIndexJob, processPreviewJob, processPdfExportJob } from "../src/jobs/processors.js";
import { searchPages } from "../src/jobs/search.js";
import { createUser } from "../src/auth/users.js";
import { grantRole, resolveRoleForConnection } from "../src/auth/rbac.js";
import { createBlock } from "@collab/shared";

let pool: Pool;
let pageStore: PageStore;

beforeEach(async () => {
  pool = await createTestPool();
  pageStore = new PageStore(pool);
});

async function seedPage(pageId: string, text: string): Promise<void> {
  const doc = new Y.Doc();
  createBlock(doc, "b1", { type: "paragraph", text });
  await pageStore.recordUpdate(pageId, Y.encodeStateAsUpdate(doc), () => Y.encodeStateAsUpdate(doc));
}

describe("processSearchIndexJob", () => {
  it("indexes a page's current plain text, upserting on repeated runs", async () => {
    await seedPage("page-a", "the quick brown fox");
    await processSearchIndexJob(pool, pageStore, "page-a");

    let hits = await searchPages(pool, "quick brown", null);
    expect(hits.map((h) => h.pageId)).toEqual(["page-a"]);

    // a later edit + re-index should replace, not duplicate, the row
    const doc = await pageStore.loadPage("page-a").then((r) => r.doc);
    createBlock(doc, "b2", { type: "paragraph", text: "jumps over the lazy dog" });
    await pageStore.recordUpdate("page-a", Y.encodeStateAsUpdate(doc), () => Y.encodeStateAsUpdate(doc));
    await processSearchIndexJob(pool, pageStore, "page-a");

    hits = await searchPages(pool, "lazy dog", null);
    expect(hits.map((h) => h.pageId)).toEqual(["page-a"]);

    const count = await pool.query("SELECT count(*)::int AS n FROM search_index WHERE page_id = 'page-a'");
    expect(count.rows[0].n).toBe(1);
  });

  it("does not match pages with unrelated content", async () => {
    await seedPage("page-a", "apples and oranges");
    await processSearchIndexJob(pool, pageStore, "page-a");
    expect(await searchPages(pool, "bananas", null)).toEqual([]);
  });
});

describe("searchPages RBAC scoping", () => {
  it("restricts results to pages the searching user has a role on, when a userId is given", async () => {
    const alice = await createUser(pool, "alice@example.com", "pw");
    const bob = await createUser(pool, "bob@example.com", "pw");

    await seedPage("alice-page", "shared search term");
    await processSearchIndexJob(pool, pageStore, "alice-page");
    await resolveRoleForConnection(pool, "alice-page", alice.id); // alice owns it

    await seedPage("bob-page", "shared search term");
    await processSearchIndexJob(pool, pageStore, "bob-page");
    await resolveRoleForConnection(pool, "bob-page", bob.id); // bob owns it

    const aliceResults = await searchPages(pool, "shared search", alice.id);
    expect(aliceResults.map((h) => h.pageId)).toEqual(["alice-page"]);

    // no userId (auth disabled) sees everything
    const openResults = await searchPages(pool, "shared search", null);
    expect(openResults.map((h) => h.pageId).sort()).toEqual(["alice-page", "bob-page"]);

    await grantRole(pool, "bob-page", bob.id, alice.id, "viewer");
    const aliceResultsAfterGrant = await searchPages(pool, "shared search", alice.id);
    expect(aliceResultsAfterGrant.map((h) => h.pageId).sort()).toEqual(["alice-page", "bob-page"]);
  });
});

describe("processPreviewJob", () => {
  it("stores a truncated plain-text preview and upserts on re-run", async () => {
    await seedPage("page-a", "a".repeat(300));
    await processPreviewJob(pool, pageStore, "page-a");

    const result = await pool.query<{ preview: string }>("SELECT preview FROM page_previews WHERE page_id = $1", [
      "page-a",
    ]);
    expect(result.rows[0].preview.length).toBe(201); // 200 chars + ellipsis
    expect(result.rows[0].preview.endsWith("…")).toBe(true);

    await processPreviewJob(pool, pageStore, "page-a");
    const count = await pool.query("SELECT count(*)::int AS n FROM page_previews WHERE page_id = 'page-a'");
    expect(count.rows[0].n).toBe(1);
  });

  it("does not truncate short content", async () => {
    await seedPage("page-a", "short text");
    await processPreviewJob(pool, pageStore, "page-a");
    const result = await pool.query<{ preview: string }>("SELECT preview FROM page_previews WHERE page_id = $1", [
      "page-a",
    ]);
    expect(result.rows[0].preview).toBe("short text");
  });
});

describe("processPdfExportJob", () => {
  it("renders a page's blocks into a stored PDF artifact and returns its id", async () => {
    await seedPage("page-a", "exportable content");
    const exportId = await processPdfExportJob(pool, pageStore, "page-a");

    const result = await pool.query<{ page_id: string; format: string; data: string }>(
      "SELECT page_id, format, data FROM exports WHERE id = $1",
      [exportId]
    );
    const row = result.rows[0];
    expect(row.page_id).toBe("page-a");
    expect(row.format).toBe("pdf");
    const bytes = Buffer.from(row.data, "base64");
    expect(bytes.subarray(0, 5).toString("ascii")).toBe("%PDF-"); // valid PDF header
  });

  it("handles an empty page without throwing", async () => {
    const exportId = await processPdfExportJob(pool, pageStore, "never-touched-page");
    const result = await pool.query("SELECT id FROM exports WHERE id = $1", [exportId]);
    expect(result.rows).toHaveLength(1);
  });
});
