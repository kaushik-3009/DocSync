import type { OutgoingHttpHeaders } from "node:http";
import type { FastifyReply, FastifyRequest } from "fastify";

export interface EventStream {
  signal: AbortSignal;
  send(event: string, data: unknown): void;
  end(): void;
}

/**
 * Takes over the response as a server-sent event stream. `signal` aborts when
 * the client disconnects, so upstream provider requests are cancelled too.
 * Buffering is disabled for nginx (`x-accel-buffering`) so deltas arrive as
 * they are written.
 *
 * A hijacked reply bypasses Fastify's serialisation, including headers that
 * hooks already set on it (CORS among them), so those are carried over by hand.
 * Without them every browser on another origin rejects the stream.
 */
export function openEventStream(request: FastifyRequest, reply: FastifyReply): EventStream {
  const abort = new AbortController();
  request.raw.on("close", () => abort.abort());
  reply.hijack();
  reply.raw.writeHead(200, {
    ...(reply.getHeaders() as OutgoingHttpHeaders),
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
    "x-request-id": request.id,
  });
  return {
    signal: abort.signal,
    send(event, data) {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    end() {
      reply.raw.end();
    },
  };
}
