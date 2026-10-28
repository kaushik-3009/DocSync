import { Pool } from "pg";
import Redis from "ioredis";
import { shutdownTracing } from "./tracing/tracer.js";
import { RoomRegistry } from "./room-registry.js";
import { attachWsGateway, type WsAuthConfig, type WsRateLimitConfig } from "./ws-gateway.js";
import { logger } from "./logger.js";
import { runMigrations } from "./persistence/db.js";
import { PageStore } from "./persistence/page-store.js";
import { FanoutOutbox } from "./persistence/fanout-outbox.js";
import { RedisRoomBroadcaster, type RoomBroadcaster } from "./redis/broadcaster.js";
import { getExistingRoles } from "./auth/rbac.js";
import { JobQueues } from "./jobs/queues.js";
import { startWorkers } from "./jobs/workers.js";
import { MentionsStore } from "./comments/mentions-store.js";
import { createExportStorage, type ExportStorage } from "./exports/storage.js";
import {
  createLoginLimiter,
  createRegisterLimiter,
  createHttpLimiter,
  createWsConnectLimiter,
  createWsMessageLimiter,
} from "./rate-limit/limiters.js";
import { loadRuntimeConfig } from "./runtime-config.js";
import { NotificationGateway } from "./notifications/gateway.js";
import { buildApp } from "./http/app.js";
import { AuthorshipStore } from "./authorship/store.js";

/**
 * Process bootstrap: connects to the configured services, builds the HTTP
 * app, attaches the WebSocket gateways to the same server, and drains
 * cleanly on SIGTERM. Every service is optional so a local demo can run
 * without them; deployed environments enforce their presence via /ready.
 */

const config = loadRuntimeConfig(process.env);
const GATEWAY_ID = process.env.GATEWAY_ID?.trim() || `gateway-${process.pid}`;
const SHUTDOWN_DRAIN_TIMEOUT_MS = Number(process.env.SHUTDOWN_DRAIN_TIMEOUT_MS ?? 5_000);

let pool: Pool | null = null;
let pageStore: PageStore | null = null;
let exportStorage: ExportStorage | null = null;
if (config.databaseUrl) {
  pool = new Pool({ connectionString: config.databaseUrl, max: Number(process.env.PG_POOL_MAX ?? 10) });
  // pg emits failures of idle clients on the pool; without a listener Node
  // treats them as uncaught and a transient DB blip would kill every room.
  pool.on("error", (err) => logger.error({ event: "postgres_pool_error", err }, "Postgres pool client error; retaining gateway process"));
  await runMigrations(pool);
  pageStore = new PageStore(pool);
  exportStorage = await createExportStorage(pool);
  logger.info({ event: "persistence_enabled" }, "connected to Postgres, persistence enabled");
} else {
  logger.warn({ event: "persistence_disabled" }, "DATABASE_URL not set — running in-memory only, documents will not survive a restart");
}

let broadcaster: RoomBroadcaster | null = null;
let fanoutOutbox: FanoutOutbox | null = null;
let broadcasterPub: Redis | null = null;
let broadcasterSub: Redis | null = null;
if (config.redisUrl) {
  // A subscribed ioredis connection can only (un)subscribe, so publishing
  // needs its own connection.
  broadcasterPub = new Redis(config.redisUrl);
  broadcasterSub = new Redis(config.redisUrl);
  const redisBroadcaster = new RedisRoomBroadcaster(broadcasterPub, broadcasterSub);
  broadcaster = redisBroadcaster;
  if (pool) {
    fanoutOutbox = new FanoutOutbox(pool, redisBroadcaster);
    fanoutOutbox.start();
  }
  logger.info({ event: "fanout_enabled", outbox: Boolean(fanoutOutbox) }, "connected to Redis, cross-instance fanout enabled");
} else {
  logger.warn({ event: "fanout_disabled" }, "REDIS_URL not set — running single-instance only");
}

// Background jobs need both Redis (BullMQ) and Postgres (job inputs/outputs).
let jobQueues: JobQueues | null = null;
let stopWorkers: (() => Promise<void>) | null = null;
let jobsConnection: Redis | null = null;
if (config.redisUrl && pool && pageStore && exportStorage) {
  // BullMQ's blocking commands require maxRetriesPerRequest: null.
  jobsConnection = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
  jobQueues = new JobQueues(jobsConnection);
  if (process.env.RUN_WORKERS !== "false") {
    stopWorkers = startWorkers(jobsConnection, pool, pageStore, exportStorage).close;
  }
  logger.info({ event: "jobs_enabled", inProcessWorkers: Boolean(stopWorkers) }, "background job queues enabled");
} else {
  logger.warn({ event: "jobs_disabled" }, "REDIS_URL and/or DATABASE_URL not set — search, previews and exports are disabled");
}

const mentionsStore = pool ? new MentionsStore(pool) : null;
const authorship = pool ? new AuthorshipStore(pool) : null;

// Auth is required for normal startup; runtime-config only allows skipping it
// under the explicit development bypass.
const auth: WsAuthConfig | null = config.insecureLocalAuthBypass ? null : { jwtSecret: config.jwtSecret!, pool: pool! };
if (!auth) logger.warn({ event: "insecure_local_auth_bypass" }, "running unauthenticated (development-only local bypass)");

// With Redis the limits are shared by every gateway; without it each
// process enforces its own.
const rateLimitRedis = config.redisUrl ? new Redis(config.redisUrl) : null;
const wsRateLimit: WsRateLimitConfig = { connect: createWsConnectLimiter(rateLimitRedis), message: createWsMessageLimiter() };

const registry = new RoomRegistry({
  pageStore,
  broadcaster,
  jobQueues,
  mentionsStore,
  fanoutOutbox,
  mutationAuthorizer: pool ? (pageId, userIds) => getExistingRoles(pool!, pageId, userIds) : null,
  authorship,
});

let notificationGateway: NotificationGateway | null = null;
let notificationSub: Redis | null = null;

const app = await buildApp({
  config,
  gatewayId: GATEWAY_ID,
  pool,
  pageStore,
  registry,
  jobQueues,
  mentionsStore,
  exportStorage,
  authorship,
  jwtSecret: auth?.jwtSecret ?? null,
  limiters: {
    http: createHttpLimiter(rateLimitRedis),
    login: createLoginLimiter(rateLimitRedis),
    register: createRegisterLimiter(rateLimitRedis),
  },
  pingRedis: broadcasterPub ? () => broadcasterPub!.ping().then(() => true) : null,
  notifyUser: async (userId) => notificationGateway?.publish(userId),
  maxBodyBytes: Number(process.env.MAX_HTTP_BODY_BYTES ?? 65_536),
});

if (auth && broadcasterPub && config.redisUrl) {
  notificationSub = new Redis(config.redisUrl);
  notificationGateway = new NotificationGateway(broadcasterPub, notificationSub, auth.jwtSecret, config.allowedOrigins);
  await notificationGateway.attach(app.server);
}
attachWsGateway(app.server, registry, auth ?? undefined, wsRateLimit, config.trustProxy, {
  allowedOrigins: config.allowedOrigins,
  maxPayloadBytes: Number(process.env.MAX_WS_PAYLOAD_BYTES ?? 1_048_576),
});

await app.listen({ port: config.port, host: "0.0.0.0" });
logger.info({ event: "server_started", port: config.port, gatewayId: GATEWAY_ID }, `collab server listening on :${config.port}`);

/**
 * Rolling-deploy shutdown: stop accepting work, close sockets with 1012 so
 * clients reconnect elsewhere, wait (bounded) for admitted edits to commit
 * and for the outbox to publish, then release every connection.
 */
let shutdownStarted = false;
async function shutdown(): Promise<void> {
  if (shutdownStarted) return;
  shutdownStarted = true;
  logger.info({ event: "server_shutting_down" }, "shutting down");
  const httpClosed = app.close();
  registry.beginShutdown();
  const roomDrainCompleted = await Promise.race([
    registry.drainAllMutations().then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), SHUTDOWN_DRAIN_TIMEOUT_MS)),
  ]);
  logger.info({ event: "room_shutdown_drain", completed: roomDrainCompleted }, "room update drain finished");
  const outboxDrained = await fanoutOutbox?.close();
  if (outboxDrained !== undefined)
    logger.info({ event: "outbox_shutdown_drain", completed: outboxDrained }, "fanout outbox drain finished");
  registry.destroyAll();
  await stopWorkers?.();
  await jobQueues?.close();
  await notificationGateway?.close();
  await shutdownTracing();
  await Promise.all(
    [
      httpClosed,
      pool?.end(),
      broadcasterPub?.quit(),
      broadcasterSub?.quit(),
      notificationSub?.quit(),
      jobsConnection?.quit(),
      rateLimitRedis?.quit(),
    ].map((p) =>
      p?.catch((err) => logger.error({ event: "shutdown_resource_close_failed", err }, "failed to close a resource during shutdown"))
    )
  );
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// Defense in depth: one request's bug must not take down every room on this
// gateway via Node's default crash-on-unhandled-rejection.
process.on("unhandledRejection", (err) => {
  logger.error({ event: "unhandled_rejection", err }, "unhandled promise rejection — not crashing the process");
});
