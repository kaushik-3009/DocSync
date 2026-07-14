import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Pool } from "pg";
import Redis from "ioredis";
import { context, trace } from "@opentelemetry/api";
import {
  serializeDocument,
  serializeDocumentWithDeltas,
  dedupePresenceByUser,
  restoreBlocksFromSnapshot,
  roleAtLeast,
} from "@collab/shared";
import { tracer, shutdownTracing } from "./tracing/tracer.js";
import { RoomRegistry } from "./room-registry.js";
import { attachWsGateway, type WsAuthConfig, type WsRateLimitConfig } from "./ws-gateway.js";
import { logger } from "./logger.js";
import { runMigrations } from "./persistence/db.js";
import { PageStore } from "./persistence/page-store.js";
import { RedisRoomBroadcaster, type RoomBroadcaster } from "./redis/broadcaster.js";
import { createUser, verifyCredentials, findUserByEmail, EmailAlreadyRegisteredError } from "./auth/users.js";
import { signToken } from "./auth/jwt.js";
import { authenticateRequest } from "./auth/http.js";
import { getExistingRole, grantRole, listRoles, NotOwnerError } from "./auth/rbac.js";
import { recordAudit, listAuditLog } from "./auth/audit.js";
import { JobQueues } from "./jobs/queues.js";
import { startWorkers } from "./jobs/workers.js";
import { searchPages } from "./jobs/search.js";
import { MentionsStore } from "./comments/mentions-store.js";
import { metricsRegistry, httpRequestDuration, authLoginAttemptsTotal, rateLimitRejectionsTotal } from "./metrics/registry.js";
import {
  createLoginLimiter,
  createRegisterLimiter,
  createHttpLimiter,
  createWsConnectLimiter,
  createWsMessageLimiter,
  tryConsume,
} from "./rate-limit/limiters.js";

const PORT = Number(process.env.PORT ?? 1234);
// `X-Forwarded-For` is only meaningful if it's set by a proxy this server
// actually sits behind (nginx in this project's own docker-compose.yml) —
// trusting it unconditionally lets any direct caller set an arbitrary IP
// per request, fully bypassing every IP-keyed rate limiter (login
// brute-force, registration, WS connect flood) just by sending a fresh
// fake value each time. Off by default; the deployment (nginx.conf here)
// is expected to set TRUST_PROXY=1 precisely because it's the one thing
// standing between the server and the internet.
const TRUST_PROXY = process.env.TRUST_PROXY === "1";
const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL;
const JWT_SECRET = process.env.JWT_SECRET;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? "http://localhost:5173")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const MAX_HTTP_BODY_BYTES = Number(process.env.MAX_HTTP_BODY_BYTES ?? 65_536);

let pageStore: PageStore | null = null;
let pool: Pool | null = null;
if (DATABASE_URL) {
  pool = new Pool({ connectionString: DATABASE_URL });
  await runMigrations(pool);
  pageStore = new PageStore(pool);
  logger.info({ event: "persistence_enabled" }, "connected to Postgres, persistence enabled");
} else {
  logger.warn(
    { event: "persistence_disabled" },
    "DATABASE_URL not set — running in-memory only, documents will not survive a restart"
  );
}

let broadcaster: RoomBroadcaster | null = null;
// Held at module scope (not just inside the `if` below) purely so shutdown()
// can quit them on SIGTERM/SIGINT — see shutdown() further down.
let broadcasterPub: Redis | null = null;
let broadcasterSub: Redis | null = null;
if (REDIS_URL) {
  // Separate connections for publishing and subscribing: once an ioredis
  // connection issues SUBSCRIBE it can only issue further (un)subscribe
  // commands, so a single shared connection can't do both.
  broadcasterPub = new Redis(REDIS_URL);
  broadcasterSub = new Redis(REDIS_URL);
  broadcaster = new RedisRoomBroadcaster(broadcasterPub, broadcasterSub);
  logger.info({ event: "fanout_enabled" }, "connected to Redis, cross-instance fanout enabled");
} else {
  logger.warn(
    { event: "fanout_disabled" },
    "REDIS_URL not set — running single-instance only, updates will not reach other processes"
  );
}

// Background jobs (Phase 6) require both Redis (BullMQ's queue/worker backend)
// and Postgres (the processors load a page's persisted state and write their
// results there) — without both, the server runs exactly as before: no
// search index, no previews, no exports, and Room never tries to enqueue
// anything (jobQueues stays null, same "optional collaborator" pattern).
let jobQueues: JobQueues | null = null;
let stopWorkers: (() => Promise<void>) | null = null;
let jobsConnection: Redis | null = null;
if (REDIS_URL && pool) {
  // BullMQ requires maxRetriesPerRequest: null on any connection used for its
  // blocking commands (Workers in particular) — without it, ioredis's default
  // retry behavior conflicts with how BullMQ manages long-lived blocking calls.
  jobsConnection = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
  jobQueues = new JobQueues(jobsConnection);
  const workers = startWorkers(jobsConnection, pool, pageStore!);
  stopWorkers = workers.close;
  logger.info({ event: "jobs_enabled" }, "background job pipeline enabled (search index, previews, PDF export)");
} else {
  logger.warn(
    { event: "jobs_disabled" },
    "REDIS_URL and/or DATABASE_URL not set — background jobs (search, previews, export) are disabled"
  );
}

// Mentions (Phase 10) only need Postgres — resolving a mentioned email to a
// user and storing a queryable row doesn't involve Redis/BullMQ at all, so
// this follows pageStore's gating, not jobQueues'.
const mentionsStore: MentionsStore | null = pool ? new MentionsStore(pool) : null;

// Auth (Phase 5) requires both a JWT secret (to sign/verify tokens) and
// Postgres (users/roles/audit log all live there) — without both, the
// server runs exactly as Phases 1-4 did: unauthenticated, unrestricted.
let auth: WsAuthConfig | null = null;
if (JWT_SECRET && pool) {
  auth = { jwtSecret: JWT_SECRET, pool };
  logger.info({ event: "auth_enabled" }, "JWT auth + RBAC enabled");
} else if (JWT_SECRET && !pool) {
  logger.warn({ event: "auth_disabled" }, "JWT_SECRET set but DATABASE_URL is not — auth requires Postgres, staying open");
} else {
  logger.warn({ event: "auth_disabled" }, "JWT_SECRET not set — running without auth, every connection is unrestricted");
}

// Rate limiting (Phase 7) works with or without Redis — with it, limits are shared
// across every instance behind the Phase 4 load balancer; without it, each instance
// enforces its own limit independently (a real, documented gap, not a silent one —
// see ARCHITECTURE.md). This is why rate limiting doesn't require DATABASE_URL or
// REDIS_URL the way auth/jobs do: it's baseline abuse protection, always on.
const rateLimitRedis = REDIS_URL ? new Redis(REDIS_URL) : null;
const loginLimiter = createLoginLimiter(rateLimitRedis);
const registerLimiter = createRegisterLimiter(rateLimitRedis);
const httpLimiter = createHttpLimiter(rateLimitRedis);
const wsRateLimit: WsRateLimitConfig = {
  connect: createWsConnectLimiter(rateLimitRedis),
  message: createWsMessageLimiter(),
};
if (!rateLimitRedis) {
  logger.warn(
    { event: "rate_limit_instance_only" },
    "REDIS_URL not set — rate limits are enforced per-instance only, not shared across a multi-instance deployment"
  );
}

// jobQueues was previously never passed here — Room's search-index/preview
// enqueue calls were consequently always no-ops in the real server (only
// test/jobs.test.ts's direct processor calls exercised that logic), a real
// pre-existing wiring bug fixed alongside adding mentionsStore below.
const registry = new RoomRegistry(pageStore, broadcaster, jobQueues, mentionsStore);

const VERSIONS_PATH = /^\/pages\/([A-Za-z0-9_-]+)\/versions$/;
const VERSION_AT_PATH = /^\/pages\/([A-Za-z0-9_-]+)\/versions\/(\d+)$/;
const VERSION_RESTORE_PATH = /^\/pages\/([A-Za-z0-9_-]+)\/versions\/(\d+)\/restore$/;
const PRESENCE_PATH = /^\/pages\/([A-Za-z0-9_-]+)\/presence$/;
const ROLES_PATH = /^\/pages\/([A-Za-z0-9_-]+)\/roles$/;
const AUDIT_LOG_PATH = /^\/pages\/([A-Za-z0-9_-]+)\/audit-log$/;
const PREVIEW_HTTP_PATH = /^\/pages\/([A-Za-z0-9_-]+)\/preview$/;
const EXPORT_PATH = /^\/pages\/([A-Za-z0-9_-]+)\/export$/;
const EXPORT_STATUS_PATH = /^\/pages\/([A-Za-z0-9_-]+)\/export\/([A-Za-z0-9_-]+)$/;
const EXPORT_DOWNLOAD_PATH = /^\/exports\/([A-Za-z0-9_-]+)$/;

function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let raw = "";
    let bytes = 0;
    req.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_HTTP_BODY_BYTES) {
        req.destroy();
        reject(new Error("request body too large"));
        return;
      }
      raw += chunk;
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : ({} as T));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Terminal `.catch()` for a route's promise chain — without one, a rejection
 *  (e.g. a transient Postgres error) is an unhandled rejection, which crashes
 *  the whole process (Node 15+ default) and drops every WebSocket room on
 *  this instance, not just the one request that failed. */
function handleRouteError(res: ServerResponse, event: string, err: unknown): void {
  logger.error({ event, err }, "request handler failed");
  if (!res.headersSent) sendJson(res, 500, { error: "internal server error" });
}

/** Requires a valid bearer token; returns the userId or null (and writes a 401) if auth is
 *  enabled and the request has none. When auth is disabled, always returns null without
 *  writing a response — callers proceed exactly as before. */
function requireAuthIfEnabled(req: IncomingMessage, res: ServerResponse): { userId: string } | null | "unauthenticated" {
  if (!auth) return null;
  const payload = authenticateRequest(req, auth.jwtSecret);
  if (!payload) {
    sendJson(res, 401, { error: "missing or invalid bearer token" });
    return "unauthenticated";
  }
  return { userId: payload.sub };
}

/** Collapses a raw path into a low-cardinality label for the duration histogram —
 *  labeling by the exact URL (with page ids/export ids embedded) would create one
 *  time series per distinct page ever touched, which defeats the point of a metric. */
function routeLabelFor(pathname: string): string {
  if (pathname === "/health" || pathname === "/metrics" || pathname.startsWith("/auth/") || pathname === "/search") {
    return pathname;
  }
  return pathname.replace(/\/pages\/[^/]+/, "/pages/:pageId").replace(/\/exports\/[^/]+/, "/exports/:id");
}

function clientIpForHttp(req: IncomingMessage): string {
  if (TRUST_PROXY) {
    const forwarded = req.headers["x-forwarded-for"];
    if (typeof forwarded === "string" && forwarded.length > 0) return forwarded.split(",")[0].trim();
  }
  return req.socket.remoteAddress ?? "unknown";
}

const httpServer = createServer((req, res) => {
  const url = req.url ?? "";
  const pathname = url.split("?")[0];
  const route = routeLabelFor(pathname);
  const start = process.hrtime.bigint();

  // Root span for this request — active (via context.with below) for
  // whatever handleRoute() ends up doing, so a DB write's
  // "persistence.record_update" span, a job's "job.enqueue.*" span, etc.
  // nest under exactly the request that triggered them instead of showing
  // up as unrelated root spans in Jaeger.
  const span = tracer.startSpan("http.request", {
    attributes: { "http.method": req.method ?? "GET", "http.route": route },
  });
  const requestContext = trace.setSpan(context.active(), span);

  res.on("finish", () => {
    const seconds = Number(process.hrtime.bigint() - start) / 1e9;
    httpRequestDuration.observe({ method: req.method ?? "GET", route, status: res.statusCode }, seconds);
    span.setAttribute("http.status_code", res.statusCode);
    span.end();
  });

  // The client and this server are different origins in local dev (Vite on
  // :5173, this server on :1234) and potentially in production too (a
  // CDN-hosted client, a separately-deployed API) — without CORS headers the
  // browser silently drops every response before any JS sees it, surfacing
  // as an opaque "Failed to fetch" with no hint it was CORS at all. Bearer
  // tokens (not cookies) carry auth here, so a wildcard origin has no
  // ambient credential to leak.
  const requestOrigin = req.headers.origin;
  if (requestOrigin && ALLOWED_ORIGINS.includes(requestOrigin)) {
    res.setHeader("Access-Control-Allow-Origin", requestOrigin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (pathname === "/health") {
    // `authRequired` lets the client decide, on load, whether to gate the UI
    // behind the login screen or let a guest identity straight in — same
    // "auth is a feature that degrades, not an on/off switch the client has
    // to already know about" pattern as everything else `auth` gates below.
    sendJson(res, 200, { status: "ok", rooms: registry.activeRoomCount, authRequired: Boolean(auth) });
    return;
  }

  if (pathname === "/metrics") {
    metricsRegistry
      .metrics()
      .then((body) => {
        res.writeHead(200, { "content-type": metricsRegistry.contentType });
        res.end(body);
      })
      .catch((err) => handleRouteError(res, "metrics_failed", err));
    return;
  }

  if (route !== "/metrics" && route !== "/health") {
    // Fire-and-forget-style rate limit check: every non-metrics/health request
    // consumes one point from the general HTTP limiter before anything else runs.
    tryConsume(httpLimiter, clientIpForHttp(req)).then(({ allowed, infraError }) => {
      if (infraError) {
        logger.error({ event: "rate_limiter_store_error", scope: "http", err: infraError }, "rate limiter store unavailable — failing open");
      }
      if (!allowed) {
        rateLimitRejectionsTotal.inc({ scope: "http" });
        res.writeHead(429, { "content-type": "application/json", "retry-after": "60" });
        res.end(JSON.stringify({ error: "rate limit exceeded" }));
        return;
      }
      context.with(requestContext, handleRoute);
    });
    return;
  }
  context.with(requestContext, handleRoute);

  function handleRoute(): void {
  if (req.method === "POST" && url === "/auth/register") {
    if (!pool) return sendJson(res, 503, { error: "auth requires DATABASE_URL" });
    readJsonBody<{ email?: string; password?: string }>(req)
      .then(({ email, password }) => {
        if (!email || !password) return sendJson(res, 400, { error: "email and password are required" });

        // A separate try/catch boundary from readJsonBody's above: that one
        // is genuinely a client input error (malformed JSON), but an error
        // thrown from here on (e.g. Postgres unreachable mid-request) is an
        // infrastructure failure, not a bad request — conflating the two
        // used to report a DB outage to the client as "invalid request
        // body," masking a real 5xx as a 400 in both the response and logs.
        return (async () => {
          // Registration reveals whether an email is already taken (409 vs 201) —
          // there's no way around that without either handing out a token for
          // someone else's account or breaking standard signup UX. A tight
          // per-IP budget (see limiters.ts) keeps that oracle too slow to use
          // for bulk enumeration, mirroring login's brute-force protection.
          const registerLimit = await tryConsume(registerLimiter, clientIpForHttp(req));
          if (registerLimit.infraError) {
            logger.error({ event: "rate_limiter_store_error", scope: "register", err: registerLimit.infraError }, "rate limiter store unavailable — failing open");
          }
          if (!registerLimit.allowed) {
            rateLimitRejectionsTotal.inc({ scope: "register" });
            return sendJson(res, 429, { error: "too many registration attempts, try again later" });
          }

          try {
            const user = await createUser(pool!, email, password);
            recordAudit(pool!, { userId: user.id, pageId: null, event: "user_registered" });
            if (!JWT_SECRET) return sendJson(res, 503, { error: "JWT_SECRET not configured" });
            sendJson(res, 201, { token: signToken({ sub: user.id, email: user.email }, JWT_SECRET) });
          } catch (err) {
            if (err instanceof EmailAlreadyRegisteredError) return sendJson(res, 409, { error: err.message });
            throw err;
          }
        })().catch((err) => handleRouteError(res, "register_failed", err));
      })
      .catch((err) => {
        logger.error({ event: "register_bad_body", err }, "failed to parse registration request body");
        sendJson(res, 400, { error: "invalid request body" });
      });
    return;
  }

  if (req.method === "POST" && url === "/auth/login") {
    if (!pool) return sendJson(res, 503, { error: "auth requires DATABASE_URL" });
    readJsonBody<{ email?: string; password?: string }>(req)
      .then(({ email, password }) => {
        if (!email || !password) return sendJson(res, 400, { error: "email and password are required" });

        // Same split as /auth/register above: a malformed request body is a
        // client error (caught below), but anything thrown from here on
        // (e.g. Postgres unreachable) is an infrastructure failure and
        // should surface as a 5xx, not get reported as a bad request.
        return (async () => {
          // Brute-force protection keyed by IP+email (see limiters.ts) — checked after
          // parsing the body (need the email to build the key) but before touching the
          // password hash, so a locked-out attacker can't even trigger a scrypt hash
          // comparison (the expensive part) by retrying.
          const loginLimit = await tryConsume(loginLimiter, `${clientIpForHttp(req)}:${email}`);
          if (loginLimit.infraError) {
            logger.error({ event: "rate_limiter_store_error", scope: "login", err: loginLimit.infraError }, "rate limiter store unavailable — failing open");
          }
          if (!loginLimit.allowed) {
            rateLimitRejectionsTotal.inc({ scope: "login" });
            return sendJson(res, 429, { error: "too many login attempts, try again later" });
          }

          const user = await verifyCredentials(pool!, email, password);
          if (!user) {
            authLoginAttemptsTotal.inc({ outcome: "failure" });
            // Unlike every other auth-relevant event, this previously only hit a
            // Prometheus counter — no per-account record of credential-guessing
            // attempts existed in the audit log. userId is null (there's no
            // account to attribute it to when the email doesn't match one, and
            // attributing a wrong-password attempt to the real account would let
            // the audit log itself become a probe for "is this email real").
            recordAudit(pool!, { userId: null, pageId: null, event: "login_failed", metadata: { email } });
            return sendJson(res, 401, { error: "invalid email or password" });
          }
          authLoginAttemptsTotal.inc({ outcome: "success" });
          recordAudit(pool!, { userId: user.id, pageId: null, event: "user_login" });
          if (!JWT_SECRET) return sendJson(res, 503, { error: "JWT_SECRET not configured" });
          sendJson(res, 200, { token: signToken({ sub: user.id, email: user.email }, JWT_SECRET) });
        })().catch((err) => handleRouteError(res, "login_failed", err));
      })
      .catch((err) => {
        logger.error({ event: "login_bad_body", err }, "failed to parse login request body");
        sendJson(res, 400, { error: "invalid request body" });
      });
    return;
  }

  const presenceMatch = url.match(PRESENCE_PATH);
  if (presenceMatch) {
    const authResult = requireAuthIfEnabled(req, res);
    if (authResult === "unauthenticated") return;
    const pageId = presenceMatch[1];
    if (authResult) {
      getExistingRole(auth!.pool, pageId, authResult.userId)
        .then((role) => {
          if (!role) return sendJson(res, 403, { error: "no access to this page" });
          sendPresence();
        })
        .catch((err) => handleRouteError(res, "presence_failed", err));
      return;
    }
    sendPresence();
    function sendPresence(): void {
    const room = registry.peekRoom(pageId);
    // Read-only and non-creating: polling this for a page nobody has
    // joined (on this instance) must not spin up an empty room. With a
    // RoomBroadcaster wired up (Phase 4), a room's awareness object is
    // mirrored from every instance via Redis, so this is now a cluster-wide
    // view — not just this process — as long as this instance also has the
    // room open (i.e. at least one local client, or another instance's
    // client, has ever touched this page since this process started).
    const rawPresence = room
      ? Array.from(room.awareness.getStates().values())
          .map((s) => s.presence)
          .filter(Boolean)
      : [];
    sendJson(res, 200, { pageId, presence: dedupePresenceByUser(rawPresence), instanceOnly: !broadcaster });
    }
    return;
  }

  const rolesMatch = url.match(ROLES_PATH);
  if (rolesMatch && req.method === "POST") {
    const authResult = requireAuthIfEnabled(req, res);
    if (authResult === "unauthenticated") return;
    if (!auth || !authResult) return sendJson(res, 503, { error: "auth not enabled" });
    const pageId = rolesMatch[1];
    readJsonBody<{ email?: string; role?: string }>(req)
      .then(async ({ email, role }) => {
        if (!email || (role !== "owner" && role !== "editor" && role !== "viewer")) {
          return sendJson(res, 400, { error: "email and a valid role (owner|editor|viewer) are required" });
        }

        // Ownership is checked before the grantee lookup, and a nonexistent
        // grantee gets the exact same response as a real one — previously the
        // grantee lookup ran first and returned a distinct 404, which let any
        // authenticated caller (not just this page's owner — grantRole's own
        // ownership check never even ran) use this endpoint to test arbitrary
        // emails for registration.
        const requesterRole = await getExistingRole(auth!.pool, pageId, authResult.userId);
        if (requesterRole !== "owner") {
          return sendJson(res, 403, { error: "only an owner can grant roles" });
        }

        const grantee = await findUserByEmail(auth!.pool, email);
        if (!grantee) return sendJson(res, 200, { pageId, granteeEmail: email, role });

        await grantRole(auth!.pool, pageId, authResult.userId, grantee.id, role);
        registry.disconnectUser(pageId, grantee.id);
        recordAudit(auth!.pool, {
          userId: authResult.userId,
          pageId,
          event: "role_granted",
          metadata: { granteeEmail: email, role },
        });
        sendJson(res, 200, { pageId, granteeEmail: email, role });
      })
      .catch((err) => {
        if (err instanceof NotOwnerError) return sendJson(res, 403, { error: err.message });
        handleRouteError(res, "grant_role_failed", err);
      });
    return;
  }

  if (rolesMatch && req.method === "GET") {
    // Who has access to this page — currently only consumed by @mention
    // autocomplete (so typing "@" suggests real collaborators, not a global
    // user search). Any of a page's own roles may view its roster; this is
    // not owner-only like granting is.
    if (!auth) return sendJson(res, 503, { error: "roles listing requires auth (JWT_SECRET + DATABASE_URL)" });
    const authResult = requireAuthIfEnabled(req, res);
    if (authResult === "unauthenticated") return;
    const pageId = rolesMatch[1];
    getExistingRole(auth.pool, pageId, authResult!.userId)
      .then((role) => {
        if (!role) return sendJson(res, 403, { error: "no access to this page" });
        return listRoles(auth!.pool, pageId).then((roles) => sendJson(res, 200, { pageId, roles }));
      })
      .catch((err) => handleRouteError(res, "list_roles_failed", err));
    return;
  }

  const auditMatch = url.match(AUDIT_LOG_PATH);
  if (auditMatch && req.method === "GET") {
    const authResult = requireAuthIfEnabled(req, res);
    if (authResult === "unauthenticated") return;
    if (!auth || !authResult) return sendJson(res, 503, { error: "auth not enabled" });
    const pageId = auditMatch[1];
    getExistingRole(auth.pool, pageId, authResult.userId)
      .then((role) => {
        if (role !== "owner") return sendJson(res, 403, { error: "only an owner can view the audit log" });
        return listAuditLog(auth!.pool, pageId).then((entries) => sendJson(res, 200, { pageId, entries }));
      })
      .catch((err) => handleRouteError(res, "audit_log_failed", err));
    return;
  }

  if (req.method === "GET" && url.startsWith("/mentions")) {
    // Unlike search (which degrades to "unscoped" without auth), "my
    // mentions" has no meaningful unauthenticated behavior — there's no
    // "me" to answer for — so this always requires auth, not just when
    // auth happens to be configured.
    if (!mentionsStore) return sendJson(res, 503, { error: "mentions require DATABASE_URL" });
    const authResult = requireAuthIfEnabled(req, res);
    if (authResult === "unauthenticated") return;
    if (!auth || !authResult) return sendJson(res, 503, { error: "mentions require JWT_SECRET (auth) to know who's asking" });
    mentionsStore
      .listMentionsForUser(authResult.userId)
      .then((mentions) => sendJson(res, 200, { mentions }))
      .catch((err) => handleRouteError(res, "mentions_failed", err));
    return;
  }

  if (req.method === "GET" && url.startsWith("/search")) {
    if (!pool) return sendJson(res, 503, { error: "search requires DATABASE_URL" });
    const authResult = requireAuthIfEnabled(req, res);
    if (authResult === "unauthenticated") return;
    const query = new URL(url, "http://internal").searchParams.get("q");
    if (!query) return sendJson(res, 400, { error: "missing ?q= query parameter" });
    searchPages(pool, query, authResult ? authResult.userId : null)
      .then((hits) => sendJson(res, 200, { query, hits }))
      .catch((err) => handleRouteError(res, "search_failed", err));
    return;
  }

  const previewMatch = url.match(PREVIEW_HTTP_PATH);
  if (previewMatch && req.method === "GET") {
    if (!pool) return sendJson(res, 503, { error: "previews require DATABASE_URL" });
    const pageId = previewMatch[1];
    const authResult = requireAuthIfEnabled(req, res);
    if (authResult === "unauthenticated") return;
    (authResult ? getExistingRole(pool, pageId, authResult.userId) : Promise.resolve<null>(null))
      .then((role) => {
        if (authResult && !role) return sendJson(res, 403, { error: "no access to this page" });
        return pool!
          .query<{ preview: string; updated_at: string }>(
            "SELECT preview, updated_at FROM page_previews WHERE page_id = $1",
            [pageId]
          )
          .then((result) => {
            const row = result.rows[0];
            if (!row) return sendJson(res, 404, { error: "no preview generated yet for this page" });
            sendJson(res, 200, { pageId, preview: row.preview, updatedAt: row.updated_at });
          });
      })
      .catch((err) => handleRouteError(res, "preview_failed", err));
    return;
  }

  const exportMatch = url.match(EXPORT_PATH);
  if (exportMatch && req.method === "POST") {
    if (!jobQueues) return sendJson(res, 503, { error: "exports require REDIS_URL and DATABASE_URL" });
    const pageId = exportMatch[1];
    const authResult = requireAuthIfEnabled(req, res);
    if (authResult === "unauthenticated") return;
    (authResult ? getExistingRole(pool!, pageId, authResult.userId) : Promise.resolve<null>(null))
      .then(async (role) => {
        if (authResult && !role) return sendJson(res, 403, { error: "no access to this page" });
        const jobId = await jobQueues!.enqueuePdfExport(pageId);
        if (auth && authResult) recordAudit(auth.pool, { userId: authResult.userId, pageId, event: "export_requested" });
        sendJson(res, 202, { pageId, jobId });
      })
      .catch((err) => handleRouteError(res, "export_failed", err));
    return;
  }

  const exportStatusMatch = url.match(EXPORT_STATUS_PATH);
  if (exportStatusMatch && req.method === "GET") {
    if (!jobQueues) return sendJson(res, 503, { error: "exports require REDIS_URL and DATABASE_URL" });
    const [, pageId, jobId] = exportStatusMatch;
    const authResult = requireAuthIfEnabled(req, res);
    if (authResult === "unauthenticated") return;
    jobQueues
      .getPdfExportJobStatus(jobId)
      .then(async (status) => {
        if (!status) return sendJson(res, 404, { error: "no such export job" });
        if (status.pageId !== pageId) return sendJson(res, 404, { error: "no such export job" });
        if (authResult && !(await getExistingRole(pool!, pageId, authResult.userId))) {
          return sendJson(res, 403, { error: "no access to this page" });
        }
        const { pageId: _pageId, ...response } = status;
        sendJson(res, 200, response);
      })
      .catch((err) => handleRouteError(res, "export_status_failed", err));
    return;
  }

  const exportDownloadMatch = url.match(EXPORT_DOWNLOAD_PATH);
  if (exportDownloadMatch && req.method === "GET") {
    if (!pool) return sendJson(res, 503, { error: "exports require DATABASE_URL" });
    const exportId = exportDownloadMatch[1];
    pool
      .query<{ page_id: string; format: string; data: string }>("SELECT page_id, format, data FROM exports WHERE id = $1", [
        exportId,
      ])
      .then(async (result) => {
        const row = result.rows[0];
        if (!row) return sendJson(res, 404, { error: "no such export" });
        const authResult = requireAuthIfEnabled(req, res);
        if (authResult === "unauthenticated") return;
        if (authResult) {
          const role = await getExistingRole(pool!, row.page_id, authResult.userId);
          if (!role) return sendJson(res, 403, { error: "no access to this page" });
        }
        res.writeHead(200, {
          "content-type": "application/pdf",
          "content-disposition": `attachment; filename="${row.page_id}.pdf"`,
        });
        res.end(Buffer.from(row.data, "base64"));
      })
      .catch((err) => handleRouteError(res, "export_download_failed", err));
    return;
  }

  if (!pageStore) {
    if (VERSIONS_PATH.test(url) || VERSION_AT_PATH.test(url) || VERSION_RESTORE_PATH.test(url)) {
      sendJson(res, 503, { error: "persistence disabled (no DATABASE_URL)" });
      return;
    }
  } else {
    const restoreMatch = url.match(VERSION_RESTORE_PATH);
    if (restoreMatch && req.method === "POST") {
      const [, pageId, seqStr] = restoreMatch;
      const authResult = requireAuthIfEnabled(req, res);
      if (authResult === "unauthenticated") return;
      // Restoring is a write, and it's HTTP-triggered — it never goes through
      // the WS message handler's viewer-write rejection (handleSyncMessage in
      // room.ts), since there's no socket/role-per-connection involved on this
      // path at all. This check is what stands in for that gate here; it must
      // be re-derived independently, not assumed.
      (authResult ? getExistingRole(auth!.pool, pageId, authResult.userId) : Promise.resolve<null>(null))
        .then(async (role) => {
          if (authResult && !roleAtLeast(role ?? "viewer", "editor")) {
            return sendJson(res, 403, { error: "editor or owner access required to restore a version" });
          }
          const seq = Number(seqStr);
          const snapshotDoc = await pageStore!.replayAt(pageId, seq);
          const snapshotBlocks = serializeDocument(snapshotDoc);

          // Runs against the live Room's actual doc (created if nobody's
          // currently connected) so the restore produces a real doc update —
          // persistence, broadcast to any connected clients, and search
          // reindexing all fire exactly as they would for a live edit.
          const room = await registry.getOrCreateRoom(pageId);
          room.doc.transact(() => restoreBlocksFromSnapshot(room.doc, snapshotBlocks));
          // If this request was the only reason the room existed (no one
          // currently connected), let it be cleaned up immediately rather
          // than sitting in memory indefinitely; a no-op while real clients
          // are still connected (connectionCount > 0).
          registry.releaseRoom(pageId);

          if (auth && authResult) {
            recordAudit(auth.pool, { userId: authResult.userId, pageId, event: "version_restored", metadata: { seq } });
          }
          sendJson(res, 200, { pageId, restoredSeq: seq, blocks: serializeDocument(room.doc) });
        })
        .catch((err) => handleRouteError(res, "version_restore_failed", err));
      return;
    }

    const versionsMatch = url.match(VERSIONS_PATH);
    if (versionsMatch) {
      const pageId = versionsMatch[1];
      const authResult = requireAuthIfEnabled(req, res);
      if (authResult === "unauthenticated") return;
      (authResult ? getExistingRole(auth!.pool, pageId, authResult.userId) : Promise.resolve<null>(null))
        .then((role) => {
          if (authResult && !role) return sendJson(res, 403, { error: "no access to this page" });
          return pageStore!.listVersionDetails(pageId).then((versions) => sendJson(res, 200, { pageId, versions }));
        })
        .catch((err) => handleRouteError(res, "versions_failed", err));
      return;
    }

    const versionAtMatch = url.match(VERSION_AT_PATH);
    if (versionAtMatch) {
      const [, pageId, seqStr] = versionAtMatch;
      const authResult = requireAuthIfEnabled(req, res);
      if (authResult === "unauthenticated") return;
      (authResult ? getExistingRole(auth!.pool, pageId, authResult.userId) : Promise.resolve<null>(null))
        .then((role) => {
          if (authResult && !role) return sendJson(res, 403, { error: "no access to this page" });
          return pageStore!
            .replayAt(pageId, Number(seqStr))
            .then((doc) => sendJson(res, 200, { pageId, seq: Number(seqStr), blocks: serializeDocumentWithDeltas(doc) }));
        })
        .catch((err) => handleRouteError(res, "version_at_failed", err));
      return;
    }
  }

  res.writeHead(404);
  res.end();
  }
});

attachWsGateway(httpServer, registry, auth ?? undefined, wsRateLimit, TRUST_PROXY, {
  allowedOrigins: ALLOWED_ORIGINS,
  maxPayloadBytes: Number(process.env.MAX_WS_PAYLOAD_BYTES ?? 1_048_576),
});

httpServer.listen(PORT, () => {
  logger.info({ event: "server_started", port: PORT }, `collab server listening on :${PORT}`);
});

// Previously this stopped workers/tracing and exited immediately, without
// ever closing the HTTP/WS server, Postgres pool, or any of the Redis
// connections (broadcaster pub/sub, rate limiter, BullMQ). On a rolling
// deploy (SIGTERM), that meant: open WebSocket clients got a raw TCP reset
// instead of a clean close (indistinguishable from a network failure), and
// any fire-and-forget write still in flight (e.g. Room's doc.on("update")
// persistence call) could be aborted mid-write by process.exit() racing it,
// silently dropping the most recent edit's durability.
async function shutdown(): Promise<void> {
  logger.info({ event: "server_shutting_down" }, "shutting down");
  await stopWorkers?.();
  await jobQueues?.close();
  await shutdownTracing();
  // Not awaited: existing WebSocket connections are long-lived by design, so
  // http.Server#close()'s callback (which waits for every open connection to
  // end on its own) would otherwise block shutdown indefinitely. This stops
  // the server from accepting *new* connections/requests immediately, which
  // is the part that matters for a clean rolling deploy; a full graceful
  // drain of existing WS clients would need iterating and closing each
  // Room's live sockets first, a larger change than this fixes.
  httpServer.close();
  await Promise.all(
    [pool?.end(), broadcasterPub?.quit(), broadcasterSub?.quit(), jobsConnection?.quit(), rateLimitRedis?.quit()].map((p) =>
      p?.catch((err) => logger.error({ event: "shutdown_resource_close_failed", err }, "failed to close a resource during shutdown"))
    )
  );
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// Defense in depth alongside the `.catch()` now on every route's promise
// chain above: Node's default behavior (15+) for an unhandled rejection is
// to crash the process, which would drop every WebSocket room on this
// instance over a single failed request's bug, not just that request.
process.on("unhandledRejection", (err) => {
  logger.error({ event: "unhandled_rejection", err }, "unhandled promise rejection — not crashing the process");
});
