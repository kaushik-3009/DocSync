import { z } from "zod/v4";
import { AiNotConfiguredError } from "../../ai/gemini.js";
import { answerFromWorkspace, buildSources, selectSources, streamAnswerFromWorkspace } from "../../ai/workspace-qa.js";
import { HttpError } from "../guards.js";
import { bearer, type RoutePlugin } from "./types.js";

const questionBody = z.object({ question: z.string().trim().min(3).max(1_000) });
const RETRIEVED_CHUNKS = 6;

export const workspaceRoutes: RoutePlugin = async (app, { deps, guards }) => {
  function semanticIndex() {
    if (!deps.semanticIndex) throw new HttpError(503, "semantic search requires Postgres with the pgvector extension");
    return deps.semanticIndex;
  }

  const gemini = () => ({ apiKey: deps.config.geminiApiKey, model: deps.config.geminiModel });

  // Meaning-based search across every page the caller can read.
  app.get(
    "/search/semantic",
    {
      schema: {
        tags: ["search"],
        security: bearer,
        querystring: z.object({ q: z.string().trim().min(1).max(500), limit: z.coerce.number().int().min(1).max(25).default(10) }),
      },
    },
    async (request) => {
      const user = guards.currentUser(request);
      const hits = await semanticIndex().search(request.query.q, user?.userId ?? null, request.query.limit);
      return { query: request.query.q, hits };
    }
  );

  // Retrieval-augmented answer with numbered citations back to pages.
  app.post("/workspace/ask", { schema: { tags: ["search"], security: bearer, body: questionBody } }, async (request) => {
    const user = guards.signedInUser(request);
    const hits = selectSources(await semanticIndex().search(request.body.question, user.userId, RETRIEVED_CHUNKS));
    try {
      return await answerFromWorkspace(gemini(), request.body.question, hits);
    } catch (err) {
      if (err instanceof AiNotConfiguredError) throw new HttpError(503, err.message);
      throw err;
    }
  });

  // Same as /workspace/ask, streamed as server-sent events:
  //   event: citations  data: Citation[]   (first, so links render immediately)
  //   event: delta      data: { text }     (repeated)
  //   event: done | error
  app.post("/workspace/ask/stream", { schema: { tags: ["search"], security: bearer, body: questionBody } }, async (request, reply) => {
    const user = guards.signedInUser(request);
    if (!deps.config.geminiApiKey) throw new HttpError(503, "AI assistant is not configured");
    const hits = selectSources(await semanticIndex().search(request.body.question, user.userId, RETRIEVED_CHUNKS));
    const { citations, prompt } = buildSources(hits);

    const abort = new AbortController();
    request.raw.on("close", () => abort.abort());
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      "x-request-id": request.id,
    });
    const send = (event: string, data: unknown) => reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send("citations", citations);
    try {
      for await (const text of streamAnswerFromWorkspace(gemini(), request.body.question, prompt, abort.signal)) send("delta", { text });
      send("done", {});
    } catch (err) {
      if (!abort.signal.aborted) {
        request.log.warn({ event: "workspace_answer_stream_failed", err }, "workspace answer stream failed");
        send("error", { error: err instanceof Error ? err.message : "the assistant could not answer" });
      }
    } finally {
      reply.raw.end();
    }
  });
};
