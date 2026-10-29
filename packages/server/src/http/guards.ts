import type { FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { roleAtLeast, type Role } from "@docsync/shared";
import { verifyToken } from "../auth/jwt.js";
import { getExistingRole } from "../auth/rbac.js";
import type { PageStore } from "../persistence/page-store.js";
import type { AppDeps } from "./deps.js";

/** An error with an HTTP status; the app's error handler renders it as
 *  `{ error: message, ...body }`. */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly body: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export interface RequestUser {
  userId: string;
  email: string;
}

/**
 * Authorization helpers shared by every route. Each one either returns what
 * the route needs or throws an HttpError, so handlers read top to bottom
 * without nested promise chains or early-return bookkeeping.
 */
export function createGuards(deps: AppDeps) {
  /** The caller, or null when auth is disabled (local bypass). Throws 401 when
   *  auth is enabled and the bearer token is missing or invalid. */
  function currentUser(request: FastifyRequest): RequestUser | null {
    if (!deps.jwtSecret) return null;
    const header = request.headers.authorization;
    const payload = header?.startsWith("Bearer ") ? verifyToken(header.slice("Bearer ".length), deps.jwtSecret) : null;
    if (!payload) throw new HttpError(401, "missing or invalid bearer token");
    return { userId: payload.sub, email: payload.email };
  }

  /** For features with no meaning without an identity (my documents, my
   *  notifications): requires auth to be enabled, not just a valid token. */
  function signedInUser(request: FastifyRequest): RequestUser {
    const user = currentUser(request);
    if (!user) throw new HttpError(503, "this feature requires authentication");
    return user;
  }

  function pool(): Pool {
    if (!deps.pool) throw new HttpError(503, "this feature requires DATABASE_URL");
    return deps.pool;
  }

  function pageStore(): PageStore {
    if (!deps.pageStore) throw new HttpError(503, "persistence disabled (no DATABASE_URL)");
    return deps.pageStore;
  }

  /**
   * The caller's role on a page, re-read from Postgres on every request.
   * Returns null when auth is disabled. Throws 403 when the caller has no role,
   * or a lower one than `minimum` (with `deniedMessage`).
   */
  async function pageRole(request: FastifyRequest, pageId: string, minimum?: Role, deniedMessage?: string): Promise<Role | null> {
    const user = currentUser(request);
    if (!user) return null;
    const role = await getExistingRole(pool(), pageId, user.userId);
    if (!role) throw new HttpError(403, "no access to this page");
    if (minimum && !roleAtLeast(role, minimum)) throw new HttpError(403, deniedMessage ?? `${minimum} access required`);
    return role;
  }

  return { currentUser, signedInUser, pool, pageStore, pageRole };
}

export type Guards = ReturnType<typeof createGuards>;
