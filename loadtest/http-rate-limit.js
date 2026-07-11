import http from "k6/http";
import { check, sleep } from "k6";
import { Counter } from "k6/metrics";

/**
 * Proves Phase 7's general HTTP rate limiter (120 req/60s per IP) actually
 * engages under load, rather than just trusting the unit test's in-memory
 * check. All k6 VUs share one machine's IP, which is exactly the scenario
 * the rate limiter is designed to catch — this script deliberately exceeds
 * the budget and reports the 200-vs-429 split.
 *
 * Usage: BASE_URL=http://localhost:1234 k6 run loadtest/http-rate-limit.js
 */

const BASE_URL = __ENV.BASE_URL || "http://localhost:1234";
const okCount = new Counter("responses_200");
const limitedCount = new Counter("responses_429");

export const options = {
  scenarios: {
    burst: { executor: "constant-vus", vus: 20, duration: "30s" },
  },
};

export default function () {
  const res = http.get(`${BASE_URL}/pages/loadtest-rl-page/presence`);
  if (res.status === 200) okCount.add(1);
  if (res.status === 429) limitedCount.add(1);
  check(res, { "200 or 429": (r) => r.status === 200 || r.status === 429 });
  sleep(0.05);
}
