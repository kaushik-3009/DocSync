import type { Pool } from "pg";
import * as Y from "yjs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBlock } from "@collab/shared";
import { createTestPool } from "./helpers/test-db.js";
import { buildApp, type App } from "../src/http/app.js";
import { PageStore } from "../src/persistence/page-store.js";
import { RoomRegistry } from "../src/room-registry.js";
import { PostgresExportStorage } from "../src/exports/storage.js";
import { createHttpLimiter, createLoginLimiter, createRegisterLimiter } from "../src/rate-limit/limiters.js";
import { loadRuntimeConfig } from "../src/runtime-config.js";

const JWT_SECRET = "http-test-secret-0123456789abcdef";
const ORIGIN = "http://localhost:5173";

let pool: Pool;
let app: App;
let pageStore: PageStore;

async function build(overrides: { httpPoints?: number } = {}) {
  pageStore = new PageStore(pool);
  return buildApp({
    config: loadRuntimeConfig({ JWT_SECRET, DATABASE_URL: "postgres://unused", REDIS_URL: "redis://unused", ALLOWED_ORIGINS: ORIGIN }),
    gatewayId: "test-gateway",
    pool,
    pageStore,
    registry: new RoomRegistry({ pageStore }),
    jobQueues: null,
    mentionsStore: null,
    exportStorage: new PostgresExportStorage(pool),
    jwtSecret: JWT_SECRET,
    limiters: { http: createHttpLimiter(null, overrides.httpPoints ?? 1_000), login: createLoginLimiter(null), register: createRegisterLimiter(null) },
    pingRedis: async () => true,
    notifyUser: async () => undefined,
    maxBodyBytes: 65_536,
  });
}

beforeEach(async () => {
  pool = await createTestPool();
  app = await build();
});

afterEach(async () => {
  await app?.close();
});

async function register(email: string) {
  const response = await app.inject({ method: "POST", url: "/auth/register", payload: { email, password: "correct horse battery" } });
  expect(response.statusCode).toBe(201);
  return response.json() as { token: string; refreshToken: string; expiresIn: number };
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function createDocument(token: string, title = "Plan") {
  const response = await app.inject({ method: "POST", url: "/documents", headers: auth(token), payload: { title } });
  expect(response.statusCode).toBe(201);
  return (response.json() as { document: { id: string } }).document.id;
}

describe("HTTP API", () => {
  it("reports liveness and readiness", async () => {
    expect((await app.inject("/health")).json()).toMatchObject({ status: "ok", authRequired: true });
    const ready = await app.inject("/ready");
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({ status: "ready", gatewayId: "test-gateway", postgres: true, redis: true });
  });

  it("echoes a valid X-Request-ID and generates one otherwise", async () => {
    expect((await app.inject({ url: "/health", headers: { "x-request-id": "abc-123" } })).headers["x-request-id"]).toBe("abc-123");
    expect((await app.inject({ url: "/health", headers: { "x-request-id": "bad id!" } })).headers["x-request-id"]).not.toBe("bad id!");
  });

  it("rejects malformed bodies with 400 before touching the database", async () => {
    const response = await app.inject({ method: "POST", url: "/auth/register", payload: { email: "a@b.c" } });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "invalid request" });
  });

  it("registers, rejects a duplicate email, and logs in", async () => {
    const session = await register("ada@example.com");
    expect(session.expiresIn).toBe(15 * 60);
    expect((await app.inject({ method: "POST", url: "/auth/register", payload: { email: "ada@example.com", password: "x" } })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: "/auth/login", payload: { email: "ada@example.com", password: "wrong" } })).statusCode).toBe(401);
    const login = await app.inject({ method: "POST", url: "/auth/login", payload: { email: "ada@example.com", password: "correct horse battery" } });
    expect(login.statusCode).toBe(200);
    expect(login.json()).toHaveProperty("refreshToken");
  });

  it("rotates refresh tokens and revokes the session when an old one is replayed", async () => {
    const { refreshToken } = await register("grace@example.com");
    const first = await app.inject({ method: "POST", url: "/auth/refresh", payload: { refreshToken } });
    expect(first.statusCode).toBe(200);
    const rotated = (first.json() as { refreshToken: string }).refreshToken;
    expect(rotated).not.toBe(refreshToken);

    // Replaying the already-used token is treated as theft: the whole family dies.
    const replay = await app.inject({ method: "POST", url: "/auth/refresh", payload: { refreshToken } });
    expect(replay.statusCode).toBe(401);
    expect(replay.json()).toMatchObject({ reason: "reused" });
    expect((await app.inject({ method: "POST", url: "/auth/refresh", payload: { refreshToken: rotated } })).statusCode).toBe(401);
  });

  it("revokes a session on logout", async () => {
    const { refreshToken } = await register("linus@example.com");
    expect((await app.inject({ method: "POST", url: "/auth/logout", payload: { refreshToken } })).statusCode).toBe(204);
    const refresh = await app.inject({ method: "POST", url: "/auth/refresh", payload: { refreshToken } });
    expect(refresh.statusCode).toBe(401);
    expect(refresh.json()).toMatchObject({ reason: "revoked" });
  });

  it("requires a bearer token and scopes documents to the caller", async () => {
    expect((await app.inject("/documents")).statusCode).toBe(401);
    const alice = await register("alice@example.com");
    const bob = await register("bob@example.com");
    const pageId = await createDocument(alice.token, "Alice's notes");

    const aliceDocs = (await app.inject({ url: "/documents", headers: auth(alice.token) })).json() as { documents: Array<{ id: string }> };
    const bobDocs = (await app.inject({ url: "/documents", headers: auth(bob.token) })).json() as { documents: Array<{ id: string }> };
    expect(aliceDocs.documents.map((doc) => doc.id)).toEqual([pageId]);
    expect(bobDocs.documents).toEqual([]);
    expect((await app.inject({ url: `/pages/${pageId}/versions`, headers: auth(bob.token) })).statusCode).toBe(403);
  });

  it("lets only owners invite, and only after validating the role", async () => {
    const owner = await register("owner@example.com");
    const other = await register("other@example.com");
    const pageId = await createDocument(owner.token);

    const badRole = await app.inject({ method: "POST", url: `/pages/${pageId}/roles`, headers: auth(owner.token), payload: { email: "x@example.com", role: "owner" } });
    expect(badRole.statusCode).toBe(400);
    const notOwner = await app.inject({ method: "POST", url: `/pages/${pageId}/roles`, headers: auth(other.token), payload: { email: "x@example.com", role: "viewer" } });
    expect(notOwner.statusCode).toBe(403);
    const invited = await app.inject({ method: "POST", url: `/pages/${pageId}/roles`, headers: auth(owner.token), payload: { email: "other@example.com", role: "editor" } });
    expect(invited.statusCode).toBe(202);

    const { invitationId } = invited.json() as { invitationId: string };
    expect((await app.inject({ method: "POST", url: `/invitations/${invitationId}/accept`, headers: auth(other.token) })).statusCode).toBe(200);
    expect((await app.inject({ url: `/pages/${pageId}/versions`, headers: auth(other.token) })).statusCode).toBe(200);
    // Answering twice is a conflict, not a server error.
    expect((await app.inject({ method: "POST", url: `/invitations/${invitationId}/accept`, headers: auth(other.token) })).statusCode).toBe(409);
  });

  it("restores a version through the admission queue and keeps later history", async () => {
    const owner = await register("historian@example.com");
    const pageId = await createDocument(owner.token);
    const doc = new Y.Doc();
    createBlock(doc, "b1", { type: "paragraph", text: "first" });
    const seq1 = await pageStore.recordUpdate(pageId, Y.encodeStateAsUpdate(doc), () => Y.encodeStateAsUpdate(doc));
    const before = Y.encodeStateVector(doc);
    createBlock(doc, "b2", { type: "paragraph", text: "second" });
    await pageStore.recordUpdate(pageId, Y.encodeStateAsUpdate(doc, before), () => Y.encodeStateAsUpdate(doc));

    const restored = await app.inject({ method: "POST", url: `/pages/${pageId}/versions/${seq1}/restore`, headers: auth(owner.token) });
    expect(restored.statusCode).toBe(200);
    expect((restored.json() as { blocks: Array<{ id: string }> }).blocks.map((block) => block.id)).toEqual(["b1"]);
    expect(await pageStore.currentSeq(pageId)).toBe(3);
    expect((await app.inject({ method: "POST", url: `/pages/${pageId}/versions/99/restore`, headers: auth(owner.token) })).statusCode).toBe(404);
  });

  it("authenticates export downloads before revealing whether an export exists", async () => {
    const owner = await register("exporter@example.com");
    const stranger = await register("stranger@example.com");
    const pageId = await createDocument(owner.token);
    await new PostgresExportStorage(pool).save("export-1", pageId, Buffer.from("%PDF-1.4 test"));

    expect((await app.inject("/exports/export-1")).statusCode).toBe(401);
    expect((await app.inject("/exports/missing")).statusCode).toBe(401);
    expect((await app.inject({ url: "/exports/export-1", headers: auth(stranger.token) })).statusCode).toBe(404);
    const download = await app.inject({ url: "/exports/export-1", headers: auth(owner.token) });
    expect(download.statusCode).toBe(200);
    expect(download.headers["content-type"]).toBe("application/pdf");
    expect(download.body.startsWith("%PDF")).toBe(true);
  });

  it("allows DELETE in CORS preflight for allowed origins only", async () => {
    const preflight = await app.inject({
      method: "OPTIONS",
      url: "/pages/p1/roles",
      headers: { origin: ORIGIN, "access-control-request-method": "DELETE" },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe(ORIGIN);
    expect(String(preflight.headers["access-control-allow-methods"])).toContain("DELETE");
    const foreign = await app.inject({ method: "OPTIONS", url: "/documents", headers: { origin: "https://evil.example", "access-control-request-method": "GET" } });
    expect(foreign.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("rate limits HTTP requests but never health probes", async () => {
    await app.close();
    app = await build({ httpPoints: 2 });
    const statuses = [];
    for (let i = 0; i < 3; i += 1) statuses.push((await app.inject("/documents")).statusCode);
    expect(statuses).toEqual([401, 401, 429]);
    expect((await app.inject("/health")).statusCode).toBe(200);
  });

  it("publishes an OpenAPI document covering the routes", async () => {
    const spec = (await app.inject("/openapi.json")).json() as { openapi: string; paths: Record<string, unknown> };
    expect(spec.openapi).toMatch(/^3\./);
    expect(Object.keys(spec.paths)).toEqual(expect.arrayContaining(["/auth/login", "/documents", "/pages/{pageId}/versions/{seq}/restore"]));
  });
});
