import type { Pool } from "pg";
import type { Role } from "@collab/shared";

/** Plain lookup with no side effects. Document creation is the only operation
 * that establishes ownership; reads and WebSocket connections never grant it. */
export async function getExistingRole(pool: Pool, pageId: string, userId: string): Promise<Role | null> {
  const result = await pool.query<{ role: Role }>("SELECT role FROM page_roles WHERE page_id = $1 AND user_id = $2", [
    pageId,
    userId,
  ]);
  return result.rows[0]?.role ?? null;
}

/**
 * Resolves a connecting user's existing role. The document must already exist
 * and the user must be its owner or have accepted an invitation; otherwise the
 * gateway rejects the connection.
 */
export async function resolveRoleForConnection(pool: Pool, pageId: string, userId: string): Promise<Role | null> {
  const result = await pool.query<{ role: Role }>(
    `SELECT pr.role
     FROM documents d
     JOIN page_roles pr ON pr.page_id = d.id
     WHERE d.id = $1 AND pr.user_id = $2`,
    [pageId, userId]
  );
  return result.rows[0]?.role ?? null;
}

export class NotOwnerError extends Error {
  constructor(pageId: string) {
    super(`caller is not an owner of page ${pageId}`);
    this.name = "NotOwnerError";
  }
}

/** Raised when an owner-management call attempts to create or transfer ownership. */
export class OwnerRoleGrantNotAllowedError extends Error {
  constructor(pageId: string) {
    super(`ownership for page ${pageId} is established when the document is created`);
    this.name = "OwnerRoleGrantNotAllowedError";
  }
}

/** Grants (or updates) editor/viewer access for a page. Ownership is immutable after document creation. */
export async function grantRole(
  pool: Pool,
  pageId: string,
  granterId: string,
  granteeUserId: string,
  role: Role
): Promise<void> {
  if (role === "owner") throw new OwnerRoleGrantNotAllowedError(pageId);

  const granterRole = await getExistingRole(pool, pageId, granterId);
  if (granterRole !== "owner") throw new NotOwnerError(pageId);

  await pool.query(
    `INSERT INTO page_roles (page_id, user_id, role) VALUES ($1, $2, $3)
     ON CONFLICT (page_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
    [pageId, granteeUserId, role]
  );
}

/** Removes an editor/viewer grant. The immutable owner row is intentionally
 * never deleted; ownership transfer/removal requires a separate, audited
 * lifecycle operation and is outside this endpoint. */
export async function revokeRole(pool: Pool, pageId: string, revokerId: string, granteeUserId: string): Promise<boolean> {
  const revokerRole = await getExistingRole(pool, pageId, revokerId);
  if (revokerRole !== "owner") throw new NotOwnerError(pageId);

  const result = await pool.query(
    `DELETE FROM page_roles
     WHERE page_id = $1 AND user_id = $2 AND role <> 'owner'
     RETURNING user_id`,
    [pageId, granteeUserId]
  );
  return (result.rowCount ?? 0) > 0;
}

/** Who has access to a page and at what role — joined with `users` for email
 *  (not just user id) since the one current consumer, @mention autocomplete,
 *  needs something a person can recognize and type after `@`. */
export async function listRoles(pool: Pool, pageId: string): Promise<Array<{ userId: string; email: string; role: Role }>> {
  const result = await pool.query<{ user_id: string; email: string; role: Role }>(
    `SELECT page_roles.user_id, users.email, page_roles.role
     FROM page_roles JOIN users ON users.id = page_roles.user_id
     WHERE page_roles.page_id = $1
     ORDER BY users.email`,
    [pageId]
  );
  return result.rows.map((r) => ({ userId: r.user_id, email: r.email, role: r.role }));
}
