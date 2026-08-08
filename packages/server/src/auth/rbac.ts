import type { Pool } from "pg";
import type { Role } from "@collab/shared";

/** Plain lookup, no side effects. Used by HTTP read endpoints (version history,
 *  presence) so that polling a URL for a page nobody has claimed can't itself
 *  grant ownership — only the WebSocket connect path (resolveRoleForConnection)
 *  bootstraps ownership, because that's the "I'm actually opening this page to
 *  work on it" signal. */
export async function getExistingRole(pool: Pool, pageId: string, userId: string): Promise<Role | null> {
  const result = await pool.query<{ role: Role }>("SELECT role FROM page_roles WHERE page_id = $1 AND user_id = $2", [
    pageId,
    userId,
  ]);
  return result.rows[0]?.role ?? null;
}

/**
 * Resolves the role a connecting user has on a page. A newly opened page is
 * claimed exactly once by atomically inserting its `page_claims` row; that
 * claimant becomes its owner. Once claimed, access is invite-only: users
 * without an existing page_roles row receive null and the gateway rejects
 * their connection. The claim row, rather than a read-then-insert over
 * page_roles, closes the first-open race that could otherwise create two
 * owners under concurrent WebSocket connections.
 */
export async function resolveRoleForConnection(pool: Pool, pageId: string, userId: string): Promise<Role | null> {
  const existing = await getExistingRole(pool, pageId, userId);
  if (existing) return existing;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Re-check after beginning the transaction: an owner can grant this user
    // access after the fast-path lookup above but before this connection's
    // claim attempt.
    const roleResult = await client.query<{ role: Role }>(
      "SELECT role FROM page_roles WHERE page_id = $1 AND user_id = $2",
      [pageId, userId]
    );
    const grantedRole = roleResult.rows[0]?.role;
    if (grantedRole) {
      await client.query("COMMIT");
      return grantedRole;
    }

    await client.query(
      `INSERT INTO page_claims (page_id, owner_user_id)
       VALUES ($1, $2)
       ON CONFLICT (page_id) DO NOTHING`,
      [pageId, userId]
    );
    const claim = await client.query<{ owner_user_id: string }>(
      "SELECT owner_user_id FROM page_claims WHERE page_id = $1",
      [pageId]
    );
    if (claim.rows[0]?.owner_user_id === userId) {
      await client.query(
        "INSERT INTO page_roles (page_id, user_id, role) VALUES ($1, $2, 'owner') ON CONFLICT (page_id, user_id) DO NOTHING",
        [pageId, userId]
      );
      await client.query("COMMIT");
      return "owner";
    }

    // A page claim already exists and the user has no invitation. Do not
    // create a role as a side effect of merely knowing its identifier.
    await client.query("COMMIT");
    return null;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
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
    super(`ownership for page ${pageId} is established only by its initial claim`);
    this.name = "OwnerRoleGrantNotAllowedError";
  }
}

/** Grants (or updates) editor/viewer access for a page. Ownership is immutable after the initial claim. */
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
