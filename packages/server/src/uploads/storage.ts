import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { Pool } from "pg";
import { GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

/** Raster formats only: SVG can carry script and is never accepted. */
export const ALLOWED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export type ImageType = (typeof ALLOWED_IMAGE_TYPES)[number];
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const URL_TTL_SECONDS = 300;

/** Where the client should send the file bytes. */
export interface UploadTarget {
  method: "PUT";
  url: string;
  headers: Record<string, string>;
}

export interface UploadRecord {
  id: string;
  pageId: string;
  contentType: ImageType;
  sizeBytes: number;
  createdBy: string | null;
  hasData: boolean;
  storageKey: string | null;
}

/** Checks a file's leading bytes really are the declared image format. */
export function matchesImageType(bytes: Buffer, contentType: ImageType): boolean {
  const starts = (...signature: number[]) => signature.every((byte, index) => bytes[index] === byte);
  switch (contentType) {
    case "image/png":
      return starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    case "image/jpeg":
      return starts(0xff, 0xd8, 0xff);
    case "image/gif":
      return bytes.subarray(0, 6).toString("ascii") === "GIF87a" || bytes.subarray(0, 6).toString("ascii") === "GIF89a";
    case "image/webp":
      return bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
  }
}

export interface UploadStorage {
  /** Registers an upload and returns where to send the bytes. */
  begin(input: {
    pageId: string;
    userId: string | null;
    contentType: ImageType;
    sizeBytes: number;
    apiBaseUrl: string;
  }): Promise<{ uploadId: string; target: UploadTarget }>;
  /** A short-lived URL an <img> can load (no Authorization header needed). */
  readUrl(upload: UploadRecord, apiBaseUrl: string): Promise<string>;
}

export async function findUpload(pool: Pool, uploadId: string): Promise<UploadRecord | null> {
  const { rows } = await pool.query<{
    id: string;
    page_id: string;
    content_type: ImageType;
    size_bytes: number;
    created_by: string | null;
    has_data: boolean;
    storage_key: string | null;
  }>("SELECT id, page_id, content_type, size_bytes, created_by, (data IS NOT NULL) AS has_data, storage_key FROM uploads WHERE id = $1", [
    uploadId,
  ]);
  const row = rows[0];
  return row
    ? {
        id: row.id,
        pageId: row.page_id,
        contentType: row.content_type,
        sizeBytes: Number(row.size_bytes),
        createdBy: row.created_by,
        hasData: Boolean(row.has_data),
        storageKey: row.storage_key,
      }
    : null;
}

/**
 * Local development: the gateway accepts the bytes itself (PUT /uploads/:id,
 * magic-byte checked) and serves them from HMAC-signed, expiring URLs.
 */
export class InlineUploadStorage implements UploadStorage {
  constructor(
    private readonly pool: Pool,
    private readonly signingKey: string
  ) {}

  async begin(input: { pageId: string; userId: string | null; contentType: ImageType; sizeBytes: number; apiBaseUrl: string }) {
    const uploadId = randomUUID();
    await this.pool.query("INSERT INTO uploads (id, page_id, content_type, size_bytes, created_by) VALUES ($1, $2, $3, $4, $5)", [
      uploadId,
      input.pageId,
      input.contentType,
      input.sizeBytes,
      input.userId,
    ]);
    return {
      uploadId,
      target: { method: "PUT" as const, url: `${input.apiBaseUrl}/uploads/${uploadId}`, headers: { "content-type": input.contentType } },
    };
  }

  async store(uploadId: string, bytes: Buffer): Promise<void> {
    await this.pool.query("UPDATE uploads SET data = $1 WHERE id = $2", [bytes.toString("base64"), uploadId]);
  }

  async read(uploadId: string): Promise<Buffer | null> {
    const { rows } = await this.pool.query<{ data: string | null }>("SELECT data FROM uploads WHERE id = $1", [uploadId]);
    return rows[0]?.data ? Buffer.from(rows[0].data, "base64") : null;
  }

  async readUrl(upload: UploadRecord, apiBaseUrl: string): Promise<string> {
    const expires = Math.floor(Date.now() / 1000) + URL_TTL_SECONDS;
    return `${apiBaseUrl}/uploads/${upload.id}/content?expires=${expires}&signature=${this.sign(upload.id, expires)}`;
  }

  verify(uploadId: string, expires: number, signature: string): boolean {
    if (!Number.isInteger(expires) || expires < Math.floor(Date.now() / 1000)) return false;
    const expected = Buffer.from(this.sign(uploadId, expires), "hex");
    const actual = Buffer.from(signature, "hex");
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  private sign(uploadId: string, expires: number): string {
    return createHmac("sha256", this.signingKey).update(`upload:${uploadId}:${expires}`).digest("hex");
  }
}

/**
 * Deployed environments: the browser PUTs straight to S3 with a presigned URL
 * whose Content-Type and Content-Length are part of the signature, so the
 * client cannot upload a different type or size than was approved. Reads are
 * presigned GETs; the bucket itself stays private.
 */
export class S3UploadStorage implements UploadStorage {
  constructor(
    private readonly pool: Pool,
    private readonly s3: Pick<S3Client, "send" | "config">,
    private readonly bucket: string
  ) {}

  async begin(input: { pageId: string; userId: string | null; contentType: ImageType; sizeBytes: number }) {
    const uploadId = randomUUID();
    const key = `uploads/${input.pageId}/${uploadId}`;
    const url = await getSignedUrl(
      this.s3 as S3Client,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: input.contentType,
        ContentLength: input.sizeBytes,
        ServerSideEncryption: "AES256",
      }),
      { expiresIn: URL_TTL_SECONDS, signableHeaders: new Set(["content-type", "content-length"]) }
    );
    await this.pool.query(
      "INSERT INTO uploads (id, page_id, content_type, size_bytes, storage_key, created_by) VALUES ($1, $2, $3, $4, $5, $6)",
      [uploadId, input.pageId, input.contentType, input.sizeBytes, key, input.userId]
    );
    return { uploadId, target: { method: "PUT" as const, url, headers: { "content-type": input.contentType } } };
  }

  async readUrl(upload: UploadRecord): Promise<string> {
    return getSignedUrl(
      this.s3 as S3Client,
      new GetObjectCommand({ Bucket: this.bucket, Key: upload.storageKey!, ResponseContentType: upload.contentType }),
      { expiresIn: URL_TTL_SECONDS }
    );
  }
}

export async function createUploadStorage(
  pool: Pool,
  signingKey: string,
  environment: Record<string, string | undefined> = process.env
): Promise<UploadStorage> {
  const bucket = environment.UPLOADS_S3_BUCKET?.trim();
  if (!bucket) return new InlineUploadStorage(pool, signingKey);
  const { S3Client } = await import("@aws-sdk/client-s3");
  return new S3UploadStorage(pool, new S3Client({}), bucket);
}
