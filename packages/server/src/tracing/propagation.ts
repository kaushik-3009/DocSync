import { propagation, context, type Context } from "@opentelemetry/api";

/**
 * Carries a trace across boundaries Node's async_hooks-based context
 * propagation doesn't reach on its own: a Redis pub/sub frame (Phase 4's
 * cross-instance fanout) or a BullMQ job payload (Phase 6's background job
 * pipeline). Both are just "serialize the active span as a W3C `traceparent`
 * string, hand it to whatever transport, extract it back into a Context on
 * the other side" — this module is that pair of functions, used by
 * redis/broadcaster.ts and jobs/queues.ts + jobs/workers.ts.
 */

/** The active span's `traceparent` header, or null if there's no active span
 *  (e.g. a doc update triggered directly in a test with no surrounding
 *  HTTP/WS span). */
export function currentTraceparent(): string | null {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier.traceparent ?? null;
}

/** Reconstructs a Context from a `traceparent` captured by
 *  currentTraceparent() on the sending side. Falls back to the current
 *  active context (effectively "no remote parent") if absent or malformed —
 *  callers never need to branch on whether a traceparent was actually sent. */
export function contextFromTraceparent(traceparent: string | null | undefined): Context {
  if (!traceparent) return context.active();
  return propagation.extract(context.active(), { traceparent });
}
