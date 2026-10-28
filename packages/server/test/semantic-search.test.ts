import * as Y from "yjs";
import { newDb } from "pg-mem";
import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBlock, getTitleText } from "@collab/shared";
import { createTestPool } from "./helpers/test-db.js";
import { chunkDocument } from "../src/search/chunking.js";
import { HashingEmbedder, type Embedder } from "../src/ai/embeddings.js";
import { parseChatStream, selectSources } from "../src/ai/workspace-qa.js";
import { SemanticIndex } from "../src/search/semantic.js";
import { runMigrations } from "../src/persistence/db.js";
import { createUser } from "../src/auth/users.js";
import { createDocument } from "../src/documents/store.js";
import { buildApp } from "../src/http/app.js";
import { PageStore } from "../src/persistence/page-store.js";
import { RoomRegistry } from "../src/room-registry.js";
import { signToken } from "../src/auth/jwt.js";
import { createHttpLimiter, createLoginLimiter, createRegisterLimiter } from "../src/rate-limit/limiters.js";
import { loadRuntimeConfig } from "../src/runtime-config.js";

const realPostgres = Boolean(process.env.TEST_DATABASE_URL);

function page(title: string, paragraphs: string[]): Y.Doc {
  const doc = new Y.Doc();
  getTitleText(doc).insert(0, title);
  paragraphs.forEach((text, index) => createBlock(doc, `b${index}`, { type: "paragraph", text }));
  return doc;
}

const cosine = (a: number[], b: number[]) => a.reduce((sum, value, index) => sum + value * b[index]!, 0);

afterEach(() => vi.unstubAllGlobals());

describe("chunking", () => {
  it("packs blocks into title-prefixed chunks and splits oversized blocks", () => {
    // 1,700 chars split 800 + 800 + 100; the short block can't share a chunk.
    const chunks = chunkDocument(page("Runbook", ["short one", "x".repeat(1_700)]));
    expect(chunks.map((chunk) => chunk.content.length - "Runbook\n".length)).toEqual([9, 800, 800, 100]);
    expect(chunks.every((chunk) => chunk.content.startsWith("Runbook\n"))).toBe(true);
    expect(chunks[0]!.content).toContain("short one");
    expect(new Set(chunks.map((chunk) => chunk.contentHash)).size).toBe(3); // the two full x-chunks are identical
  });

  it("produces stable hashes for unchanged content", () => {
    expect(chunkDocument(page("A", ["same"]))[0]!.contentHash).toBe(chunkDocument(page("A", ["same"]))[0]!.contentHash);
  });
});

describe("hashing embedder", () => {
  it("returns unit vectors that rank lexically related text higher", async () => {
    const [query, related, unrelated] = await new HashingEmbedder().embed([
      "database failover runbook",
      "How we handle a database failover: promote the replica",
      "Quarterly marketing offsite agenda and lunch options",
    ]);
    expect(cosine(query!, query!)).toBeCloseTo(1, 5);
    expect(cosine(query!, related!)).toBeGreaterThan(cosine(query!, unrelated!));
  });
});

describe("source selection", () => {
  it("drops sources far weaker than the best match", () => {
    const hit = (pageId: string, score: number) => ({ pageId, title: pageId, content: "", score });
    expect(selectSources([hit("a", 0.8), hit("b", 0.5), hit("c", 0.1)]).map((source) => source.pageId)).toEqual(["a", "b"]);
    expect(selectSources([])).toEqual([]);
  });
});

describe("chat stream parsing", () => {
  it("yields content deltas until [DONE], across chunk boundaries", async () => {
    const frames = [
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n',
      '\ndata: {"choices":[{"delta":{"content":"lo"}}]}\n\ndata: [DO',
      "NE]\n\n",
    ];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) controller.enqueue(new TextEncoder().encode(frame));
        controller.close();
      },
    });
    const parts: string[] = [];
    for await (const part of parseChatStream(stream)) parts.push(part);
    expect(parts).toEqual(["Hel", "lo"]);
  });
});

describe("optional semantic search migration", () => {
  it.skipIf(realPostgres)("reports semantic search unavailable when pgvector is missing", async () => {
    const { Pool } = newDb().adapters.createPg();
    expect((await runMigrations(new Pool() as unknown as Pool)).semanticSearch).toBe(false);
  });
});

describe.skipIf(!realPostgres)("semantic index (pgvector)", () => {
  class CountingEmbedder implements Embedder {
    readonly name = "hashing-v1";
    calls = 0;
    private readonly inner = new HashingEmbedder();
    async embed(texts: string[]) {
      this.calls += texts.length;
      return this.inner.embed(texts);
    }
  }

  async function setup() {
    const pool = await createTestPool();
    const embedder = new CountingEmbedder();
    const index = new SemanticIndex(pool, embedder);
    const owner = await createUser(pool, "owner@example.com", "pw");
    const outsider = await createUser(pool, "outsider@example.com", "pw");
    const ops = await createDocument(pool, owner.id, "Database runbook");
    const party = await createDocument(pool, owner.id, "Offsite");
    await index.indexPage(ops.id, page("Database runbook", ["When the primary fails, promote the replica and repoint the gateway."]));
    await index.indexPage(party.id, page("Offsite", ["Lunch options and the agenda for the team offsite."]));
    return { pool, embedder, index, owner, outsider, ops, party };
  }

  it("ranks the relevant page first and only searches pages the caller can read", async () => {
    const { index, owner, outsider, ops } = await setup();
    const hits = await index.search("what do we do when the database primary fails", owner.id);
    expect(hits[0]!.pageId).toBe(ops.id);
    expect(hits[0]!.title).toBe("Database runbook");
    expect(await index.search("database primary fails", outsider.id)).toEqual([]);
  });

  it("re-embeds only chunks whose content changed", async () => {
    const { index, embedder, ops } = await setup();
    embedder.calls = 0;
    expect(
      await index.indexPage(ops.id, page("Database runbook", ["When the primary fails, promote the replica and repoint the gateway."]))
    ).toEqual({
      embedded: 0,
      reused: 1,
    });
    expect(embedder.calls).toBe(0);
    expect((await index.indexPage(ops.id, page("Database runbook", ["Rewritten procedure."]))).embedded).toBe(1);
  });

  it("streams a cited answer over server-sent events", async () => {
    const { pool, index, owner, ops } = await setup();
    const pageStore = new PageStore(pool);
    const app = await buildApp({
      config: loadRuntimeConfig({
        JWT_SECRET: "semantic-test-secret-0123456789abcdef",
        DATABASE_URL: "postgres://unused",
        REDIS_URL: "redis://unused",
        ALLOWED_ORIGINS: "http://localhost",
        GEMINI_API_KEY: "test-key",
      }),
      gatewayId: "test",
      pool,
      pageStore,
      registry: new RoomRegistry({ pageStore }),
      jobQueues: null,
      mentionsStore: null,
      exportStorage: null,
      authorship: null,
      semanticIndex: index,
      jwtSecret: "semantic-test-secret-0123456789abcdef",
      limiters: { http: createHttpLimiter(null, 1_000), login: createLoginLimiter(null), register: createRegisterLimiter(null) },
      pingRedis: null,
      notifyUser: async () => undefined,
      maxBodyBytes: 65_536,
    });
    const providerBodies: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        providerBodies.push(String(init.body));
        const sse = [
          'data: {"choices":[{"delta":{"content":"Promote the replica "}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"[1]."}}]}\n\n',
          "data: [DONE]\n\n",
        ];
        return new Response(new Blob(sse).stream(), { status: 200, headers: { "content-type": "text/event-stream" } });
      })
    );

    const response = await app.inject({
      method: "POST",
      url: "/workspace/ask/stream",
      headers: { authorization: `Bearer ${signToken({ sub: owner.id, email: owner.email }, "semantic-test-secret-0123456789abcdef")}` },
      payload: { question: "What do we do when the database primary fails?" },
    });
    await app.close();

    expect(response.headers["content-type"]).toContain("text/event-stream");
    const events = response.body
      .trim()
      .split("\n\n")
      .map((frame) => {
        const [eventLine, dataLine] = frame.split("\n");
        return { event: eventLine!.slice("event: ".length), data: JSON.parse(dataLine!.slice("data: ".length)) };
      });
    expect(events[0]).toMatchObject({ event: "citations", data: [{ n: 1, pageId: ops.id, title: "Database runbook" }] });
    expect(
      events
        .filter((event) => event.event === "delta")
        .map((event) => event.data.text)
        .join("")
    ).toBe("Promote the replica [1].");
    expect(events.at(-1)!.event).toBe("done");
    // The retrieved source text, not the whole workspace, is what the model sees.
    expect(providerBodies[0]).toContain("[1] Database runbook");
    expect(providerBodies[0]).not.toContain("Offsite");
  });
});
