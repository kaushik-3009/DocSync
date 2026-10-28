import { z } from "zod/v4";
import { createUser, verifyCredentials, findUserById, EmailAlreadyRegisteredError } from "../../auth/users.js";
import { ACCESS_TOKEN_TTL_SECONDS, signToken } from "../../auth/jwt.js";
import { issueRefreshToken, revokeRefreshToken, rotateRefreshToken } from "../../auth/refresh-tokens.js";
import { recordAudit } from "../../auth/audit.js";
import { materializePendingInvitationsForUser } from "../../invitations/store.js";
import { tryConsume } from "../../rate-limit/limiters.js";
import { authLoginAttemptsTotal, rateLimitRejectionsTotal } from "../../metrics/registry.js";
import { HttpError } from "../guards.js";
import type { RoutePlugin } from "./types.js";

const credentials = z.object({
  email: z.string().trim().min(3).max(320),
  password: z.string().min(1).max(1024),
});
const refreshBody = z.object({ refreshToken: z.string().min(10).max(512) });

export const authRoutes: RoutePlugin = async (app, { deps, guards }) => {
  /** Access + refresh token pair for a newly authenticated session. */
  async function session(user: { id: string; email: string }) {
    if (!deps.jwtSecret) throw new HttpError(503, "JWT_SECRET not configured");
    const refresh = await issueRefreshToken(guards.pool(), user.id);
    return {
      token: signToken({ sub: user.id, email: user.email }, deps.jwtSecret),
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
      refreshToken: refresh.token,
      refreshExpiresAt: refresh.expiresAt.toISOString(),
    };
  }

  async function consume(limiter: Parameters<typeof tryConsume>[0], key: string, scope: string, message: string) {
    const { allowed, infraError } = await tryConsume(limiter, key);
    if (infraError)
      app.log.error({ event: "rate_limiter_store_error", scope, err: infraError }, "rate limiter store unavailable — failing open");
    if (!allowed) {
      rateLimitRejectionsTotal.inc({ scope });
      throw new HttpError(429, message);
    }
  }

  app.post("/auth/register", { schema: { tags: ["auth"], body: credentials } }, async (request, reply) => {
    const pool = guards.pool();
    // Registration necessarily reveals whether an email is taken (409 vs
    // 201); a tight per-IP budget keeps that oracle too slow for enumeration.
    await consume(deps.limiters.register, request.ip, "register", "too many registration attempts, try again later");
    try {
      const user = await createUser(pool, request.body.email, request.body.password);
      await materializePendingInvitationsForUser(pool, user);
      recordAudit(pool, { userId: user.id, pageId: null, event: "user_registered" });
      return reply.code(201).send(await session(user));
    } catch (err) {
      if (err instanceof EmailAlreadyRegisteredError) throw new HttpError(409, err.message);
      throw err;
    }
  });

  app.post("/auth/login", { schema: { tags: ["auth"], body: credentials } }, async (request) => {
    const pool = guards.pool();
    const { email, password } = request.body;
    // Keyed by IP+email and checked before the scrypt comparison, so a
    // locked-out attacker can't even make the server hash.
    await consume(deps.limiters.login, `${request.ip}:${email}`, "login", "too many login attempts, try again later");
    const user = await verifyCredentials(pool, email, password);
    if (!user) {
      authLoginAttemptsTotal.inc({ outcome: "failure" });
      // Not attributed to an account: that would turn the audit log into a
      // probe for which emails exist.
      recordAudit(pool, { userId: null, pageId: null, event: "login_failed", metadata: { email } });
      throw new HttpError(401, "invalid email or password");
    }
    authLoginAttemptsTotal.inc({ outcome: "success" });
    recordAudit(pool, { userId: user.id, pageId: null, event: "user_login" });
    return session(user);
  });

  app.post("/auth/refresh", { schema: { tags: ["auth"], body: refreshBody } }, async (request) => {
    const pool = guards.pool();
    if (!deps.jwtSecret) throw new HttpError(503, "JWT_SECRET not configured");
    const rotation = await rotateRefreshToken(pool, request.body.refreshToken);
    if (!rotation.ok) {
      if (rotation.reason === "reused") recordAudit(pool, { userId: null, pageId: null, event: "refresh_token_reuse" });
      throw new HttpError(401, "session expired; sign in again", { reason: rotation.reason });
    }
    const user = await findUserById(pool, rotation.userId);
    if (!user) throw new HttpError(401, "session expired; sign in again");
    return {
      token: signToken({ sub: user.id, email: user.email }, deps.jwtSecret),
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
      refreshToken: rotation.refreshToken.token,
      refreshExpiresAt: rotation.refreshToken.expiresAt.toISOString(),
    };
  });

  app.post("/auth/logout", { schema: { tags: ["auth"], body: refreshBody } }, async (request, reply) => {
    await revokeRefreshToken(guards.pool(), request.body.refreshToken);
    return reply.code(204).send();
  });
};
