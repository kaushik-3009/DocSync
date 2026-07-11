import { RateLimiterMemory, RateLimiterRedis, RateLimiterRes, type IRateLimiterOptions, type RateLimiterAbstract } from "rate-limiter-flexible";
import type Redis from "ioredis";

/**
 * Backed by Redis when available (so limits are shared across instances —
 * without this, a single abusive client round-robined across N instances by
 * the Phase 4 load balancer would effectively get N times the limit) and by
 * an in-process fallback otherwise. The in-memory fallback is a real,
 * documented limitation, not a silent gap: see ARCHITECTURE.md's Phase 7
 * section and the `instanceOnly` idea already established for presence
 * (Phase 3/4) and applied the same way here.
 */
function makeLimiter(redis: Redis | null, opts: Omit<IRateLimiterOptions, "storeClient">): RateLimiterAbstract {
  return redis
    ? new RateLimiterRedis({ storeClient: redis, ...opts })
    : new RateLimiterMemory(opts);
}

/** Brute-force protection on login: keyed by IP+email so one attacker can't lock out
 *  a victim's account by spamming failed logins under someone else's IP, and one IP
 *  can't brute-force many accounts by spreading attempts thin across emails. */
export function createLoginLimiter(redis: Redis | null): RateLimiterAbstract {
  return makeLimiter(redis, { keyPrefix: "rl:login", points: 5, duration: 60, blockDuration: 60 });
}

/** Registration attempts, keyed by IP. `/auth/register` necessarily returns a
 *  different status for an already-registered email than a new one (there's
 *  no way to create-or-silently-no-op without either handing out a token for
 *  someone else's account or breaking the "email already in use" UX every
 *  mainstream signup flow relies on) — this doesn't remove that oracle, but
 *  a much tighter budget than the general HTTP limiter keeps it too slow to
 *  use for bulk email enumeration. */
export function createRegisterLimiter(redis: Redis | null): RateLimiterAbstract {
  return makeLimiter(redis, { keyPrefix: "rl:register", points: 5, duration: 60, blockDuration: 300 });
}

/** General HTTP request limiting, keyed by IP (or userId when authenticated). */
export function createHttpLimiter(redis: Redis | null): RateLimiterAbstract {
  return makeLimiter(redis, { keyPrefix: "rl:http", points: 120, duration: 60 });
}

/** WebSocket connection-attempt flooding, keyed by IP, checked before the upgrade completes. */
export function createWsConnectLimiter(redis: Redis | null): RateLimiterAbstract {
  return makeLimiter(redis, { keyPrefix: "rl:ws-connect", points: 30, duration: 60 });
}

/** Per-connection message-flood protection. Deliberately always in-memory, never Redis:
 *  a flooding connection is by definition talking to exactly one instance, so there's
 *  nothing to coordinate across instances for — keyed by a random id assigned at
 *  connect time (see ws-gateway.ts), not by IP, so one abusive socket doesn't count
 *  against a shared-IP peer's legitimate connections (e.g. behind a corporate NAT). */
export function createWsMessageLimiter(): RateLimiterAbstract {
  return new RateLimiterMemory({ keyPrefix: "rl:ws-message", points: 100, duration: 1 });
}

/**
 * Consumes one point and reports whether the request is allowed — but only
 * ever says "blocked" for a genuine over-budget rejection (`consume()`
 * rejecting with a `RateLimiterRes`, rate-limiter-flexible's own signal for
 * "limit exceeded"). Any other rejection means the *store itself* failed —
 * for `RateLimiterRedis`, that's what a Redis outage/blip looks like — and
 * must not be treated the same way: every caller here used to funnel both
 * cases into the same `.catch()`, which meant a Redis hiccup turned into
 * every request from every client getting 429'd (HTTP routes) or every
 * WebSocket upgrade getting rejected (see ws-gateway.ts), i.e. Redis being
 * briefly unreachable took the whole app down harder than actually being
 * over the real limit would have. Failing open here (through `infraError`,
 * which callers log but don't reject on) trades "limits are unenforced for
 * the duration of the outage" for "the app stays up" — the right side of
 * that tradeoff for a rate limiter, which exists to shed abusive load, not
 * to be a second point of failure for legitimate traffic.
 */
export async function tryConsume(
  limiter: RateLimiterAbstract,
  key: string
): Promise<{ allowed: boolean; infraError?: unknown }> {
  try {
    await limiter.consume(key);
    return { allowed: true };
  } catch (err) {
    if (err instanceof RateLimiterRes) return { allowed: false };
    return { allowed: true, infraError: err };
  }
}
