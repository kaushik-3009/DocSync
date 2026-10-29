import pino from "pino";

/** Properties some libraries attach to errors that are huge or sensitive when
 * serialized — `pg` hangs the whole client (connection params, type tables)
 * off pool errors. */
const OMITTED_ERROR_KEYS = new Set(["client", "connection", "config", "request", "response"]);

function serializeError(err: unknown) {
  const serialized = pino.stdSerializers.err(err as Error) as unknown as Record<string, unknown>;
  for (const key of OMITTED_ERROR_KEYS) delete serialized[key];
  return serialized;
}

/**
 * Structured JSON logging. Call sites attach contextual fields (pageId,
 * event, ...) instead of interpolating strings, so logs can be queried by
 * field in CloudWatch/Loki without parsing.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? (process.env.VITEST ? "silent" : "info"),
  base: { service: "collab-server" },
  timestamp: pino.stdTimeFunctions.isoTime,
  serializers: { err: serializeError },
});

export function childLogger(bindings: Record<string, unknown>) {
  return logger.child(bindings);
}
