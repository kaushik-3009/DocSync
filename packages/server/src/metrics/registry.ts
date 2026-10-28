import { Registry, collectDefaultMetrics, Counter, Gauge, Histogram } from "prom-client";

/**
 * A single process-wide metrics registry, imported directly wherever a
 * counter needs incrementing (`room.ts`, `ws-gateway.ts`, `index.ts`) —
 * same "always-on singleton" convention as `logger.ts`, not threaded through
 * constructors like `PageStore`/`RoomBroadcaster`/etc. Those are genuinely
 * optional features; metrics collection isn't something a deployment
 * chooses to disable, it's baseline observability, so it doesn't need the
 * same "optional collaborator" ceremony.
 *
 * This is exactly the seam Phase 1's ARCHITECTURE.md called out in
 * advance: structured log events (`room_created`, `connection_added`, …)
 * already existed with consistent field names; these metrics mirror the
 * same events as counters/gauges instead of requiring new instrumentation.
 */
export const metricsRegistry = new Registry();
collectDefaultMetrics({ register: metricsRegistry });

export const httpRequestDuration = new Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route", "status"],
  registers: [metricsRegistry],
});

export const wsConnectionsActive = new Gauge({
  name: "ws_connections_active",
  help: "Currently open WebSocket connections on this instance",
  registers: [metricsRegistry],
});

/** Monotonic evidence that a gateway accepted WebSocket connections. Unlike
 * the active-connection gauge, this remains useful after a benchmark closes
 * its clients and lets the harness prove both replicas participated. */
export const wsConnectionsTotal = new Counter({
  name: "ws_connections_total",
  help: "WebSocket connections accepted by this gateway process",
  registers: [metricsRegistry],
});

export const roomsActive = new Gauge({
  name: "rooms_active",
  help: "Currently open Room instances (pages with at least one local connection) on this instance",
  registers: [metricsRegistry],
});

export const wsMessagesTotal = new Counter({
  name: "ws_messages_total",
  help: "WebSocket messages received across all rooms on this instance",
  registers: [metricsRegistry],
});

/** Mutation lifecycle counts deliberately have no page/user label: either
 * value would make a public metrics endpoint a high-cardinality data leak. */
export const collabUpdatesTotal = new Counter({
  name: "collab_updates_total",
  help: "Collaboration updates by admission/durability outcome on this instance",
  labelNames: ["outcome"], // accepted | durable | failed | in_memory_applied
  registers: [metricsRegistry],
});

export const collabUpdatesPending = new Gauge({
  name: "collab_updates_pending",
  help: "Updates admitted to this instance and waiting for their durable outcome",
  registers: [metricsRegistry],
});

export const collabUpdateDurabilitySeconds = new Histogram({
  name: "collab_update_durability_seconds",
  help: "Elapsed time from gateway admission to append outcome, by outcome",
  labelNames: ["outcome"], // committed | failed | in_memory
  registers: [metricsRegistry],
});

export const collabCommitBatchSize = new Histogram({
  name: "collab_commit_batch_size",
  help: "Updates committed per group-commit transaction",
  buckets: [1, 2, 4, 8, 16, 32, 64, 128, 256],
  registers: [metricsRegistry],
});

export const collabFanoutOutboxTotal = new Counter({
  name: "collab_fanout_outbox_total",
  help: "Transactional fanout outbox rows by delivery outcome",
  labelNames: ["outcome"], // claimed | delivered | failed
  registers: [metricsRegistry],
});

export const collabFanoutOutboxPending = new Gauge({
  name: "collab_fanout_outbox_pending",
  help: "Committed updates awaiting a confirmed Redis publish",
  registers: [metricsRegistry],
});

export const jobsCompletedTotal = new Counter({
  name: "jobs_completed_total",
  help: "Background jobs completed, by queue",
  labelNames: ["queue"],
  registers: [metricsRegistry],
});

export const jobsFailedTotal = new Counter({
  name: "jobs_failed_total",
  help: "Background jobs failed, by queue",
  labelNames: ["queue"],
  registers: [metricsRegistry],
});

export const authLoginAttemptsTotal = new Counter({
  name: "auth_login_attempts_total",
  help: "Login attempts, by outcome",
  labelNames: ["outcome"], // "success" | "failure"
  registers: [metricsRegistry],
});

export const rateLimitRejectionsTotal = new Counter({
  name: "rate_limit_rejections_total",
  help: "Requests/connections/messages rejected for exceeding a rate limit, by scope",
  labelNames: ["scope"], // "http" | "ws_connect" | "ws_message" | "login" | "register"
  registers: [metricsRegistry],
});
