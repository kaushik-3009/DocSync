/**
 * A page's RBAC roles, ordered least to most privileged. Shared (not
 * server-only) because the client needs it too — e.g. to hide the "add
 * block" affordance for a viewer instead of letting every attempt round-trip
 * to the server just to be silently dropped.
 */
export type Role = "viewer" | "editor" | "owner";

const ROLE_RANK: Record<Role, number> = { viewer: 0, editor: 1, owner: 2 };

/** True if `role` grants at least the privileges of `minimum`. */
export function roleAtLeast(role: Role, minimum: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minimum];
}

export function canEditContent(role: Role | null): boolean {
  return role !== null && roleAtLeast(role, "editor");
}
