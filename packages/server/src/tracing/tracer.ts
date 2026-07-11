import { trace, context, propagation, type Tracer } from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { AsyncHooksContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  SimpleSpanProcessor,
  InMemorySpanExporter,
  type SpanExporter,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { childLogger } from "../logger.js";

const log = childLogger({ module: "tracing" });

const OTLP_ENDPOINT = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

/**
 * Spans are always created (cheap, in-process objects) rather than following
 * the "optional collaborator, null when absent" pattern most other features
 * in this codebase use — same "observability is always on" reasoning Phase 7
 * used for Prometheus metrics. What varies with OTEL_EXPORTER_OTLP_ENDPOINT
 * is only where finished spans go: a real collector (see docker-compose.yml's
 * `jaeger` service) when it's set, or nowhere when it's not — so every
 * instrumentation call site below never needs a null check either way.
 */
class NoopExporter implements SpanExporter {
  export(_spans: unknown, resultCallback: (result: { code: number }) => void): void {
    resultCallback({ code: 0 });
  }
  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

const exporter: SpanExporter = OTLP_ENDPOINT
  ? new OTLPTraceExporter({ url: `${OTLP_ENDPOINT.replace(/\/+$/, "")}/v1/traces` })
  : new NoopExporter();

const spanProcessors: SpanProcessor[] = [new BatchSpanProcessor(exporter)];

/** Only populated under `vitest` (which sets process.env.VITEST) — an
 *  unbounded in-memory span buffer would be a real leak in a long-running
 *  server process, so this processor is never added outside tests. Lets
 *  test/tracing.test.ts assert on real parent/child span relationships
 *  (trace id + parent span id) instead of just "no exception was thrown". */
export const testSpanExporter = new InMemorySpanExporter();
if (process.env.VITEST) {
  spanProcessors.push(new SimpleSpanProcessor(testSpanExporter));
}

const provider = new BasicTracerProvider({
  resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: "collab-server" }),
  spanProcessors,
});

trace.setGlobalTracerProvider(provider);
propagation.setGlobalPropagator(new W3CTraceContextPropagator());

// Without an async-aware context manager, the default is a no-op stack that
// doesn't survive a Promise .then()/.catch() continuation — which is exactly
// how every persistence write and job enqueue in this codebase runs (see
// Room's fire-and-forget doc.on("update") handler). AsyncHooksContextManager
// is what lets a child span opened inside a `.then()` still show up nested
// under whatever span was active when that promise chain was kicked off.
const contextManager = new AsyncHooksContextManager();
contextManager.enable();
context.setGlobalContextManager(contextManager);

export const tracer: Tracer = trace.getTracer("collab-server");

export async function shutdownTracing(): Promise<void> {
  await provider.shutdown();
}

log.info(
  { event: "tracing_configured", exporter: OTLP_ENDPOINT ? "otlp" : "none" },
  OTLP_ENDPOINT
    ? `tracing spans will be exported to ${OTLP_ENDPOINT}`
    : "OTEL_EXPORTER_OTLP_ENDPOINT not set — spans are created but not exported anywhere"
);
