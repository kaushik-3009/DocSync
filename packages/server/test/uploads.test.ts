import type { Pool } from "pg";
import { S3Client } from "@aws-sdk/client-s3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestPool } from "./helpers/test-db.js";
import { buildApp, type App } from "../src/http/app.js";
import { PageStore } from "../src/persistence/page-store.js";
import { RoomRegistry } from "../src/room-registry.js";
import { InlineUploadStorage, matchesImageType, S3UploadStorage } from "../src/uploads/storage.js";
import { createHttpLimiter, createLoginLimiter, createRegisterLimiter } from "../src/rate-limit/limiters.js";
import { loadRuntimeConfig } from "../src/runtime-config.js";

const JWT_SECRET = "uploads-test-secret-0123456789abcdef";
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(56, 1)]);

let pool: Pool;
let app: App;

beforeEach(async () => {
  pool = await createTestPool();
  const pageStore = new PageStore(pool);
  app = await buildApp({
    config: loadRuntimeConfig({
      JWT_SECRET,
      DATABASE_URL: "postgres://unused",
      REDIS_URL: "redis://unused",
      ALLOWED_ORIGINS: "http://localhost",
    }),
    gatewayId: "test",
    pool,
    pageStore,
    registry: new RoomRegistry({ pageStore }),
    jobQueues: null,
    mentionsStore: null,
    exportStorage: null,
    authorship: null,
    semanticIndex: null,
    jwtSecret: JWT_SECRET,
    limiters: { http: createHttpLimiter(null, 1_000), login: createLoginLimiter(null), register: createRegisterLimiter(null) },
    pingRedis: null,
    notifyUser: async () => undefined,
    maxBodyBytes: 65_536,
    webhookPolicy: { allowPrivateNetworks: false, allowInsecure: false },
    uploadStorage: new InlineUploadStorage(pool, "upload-signing-key"),
  });
});

afterEach(async () => {
  await app.close();
});

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function register(email: string): Promise<string> {
  const response = await app.inject({ method: "POST", url: "/auth/register", payload: { email, password: "correct horse battery" } });
  return (response.json() as { token: string }).token;
}

async function setup() {
  const owner = await register("owner@example.com");
  const viewer = await register("viewer@example.com");
  const pageId = (
    (await app.inject({ method: "POST", url: "/documents", headers: auth(owner), payload: {} })).json() as { document: { id: string } }
  ).document.id;
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM users WHERE email = 'viewer@example.com'");
  await pool.query("INSERT INTO page_roles (page_id, user_id, role) VALUES ($1, $2, 'viewer')", [pageId, rows[0]!.id]);
  return { owner, viewer, pageId };
}

async function begin(token: string, pageId: string, contentType = "image/png", size = PNG.length) {
  return app.inject({ method: "POST", url: `/pages/${pageId}/uploads`, headers: auth(token), payload: { contentType, size } });
}

describe("image uploads", () => {
  it("approves, stores and serves an image only through signed, expiring URLs", async () => {
    const { owner, viewer, pageId } = await setup();
    expect((await begin(viewer, pageId)).statusCode).toBe(403);
    const started = await begin(owner, pageId);
    expect(started.statusCode).toBe(201);
    const { uploadId, target } = started.json() as { uploadId: string; target: { url: string; method: string } };
    expect(target.url).toMatch(new RegExp(`/uploads/${uploadId}$`));

    const put = await app.inject({
      method: "PUT",
      url: `/uploads/${uploadId}`,
      headers: { ...auth(owner), "content-type": "image/png" },
      payload: PNG,
    });
    expect(put.statusCode).toBe(204);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: `/uploads/${uploadId}`,
          headers: { ...auth(owner), "content-type": "image/png" },
          payload: PNG,
        })
      ).statusCode
    ).toBe(409);

    // Viewers can read; the URL is page-scoped and signed.
    const issued = await app.inject({ url: `/pages/${pageId}/uploads/${uploadId}/url`, headers: auth(viewer) });
    expect(issued.statusCode).toBe(200);
    const imageUrl = new URL((issued.json() as { url: string }).url);
    const image = await app.inject({ url: imageUrl.pathname + imageUrl.search });
    expect(image.statusCode).toBe(200);
    expect(image.rawPayload.equals(PNG)).toBe(true);
    expect(image.headers["content-type"]).toBe("image/png");
    expect(image.headers["x-content-type-options"]).toBe("nosniff");
    expect(image.headers["content-security-policy"]).toContain("sandbox");

    const tampered = new URL(imageUrl);
    tampered.searchParams.set("signature", "0".repeat(64));
    expect((await app.inject(tampered.pathname + tampered.search)).statusCode).toBe(404);
    const expired = new URL(imageUrl);
    expired.searchParams.set("expires", String(Math.floor(Date.now() / 1000) - 10));
    expect((await app.inject(expired.pathname + expired.search)).statusCode).toBe(404);
  });

  it("rejects SVG, oversized declarations, mismatched bytes and other users", async () => {
    const { owner, viewer, pageId } = await setup();
    expect((await begin(owner, pageId, "image/svg+xml")).statusCode).toBe(400);
    expect((await begin(owner, pageId, "image/png", 6 * 1024 * 1024)).statusCode).toBe(400);

    const { uploadId } = (await begin(owner, pageId)).json() as { uploadId: string };
    const putAs = (token: string, payload: Buffer, type = "image/png") =>
      app.inject({ method: "PUT", url: `/uploads/${uploadId}`, headers: { ...auth(token), "content-type": type }, payload });
    expect((await putAs(viewer, PNG)).statusCode).toBe(404);
    expect((await putAs(owner, Buffer.alloc(PNG.length, 0x3c))).statusCode).toBe(415); // "<<<<" is not a PNG
    expect((await putAs(owner, PNG.subarray(0, 20))).statusCode).toBe(400);
    expect((await putAs(owner, PNG, "image/jpeg")).statusCode).toBe(415);

    // Not readable before it's uploaded, nor through another page.
    expect((await app.inject({ url: `/pages/${pageId}/uploads/${uploadId}/url`, headers: auth(owner) })).statusCode).toBe(404);
    const otherPage = (
      (await app.inject({ method: "POST", url: "/documents", headers: auth(owner), payload: {} })).json() as { document: { id: string } }
    ).document.id;
    expect((await putAs(owner, PNG)).statusCode).toBe(204);
    expect((await app.inject({ url: `/pages/${otherPage}/uploads/${uploadId}/url`, headers: auth(owner) })).statusCode).toBe(404);
  });

  it("checks magic bytes for each allowed format", () => {
    expect(matchesImageType(PNG, "image/png")).toBe(true);
    expect(matchesImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), "image/jpeg")).toBe(true);
    expect(matchesImageType(Buffer.from("GIF89a....."), "image/gif")).toBe(true);
    expect(matchesImageType(Buffer.from("RIFF\0\0\0\0WEBPVP8 "), "image/webp")).toBe(true);
    expect(matchesImageType(Buffer.from("<svg onload=alert(1)>"), "image/png")).toBe(false);
  });

  it("signs content type and length into S3 presigned uploads", async () => {
    const s3 = new S3Client({ region: "us-east-2", credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" } });
    const storage = new S3UploadStorage(pool, s3, "docsync-files");
    const { target } = await storage.begin({ pageId: "p1", userId: null, contentType: "image/png", sizeBytes: 1234 });
    const url = new URL(target.url);
    expect(url.hostname).toContain("docsync-files");
    expect(url.pathname).toMatch(/^\/uploads\/p1\//);
    expect(url.searchParams.get("X-Amz-SignedHeaders")!.split(";")).toEqual(expect.arrayContaining(["content-length", "content-type"]));
    expect(Number(url.searchParams.get("X-Amz-Expires"))).toBe(300);
  });
});
