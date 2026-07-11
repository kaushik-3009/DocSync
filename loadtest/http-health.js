import http from "k6/http";
import { check, sleep } from "k6";
import { Trend } from "k6/metrics";

/**
 * Raw HTTP capacity test: hammers only `/health`, which is deliberately
 * exempt from Phase 7's rate limiter (see index.ts's routeLabelFor /
 * rate-limit skip list) — this measures the server's own request-handling
 * throughput/latency, not the rate limiter's cutoff (that's http-rate-limit.js).
 *
 * Usage: BASE_URL=http://localhost:1234 k6 run loadtest/http-health.js
 */

const BASE_URL = __ENV.BASE_URL || "http://localhost:1234";
const healthLatency = new Trend("health_latency_ms", true);

export const options = {
  scenarios: {
    steady_load: { executor: "constant-vus", vus: 50, duration: "20s" },
  },
  thresholds: {
    health_latency_ms: ["p(95)<50"],
    http_req_failed: ["rate<0.01"],
  },
};

export default function () {
  const res = http.get(`${BASE_URL}/health`);
  healthLatency.add(res.timings.duration);
  check(res, { "200 OK": (r) => r.status === 200 });
  sleep(0.05);
}
