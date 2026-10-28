import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Pool } from "pg";
import { childLogger } from "../logger.js";

const log = childLogger({ module: "refresh-tokens" });

export const REFRESH_TOKEN_TTL_MS = Number(process.env.REFRESH_TOKEN_TTL_SECONDS ?? 30 * 24 * 60 * 60) * 1000;

export interface IssuedRefreshToken {
  token: string;
  expiresAt: Date;
}

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

async function insertToken(pool: Pool, userId: string, familyId: string): Promise<IssuedRefreshToken> {
  const id = randomUUID();
  const secret = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);
  await pool.query(`INSERT INTO refresh_tokens (id, user_id, family_id, token_hash, expires_at) VALUES ($1, $2, $3, $4, $5)`, [
    id,
    userId,
    familyId,
    hashSecret(secret),
    expiresAt,
  ]);
  // `<id>.<secret>`: the id is a lookup key, only the secret's hash is stored.
  return { token: `${id}.${secret}`, expiresAt };
}

/** Starts a new session (token family) at login/registration. */
export function issueRefreshToken(pool: Pool, userId: string): Promise<IssuedRefreshToken> {
  return insertToken(pool, userId, randomUUID());
}

export type RotationResult =
  { ok: true; userId: string; refreshToken: IssuedRefreshToken } | { ok: false; reason: "invalid" | "expired" | "revoked" | "reused" };

/**
 * Exchanges a refresh token for a new one in the same family. Each token is
 * single-use: presenting an already-rotated token means it was copied, so
 * the whole family is revoked and both the thief and the victim must log in
 * again (OAuth 2.0 Security BCP refresh token reuse detection).
 */
export async function rotateRefreshToken(pool: Pool, presented: string): Promise<RotationResult> {
  const [id, secret] = presented.split(".");
  if (!id || !secret) return { ok: false, reason: "invalid" };
  const { rows } = await pool.query<{
    user_id: string;
    family_id: string;
    token_hash: string;
    expires_at: Date;
    rotated_at: Date | null;
    revoked_at: Date | null;
  }>(`SELECT user_id, family_id, token_hash, expires_at, rotated_at, revoked_at FROM refresh_tokens WHERE id = $1`, [id]);
  const row = rows[0];
  if (!row) return { ok: false, reason: "invalid" };
  const expected = Buffer.from(row.token_hash, "hex");
  const actual = Buffer.from(hashSecret(secret), "hex");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return { ok: false, reason: "invalid" };
  if (row.revoked_at) return { ok: false, reason: "revoked" };
  if (row.rotated_at) {
    await revokeFamily(pool, row.family_id);
    log.warn(
      { event: "refresh_token_reuse_detected", userId: row.user_id, familyId: row.family_id },
      "revoked session after refresh token reuse"
    );
    return { ok: false, reason: "reused" };
  }
  if (new Date(row.expires_at).getTime() <= Date.now()) return { ok: false, reason: "expired" };

  // Conditional update: two concurrent refreshes with the same token cannot
  // both succeed; the loser is treated as reuse.
  const claimed = await pool.query(
    `UPDATE refresh_tokens SET rotated_at = $1 WHERE id = $2 AND rotated_at IS NULL AND revoked_at IS NULL RETURNING id`,
    [new Date(), id]
  );
  if ((claimed.rowCount ?? 0) === 0) {
    await revokeFamily(pool, row.family_id);
    return { ok: false, reason: "reused" };
  }
  return { ok: true, userId: row.user_id, refreshToken: await insertToken(pool, row.user_id, row.family_id) };
}

/** Logout: revokes the presented token's whole session. Unknown tokens are a no-op. */
export async function revokeRefreshToken(pool: Pool, presented: string): Promise<void> {
  const [id] = presented.split(".");
  if (!id) return;
  const { rows } = await pool.query<{ family_id: string }>(`SELECT family_id FROM refresh_tokens WHERE id = $1`, [id]);
  if (rows[0]) await revokeFamily(pool, rows[0].family_id);
}

/** Ends every session a user has (e.g. "sign out everywhere", password change). */
export async function revokeAllForUser(pool: Pool, userId: string): Promise<void> {
  await pool.query(`UPDATE refresh_tokens SET revoked_at = $1 WHERE user_id = $2 AND revoked_at IS NULL`, [new Date(), userId]);
}

async function revokeFamily(pool: Pool, familyId: string): Promise<void> {
  await pool.query(`UPDATE refresh_tokens SET revoked_at = $1 WHERE family_id = $2 AND revoked_at IS NULL`, [new Date(), familyId]);
}
