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
 * Resolves the role a connecting user has on a page, bootstrapping ownership
 * for brand-new (zero-role) pages and auto-enrolling anyone else as an
 * editor. A page is "unclaimed" until its first role row exists; the first
 * person to open it via the WebSocket gateway becomes its owner. Any other
 * signed-in account that opens the same page link afterward gets an editor
 * row created on the spot — this is meant to work like a shared document
 * link (whoever has it can open and edit), not an invite-only page; "owner"
 * is just whoever got there first, kept distinct so page-role management
 * (grantRole/audit log) still has a single accountable admin per page.
 * Explicitly downgrading someone back to viewer, or off a page entirely, is
 * still the owner's call via grantRole.
 *
 * Neither insert is wrapped in a serializable transaction: a race between
 * two simultaneous first-opens of a new page would (at worst) both insert
 * 'owner' rows for two different users, which just means two owners instead
 * of one — not a security hole, since both are still legitimately "whoever
 * got here first." Worth revisiting if this ever needs single-owner
 * guarantees under real concurrency.
 */
export async function resolveRoleForConnection(pool: Pool, pageId: string, userId: string): Promise<Role | null> {
  const existing = await getExistingRole(pool, pageId, userId);
  if (existing) return existing;

  const anyRole = await pool.query("SELECT 1 FROM page_roles WHERE page_id = $1 LIMIT 1", [pageId]);
  if ((anyRole.rowCount ?? 0) === 0) {
    await pool.query(
      "INSERT INTO page_roles (page_id, user_id, role) VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING",
      [pageId, userId]
    );
    return "owner";
  }

  await pool.query(
    "INSERT INTO page_roles (page_id, user_id, role) VALUES ($1, $2, 'editor') ON CONFLICT DO NOTHING",
    [pageId, userId]
  );
  return "editor";
}

export class NotOwnerError extends Error {
  constructor(pageId: string) {
    super(`caller is not an owner of page ${pageId}`);
    this.name = "NotOwnerError";
  }
}

/** Grants (or updates) a role for a user on a page. Only an existing owner may call this. */
export async function grantRole(
  pool: Pool,
  pageId: string,
  granterId: string,
  granteeUserId: string,
  role: Role
): Promise<void> {
  const granterRole = await getExistingRole(pool, pageId, granterId);
  if (granterRole !== "owner") throw new NotOwnerError(pageId);

  await pool.query(
    `INSERT INTO page_roles (page_id, user_id, role) VALUES ($1, $2, $3)
     ON CONFLICT (page_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
    [pageId, granteeUserId, role]
  );
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
