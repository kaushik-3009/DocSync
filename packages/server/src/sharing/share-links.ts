import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Pool } from "pg";

export interface ShareLink {
  id: string;
  createdAt: string;
  expiresAt: string | null;
}

const hash = (secret: string) => createHash("sha256").update(secret).digest("hex");

/** Creates a link and returns its token (shown once; only the hash is kept). */
export async function createShareLink(
  pool: Pool,
  pageId: string,
  createdBy: string,
  expiresInDays?: number
): Promise<{ link: ShareLink; token: string }> {
  const id = randomUUID().replace(/-/g, "").slice(0, 16);
  const secret = randomBytes(24).toString("base64url");
  const expiresAt = expiresInDays ? new Date(Date.now() + expiresInDays * 86_400_000) : null;
  const { rows } = await pool.query<{ created_at: Date }>(
    "INSERT INTO share_links (id, page_id, token_hash, created_by, expires_at) VALUES ($1, $2, $3, $4, $5) RETURNING created_at",
    [id, pageId, hash(secret), createdBy, expiresAt]
  );
  return {
    link: { id, createdAt: new Date(rows[0]!.created_at).toISOString(), expiresAt: expiresAt?.toISOString() ?? null },
    token: `${id}.${secret}`,
  };
}

export async function listShareLinks(pool: Pool, pageId: string): Promise<ShareLink[]> {
  const { rows } = await pool.query<{ id: string; created_at: Date; expires_at: Date | null }>(
    `SELECT id, created_at, expires_at FROM share_links
     WHERE page_id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > $2)
     ORDER BY created_at DESC`,
    [pageId, new Date()]
  );
  return rows.map((row) => ({
    id: row.id,
    createdAt: new Date(row.created_at).toISOString(),
    expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
  }));
}

export async function revokeShareLink(pool: Pool, pageId: string, linkId: string): Promise<boolean> {
  const result = await pool.query("UPDATE share_links SET revoked_at = $1 WHERE id = $2 AND page_id = $3 AND revoked_at IS NULL", [
    new Date(),
    linkId,
    pageId,
  ]);
  return (result.rowCount ?? 0) > 0;
}

/** The page a token grants read access to, or null for any invalid,
 *  revoked or expired token (indistinguishable to the caller). */
export async function resolveShareToken(pool: Pool, token: string): Promise<string | null> {
  const [id, secret] = token.split(".");
  if (!id || !secret) return null;
  const { rows } = await pool.query<{ page_id: string; token_hash: string; expires_at: Date | null; revoked_at: Date | null }>(
    "SELECT page_id, token_hash, expires_at, revoked_at FROM share_links WHERE id = $1",
    [id]
  );
  const row = rows[0];
  if (!row || row.revoked_at) return null;
  if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) return null;
  const expected = Buffer.from(row.token_hash, "hex");
  const actual = Buffer.from(hash(secret), "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual) ? row.page_id : null;
}
