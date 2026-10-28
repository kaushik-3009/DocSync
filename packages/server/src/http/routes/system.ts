import { metricsRegistry } from "../../metrics/registry.js";
import type { RoutePlugin } from "./types.js";

export const systemRoutes: RoutePlugin = async (app, { deps }) => {
  // `authRequired` lets the client decide on load whether to show the login
  // screen or a guest identity.
  app.get("/health", { schema: { tags: ["system"], summary: "Liveness" } }, async () => ({
    status: "ok",
    rooms: deps.registry.activeRoomCount,
    authRequired: Boolean(deps.jwtSecret),
  }));

  // Checks the dependencies that make a secure gateway usable, not merely an
  // open port. Unauthenticated for the load balancer; exposes no secrets.
  app.get("/ready", { schema: { tags: ["system"], summary: "Readiness" } }, async (_request, reply) => {
    const [postgres, redis] = await Promise.all([
      deps.pool
        ? deps.pool.query("SELECT 1").then(
            () => true,
            () => false
          )
        : Promise.resolve(false),
      deps.pingRedis ? deps.pingRedis().catch(() => false) : Promise.resolve(false),
    ]);
    const ready = postgres && redis && Boolean(deps.pageStore) && Boolean(deps.jwtSecret);
    return reply.code(ready ? 200 : 503).send({
      status: ready ? "ready" : "not_ready",
      gatewayId: deps.gatewayId,
      postgres,
      redis,
      migrationsComplete: Boolean(deps.pageStore),
      authEnabled: Boolean(deps.jwtSecret),
      workersEnabled: Boolean(deps.jobQueues),
    });
  });

  app.get("/metrics", { schema: { hide: true } }, async (_request, reply) => {
    reply.header("content-type", metricsRegistry.contentType);
    return metricsRegistry.metrics();
  });
};
