import { describe, expect, it } from "vitest";
import { createLoginLimiter, createHttpLimiter, createWsMessageLimiter } from "../src/rate-limit/limiters.js";

/**
 * All against RateLimiterMemory (no Redis) — the in-memory fallback path
 * every one of these factories takes when passed `null`, same code path
 * used automatically when REDIS_URL isn't set. RateLimiterRedis itself is
 * a thin wrapper the `rate-limiter-flexible` library already tests; what's
 * worth verifying here is that *our* factory configuration (points,
 * duration, keying) behaves as intended.
 */
describe("rate limiters", () => {
  it("http limiter allows up to its point budget then rejects", async () => {
    const limiter = createHttpLimiter(null);
    const key = "1.2.3.4";
    for (let i = 0; i < 120; i++) {
      await limiter.consume(key);
    }
    await expect(limiter.consume(key)).rejects.toBeTruthy();
  });

  it("http limiter tracks separate keys independently", async () => {
    const limiter = createHttpLimiter(null);
    for (let i = 0; i < 120; i++) await limiter.consume("client-a");
    await expect(limiter.consume("client-a")).rejects.toBeTruthy();
    // a different key (different client IP) is unaffected
    await expect(limiter.consume("client-b")).resolves.toBeTruthy();
  });

  it("login limiter is stricter than the general http limiter", async () => {
    const limiter = createLoginLimiter(null);
    const key = "1.2.3.4:someone@example.com";
    for (let i = 0; i < 5; i++) {
      await limiter.consume(key);
    }
    await expect(limiter.consume(key)).rejects.toBeTruthy();
  });

  it("ws message limiter caps per-connection message bursts", async () => {
    const limiter = createWsMessageLimiter();
    const connectionKey = "conn-1";
    for (let i = 0; i < 100; i++) {
      await limiter.consume(connectionKey);
    }
    await expect(limiter.consume(connectionKey)).rejects.toBeTruthy();
    // a different connection's budget is untouched
    await expect(limiter.consume("conn-2")).resolves.toBeTruthy();
  });
});
