import { describe, expect, it, beforeEach } from "vitest";
import {
  metricsRegistry,
  httpRequestDuration,
  wsConnectionsActive,
  roomsActive,
  wsMessagesTotal,
  jobsCompletedTotal,
  jobsFailedTotal,
  authLoginAttemptsTotal,
  rateLimitRejectionsTotal,
} from "../src/metrics/registry.js";

beforeEach(() => {
  metricsRegistry.resetMetrics();
});

describe("metrics registry", () => {
  it("exposes every custom metric plus default process metrics in exposition format", async () => {
    const body = await metricsRegistry.metrics();
    for (const name of [
      "http_request_duration_seconds",
      "ws_connections_active",
      "rooms_active",
      "ws_messages_total",
      "jobs_completed_total",
      "jobs_failed_total",
      "auth_login_attempts_total",
      "rate_limit_rejections_total",
      "process_cpu_user_seconds_total", // a default metric, proving collectDefaultMetrics ran
    ]) {
      expect(body).toContain(name);
    }
  });

  it("records values that show up in the exposition output", async () => {
    httpRequestDuration.observe({ method: "GET", route: "/health", status: 200 }, 0.01);
    wsConnectionsActive.inc();
    wsConnectionsActive.inc();
    roomsActive.set(3);
    wsMessagesTotal.inc();
    jobsCompletedTotal.inc({ queue: "search-index" });
    jobsFailedTotal.inc({ queue: "pdf-export" });
    authLoginAttemptsTotal.inc({ outcome: "failure" });
    rateLimitRejectionsTotal.inc({ scope: "login" });

    const body = await metricsRegistry.metrics();
    expect(body).toContain('ws_connections_active 2');
    expect(body).toContain("rooms_active 3");
    expect(body).toContain('jobs_completed_total{queue="search-index"} 1');
    expect(body).toContain('jobs_failed_total{queue="pdf-export"} 1');
    expect(body).toContain('auth_login_attempts_total{outcome="failure"} 1');
    expect(body).toContain('rate_limit_rejections_total{scope="login"} 1');
  });
});
