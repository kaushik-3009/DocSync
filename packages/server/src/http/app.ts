import { randomUUID } from "node:crypto";
import Fastify, { LogController, type FastifyBaseLogger, type FastifyError, type FastifyInstance, type RawServerDefault } from "fastify";
import type { IncomingMessage, ServerResponse } from "node:http";
import cors from "@fastify/cors";
import swagger from "@fastify/swagger";
import { jsonSchemaTransform, serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import { context, trace } from "@opentelemetry/api";
import { logger } from "../logger.js";
import { tracer } from "../tracing/tracer.js";
import { httpRequestDuration, rateLimitRejectionsTotal } from "../metrics/registry.js";
import { tryConsume } from "../rate-limit/limiters.js";
import type { AppDeps } from "./deps.js";
import { createGuards, HttpError } from "./guards.js";
import { systemRoutes } from "./routes/system.js";
import { authRoutes } from "./routes/auth.js";
import { documentRoutes } from "./routes/documents.js";
import { sharingRoutes } from "./routes/sharing.js";
import { historyRoutes } from "./routes/history.js";
import { exportRoutes } from "./routes/exports.js";
import { assistantRoutes } from "./routes/assistant.js";
import { authorshipRoutes } from "./routes/authorship.js";

export type App = FastifyInstance<RawServerDefault, IncomingMessage, ServerResponse, FastifyBaseLogger, ZodTypeProvider>;

/** Routes exempt from the shared HTTP rate limit: probes and scrapes. */
const UNLIMITED_ROUTES = new Set(["/health", "/ready", "/metrics"]);

/**
 * Builds the HTTP API. Pure construction — no listening, no process hooks —
 * so tests drive it with `app.inject()` and the bootstrap in index.ts attaches
 * the WebSocket gateways to `app.server`.
 */
export async function buildApp(deps: AppDeps): Promise<App> {
  const app = Fastify({
    loggerInstance: logger.child({ module: "http" }) as FastifyBaseLogger,
    // Request/response lines are replaced by the metrics and spans below.
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: deps.maxBodyBytes,
    trustProxy: deps.config.trustProxy,
    requestIdHeader: false,
    genReqId: (request) => {
      const supplied = request.headers["x-request-id"];
      return typeof supplied === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(supplied) ? supplied : randomUUID();
    },
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(swagger, {
    openapi: {
      info: { title: "DocSync API", version: "1.0.0", description: "HTTP API for the DocSync collaborative editor." },
      components: { securitySchemes: { bearer: { type: "http", scheme: "bearer", bearerFormat: "JWT" } } },
    },
    transform: jsonSchemaTransform,
  });

  // Bearer tokens, not cookies, carry auth, so CORS only needs an explicit
  // origin allowlist — no credentials mode.
  await app.register(cors, {
    origin: (origin, callback) => callback(null, !origin || deps.config.allowedOrigins.includes(origin) ? (origin ?? false) : false),
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Request-ID"],
    exposedHeaders: ["X-Request-ID"],
  });

  // One span and one histogram sample per request. The span is made active
  // for the rest of the request lifecycle so DB and job spans nest under it.
  app.addHook("onRequest", (request, reply, done) => {
    reply.header("X-Request-ID", request.id);
    const span = tracer.startSpan("http.request", {
      attributes: { "http.method": request.method, "http.route": request.routeOptions.url ?? "unmatched", "request.id": request.id },
    });
    (request as { startedAt?: bigint }).startedAt = process.hrtime.bigint();
    (request as { span?: typeof span }).span = span;
    context.with(trace.setSpan(context.active(), span), done);
  });

  app.addHook("onResponse", (request, reply, done) => {
    const route = request.routeOptions.url ?? "unmatched";
    const startedAt = (request as { startedAt?: bigint }).startedAt ?? process.hrtime.bigint();
    httpRequestDuration.observe(
      { method: request.method, route, status: reply.statusCode },
      Number(process.hrtime.bigint() - startedAt) / 1e9
    );
    const span = (request as { span?: ReturnType<typeof tracer.startSpan> }).span;
    span?.setAttribute("http.status_code", reply.statusCode);
    span?.end();
    done();
  });

  app.addHook("onRequest", async (request, reply) => {
    if (request.method === "OPTIONS" || UNLIMITED_ROUTES.has(request.routeOptions.url ?? "")) return;
    const { allowed, infraError } = await tryConsume(deps.limiters.http, request.ip);
    if (infraError)
      request.log.error(
        { event: "rate_limiter_store_error", scope: "http", err: infraError },
        "rate limiter store unavailable — failing open"
      );
    if (!allowed) {
      rateLimitRejectionsTotal.inc({ scope: "http" });
      return reply.code(429).header("retry-after", "60").send({ error: "rate limit exceeded" });
    }
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof HttpError) return reply.code(error.statusCode).send({ error: error.message, ...error.body });
    if (error.validation) {
      return reply.code(400).send({ error: "invalid request", details: error.message });
    }
    const statusCode = error.statusCode;
    if (statusCode && statusCode >= 400 && statusCode < 500) return reply.code(statusCode).send({ error: error.message });
    request.log.error({ event: "request_failed", route: request.routeOptions.url, err: error }, "request handler failed");
    return reply.code(500).send({ error: "internal server error" });
  });

  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: "not found" }));

  const guards = createGuards(deps);
  const routeDeps = { deps, guards };
  await app.register(systemRoutes, routeDeps);
  await app.register(authRoutes, routeDeps);
  await app.register(documentRoutes, routeDeps);
  await app.register(sharingRoutes, routeDeps);
  await app.register(historyRoutes, routeDeps);
  await app.register(exportRoutes, routeDeps);
  await app.register(assistantRoutes, routeDeps);
  await app.register(authorshipRoutes, routeDeps);

  app.get("/openapi.json", { schema: { hide: true } }, async () => app.swagger());
  return app;
}
