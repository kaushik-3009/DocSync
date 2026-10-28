import * as Y from "yjs";
import * as encoding from "lib0/encoding";
import * as syncProtocol from "y-protocols/sync";
import type { WebSocket } from "ws";
import { describe, expect, it, vi } from "vitest";
import { createBlock, getBlockText, MessageType } from "@collab/shared";
import { createTestPool } from "./helpers/test-db.js";
import { textSpans, clientIdsInUpdate } from "../src/authorship/attribution.js";
import { AuthorshipStore } from "../src/authorship/store.js";
import { PageStore } from "../src/persistence/page-store.js";
import { RoomRegistry } from "../src/room-registry.js";
import { buildApp } from "../src/http/app.js";
import { createUser } from "../src/auth/users.js";
import { createDocument } from "../src/documents/store.js";
import { signToken } from "../src/auth/jwt.js";
import { createHttpLimiter, createLoginLimiter, createRegisterLimiter } from "../src/rate-limit/limiters.js";
import { loadRuntimeConfig } from "../src/runtime-config.js";

const JWT_SECRET = "authorship-test-secret-0123456789abcdef";

function fakeSocket() {
  return { OPEN: 1, readyState: 1, send: vi.fn(), close: vi.fn() } as unknown as WebSocket;
}

function updateMessage(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MessageType.Sync);
  syncProtocol.writeUpdate(encoder, update);
  return encoding.toUint8Array(encoder);
}

describe("text attribution", () => {
  it("splits visible text into runs by inserting client and skips deletions", () => {
    const a = new Y.Doc();
    a.clientID = 1;
    const b = new Y.Doc();
    b.clientID = 2;
    a.getText("t").insert(0, "hello world");
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    b.getText("t").insert(6, "big ");
    b.getText("t").delete(0, 1);
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));

    expect(textSpans(a.getText("t"))).toEqual([
      { text: "ello ", clientId: 1 },
      { text: "big ", clientId: 2 },
      { text: "world", clientId: 1 },
    ]);
    expect(clientIdsInUpdate(Y.encodeStateAsUpdate(a)).sort()).toEqual([1, 2]);
  });
});

describe("authorship endpoint", () => {
  it("attributes each user's committed text to them", async () => {
    const pool = await createTestPool();
    const pageStore = new PageStore(pool);
    const authorship = new AuthorshipStore(pool);
    const registry = new RoomRegistry({ pageStore, authorship });
    const ada = await createUser(pool, "ada@example.com", "pw");
    const grace = await createUser(pool, "grace@example.com", "pw");
    const { id: pageId } = await createDocument(pool, ada.id, "Notes");
    await pool.query("INSERT INTO page_roles (page_id, user_id, role) VALUES ($1, $2, 'editor')", [pageId, grace.id]);

    const room = await registry.getOrCreateRoom(pageId);
    const adaSocket = fakeSocket();
    const graceSocket = fakeSocket();
    room.addConnection(adaSocket, "owner", ada.id);
    room.addConnection(graceSocket, "editor", grace.id);

    // Ada creates a block; Grace (a separate Yjs client) appends to it.
    const adaDoc = new Y.Doc();
    createBlock(adaDoc, "b1", { type: "paragraph", text: "Ada wrote this." });
    room.handleMessage(adaSocket, updateMessage(Y.encodeStateAsUpdate(adaDoc)));
    await room.flushDurableUpdates();
    const graceDoc = new Y.Doc();
    Y.applyUpdate(graceDoc, Y.encodeStateAsUpdate(room.doc));
    const before = Y.encodeStateVector(graceDoc);
    getBlockText(graceDoc, "b1")!.insert(15, " Grace added this.");
    room.handleMessage(graceSocket, updateMessage(Y.encodeStateAsUpdate(graceDoc, before)));
    await room.flushDurableUpdates();
    await vi.waitFor(async () => expect((await authorship.authorsFor(pageId)).size).toBe(2));

    const app = await buildApp({
      config: loadRuntimeConfig({
        JWT_SECRET,
        DATABASE_URL: "postgres://unused",
        REDIS_URL: "redis://unused",
        ALLOWED_ORIGINS: "http://localhost",
      }),
      gatewayId: "test",
      pool,
      pageStore,
      registry,
      jobQueues: null,
      mentionsStore: null,
      exportStorage: null,
      authorship,
      semanticIndex: null,
      jwtSecret: JWT_SECRET,
      limiters: { http: createHttpLimiter(null, 1_000), login: createLoginLimiter(null), register: createRegisterLimiter(null) },
      pingRedis: null,
      notifyUser: async () => undefined,
      maxBodyBytes: 65_536,
      webhookPolicy: { allowPrivateNetworks: false, allowInsecure: false },
      uploadStorage: null,
    });
    const response = await app.inject({
      url: `/pages/${pageId}/authorship`,
      headers: { authorization: `Bearer ${signToken({ sub: grace.id, email: grace.email }, JWT_SECRET)}` },
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      blocks: Array<{ blockId: string; spans: Array<{ text: string; userId: string | null }> }>;
      authors: Array<{ email: string; characters: number }>;
    };
    expect(body.blocks[0]!.spans).toEqual([
      { text: "Ada wrote this.", userId: ada.id },
      { text: " Grace added this.", userId: grace.id },
    ]);
    expect(body.authors.map((author) => [author.email, author.characters])).toEqual([
      ["grace@example.com", 18],
      ["ada@example.com", 15],
    ]);
  });

  it("keeps the first author when a client id is reused by someone else", async () => {
    const pool = await createTestPool();
    const store = new AuthorshipStore(pool);
    const a = await createUser(pool, "a@example.com", "pw");
    const b = await createUser(pool, "b@example.com", "pw");
    await store.record("p", [{ clientId: 42, userId: a.id }]);
    await store.record("p", [{ clientId: 42, userId: b.id }]);
    expect((await store.authorsFor("p")).get(42)?.userId).toBe(a.id);
  });
});
