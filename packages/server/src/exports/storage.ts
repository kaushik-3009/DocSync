import type { Pool } from "pg";
import { GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

/** Where a stored export can be fetched from. */
export type ExportLocation = { pageId: string; body: Buffer } | { pageId: string; redirectUrl: string };

/**
 * Persists generated export files (PDFs). The `exports` table is always the
 * index — it is what authorization checks join against — while the bytes
 * live either inline (local development) or in S3 (deployed environments,
 * where the database should not carry binary blobs).
 */
export interface ExportStorage {
  save(exportId: string, pageId: string, file: Buffer): Promise<void>;
  /** Null when no export has this id. */
  locate(exportId: string): Promise<ExportLocation | null>;
}

export class PostgresExportStorage implements ExportStorage {
  constructor(private readonly pool: Pool) {}

  async save(exportId: string, pageId: string, file: Buffer): Promise<void> {
    await this.pool.query("INSERT INTO exports (id, page_id, format, data) VALUES ($1, $2, 'pdf', $3)", [exportId, pageId, file.toString("base64")]);
  }

  async locate(exportId: string): Promise<ExportLocation | null> {
    const { rows } = await this.pool.query<{ page_id: string; data: string | null }>("SELECT page_id, data FROM exports WHERE id = $1", [exportId]);
    const row = rows[0];
    if (!row?.data) return null;
    return { pageId: row.page_id, body: Buffer.from(row.data, "base64") };
  }
}

/** Objects are private; downloads are short-lived presigned GET redirects so
 *  file bytes never pass through the gateway. */
export class S3ExportStorage implements ExportStorage {
  constructor(
    private readonly pool: Pool,
    private readonly s3: Pick<S3Client, "send" | "config">,
    private readonly bucket: string,
    private readonly urlTtlSeconds = 300
  ) {}

  async save(exportId: string, pageId: string, file: Buffer): Promise<void> {
    const key = `exports/${pageId}/${exportId}.pdf`;
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: file,
        ContentType: "application/pdf",
        ContentDisposition: `attachment; filename="${pageId}.pdf"`,
        ServerSideEncryption: "AES256",
      })
    );
    await this.pool.query("INSERT INTO exports (id, page_id, format, storage_key) VALUES ($1, $2, 'pdf', $3)", [exportId, pageId, key]);
  }

  async locate(exportId: string): Promise<ExportLocation | null> {
    const { rows } = await this.pool.query<{ page_id: string; storage_key: string | null }>("SELECT page_id, storage_key FROM exports WHERE id = $1", [
      exportId,
    ]);
    const row = rows[0];
    if (!row?.storage_key) return null;
    const redirectUrl = await getSignedUrl(this.s3 as S3Client, new GetObjectCommand({ Bucket: this.bucket, Key: row.storage_key }), {
      expiresIn: this.urlTtlSeconds,
    });
    return { pageId: row.page_id, redirectUrl };
  }
}

/** S3 when EXPORTS_S3_BUCKET is set (credentials come from the standard AWS
 *  provider chain — the ECS task role in AWS), inline Postgres otherwise. */
export async function createExportStorage(pool: Pool, environment: Record<string, string | undefined> = process.env): Promise<ExportStorage> {
  const bucket = environment.EXPORTS_S3_BUCKET?.trim();
  if (!bucket) return new PostgresExportStorage(pool);
  const { S3Client } = await import("@aws-sdk/client-s3");
  return new S3ExportStorage(pool, new S3Client({}), bucket);
}
