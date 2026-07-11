import pino from "pino";

/**
 * Structured (JSON) logging from day one. Every call site attaches
 * contextual fields (pageId, clientId, event) instead of interpolating
 * strings, so Phase 7 can ship these straight into a log pipeline /
 * Prometheus exporter without a rewrite.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: "collab-server" },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export function childLogger(bindings: Record<string, unknown>) {
  return logger.child(bindings);
}
