import * as Y from "yjs";
import { z } from "zod/v4";
import { recordAudit } from "../../auth/audit.js";
import {
  AiNotConfiguredError,
  GeminiFormatError,
  GeminiProviderError,
  chatGemini,
  planGemini,
  streamAssistantReply,
} from "../../ai/gemini.js";
import { loadFreshAssistantState } from "../../ai/context.js";
import { applyAgentPlan, parseAgentPlan } from "../../ai/agent.js";
import { HttpError } from "../guards.js";
import { openEventStream } from "../sse.js";
import { bearer, pageParams, type RoutePlugin } from "./types.js";

const promptBody = z.object({ prompt: z.string().trim().min(1).max(4_000) });
const applyBody = z.object({
  baseSeq: z.number().int().min(0),
  plan: z.object({ summary: z.string(), operations: z.array(z.unknown()).max(20) }),
});

/** Maps provider failures to statuses the client can explain. */
function assistantError(err: unknown): HttpError {
  if (err instanceof AiNotConfiguredError) return new HttpError(503, err.message);
  if (err instanceof GeminiProviderError) {
    return new HttpError(
      err.status === 429 ? 429 : 502,
      `Gemini provider error${err.status ? ` (HTTP ${err.status})` : ""}: ${err.message}`,
      {
        code: "assistant_request_failed",
      }
    );
  }
  if (err instanceof GeminiFormatError) {
    return new HttpError(502, `Gemini returned an unusable response: ${err.message}`, { code: "assistant_request_failed" });
  }
  return new HttpError(503, err instanceof Error ? err.message : "The assistant could not prepare a response", {
    code: "assistant_request_failed",
  });
}

export const assistantRoutes: RoutePlugin = async (app, { deps, guards }) => {
  const gemini = () => ({ apiKey: deps.config.geminiApiKey, model: deps.config.geminiModel });

  /** Title from the documents table plus a gateway-fresh view of the blocks. */
  async function documentContext(pageId: string) {
    const { rows } = await guards.pool().query<{ title: string }>("SELECT title FROM documents WHERE id = $1", [pageId]);
    if (!rows[0]) throw new HttpError(404, "document not found");
    const state = await loadFreshAssistantState(pageId, guards.pageStore(), deps.registry);
    return { ...state, title: state.title || rows[0].title };
  }

  app.post(
    "/pages/:pageId/assistant",
    { schema: { tags: ["assistant"], security: bearer, params: pageParams, body: promptBody } },
    async (request) => {
      const user = guards.signedInUser(request);
      const { pageId } = request.params;
      const role = (await guards.pageRole(request, pageId))!;
      const state = await documentContext(pageId);
      try {
        const response = await chatGemini(gemini(), { prompt: request.body.prompt, title: state.title, blocks: state.blocks, role });
        recordAudit(guards.pool(), {
          userId: user.userId,
          pageId,
          event: response.kind === "edit_plan" ? "assistant_edit_planned" : "assistant_prompted",
          metadata: { role, kind: response.kind },
        });
        return response.kind === "edit_plan"
          ? { ...response, baseSeq: state.baseSeq, model: deps.config.geminiModel }
          : { ...response, model: deps.config.geminiModel };
      } catch (err) {
        request.log.warn({ event: "assistant_request_failed", pageId, err }, "assistant request failed");
        throw assistantError(err);
      }
    }
  );

  // Streamed /assistant, as server-sent events:
  //   event: delta  data: { text }                     (repeated, for answers)
  //   event: plan   data: { plan, baseSeq, model }     (for edits; a proposal only)
  //   event: done | error
  app.post(
    "/pages/:pageId/assistant/stream",
    { schema: { tags: ["assistant"], security: bearer, params: pageParams, body: promptBody } },
    async (request, reply) => {
      const user = guards.signedInUser(request);
      const { pageId } = request.params;
      const role = (await guards.pageRole(request, pageId))!;
      if (!deps.config.geminiApiKey) throw new HttpError(503, "AI assistant is not configured");
      const state = await documentContext(pageId);
      const { signal, send, end } = openEventStream(request, reply);
      let kind: "answer" | "edit_plan" = "answer";
      try {
        const events = streamAssistantReply(
          gemini(),
          { prompt: request.body.prompt, title: state.title, blocks: state.blocks, role },
          signal
        );
        for await (const event of events) {
          if (event.type === "delta") send("delta", { text: event.text });
          else {
            kind = "edit_plan";
            send("plan", { plan: event.plan, baseSeq: state.baseSeq, model: deps.config.geminiModel });
          }
        }
        send("done", { model: deps.config.geminiModel });
        recordAudit(guards.pool(), {
          userId: user.userId,
          pageId,
          event: kind === "edit_plan" ? "assistant_edit_planned" : "assistant_prompted",
          metadata: { role, kind, streamed: true },
        });
      } catch (err) {
        if (!signal.aborted) {
          request.log.warn({ event: "assistant_stream_failed", pageId, err }, "assistant stream failed");
          send("error", { error: assistantError(err).message });
        }
      } finally {
        end();
      }
    }
  );

  app.post(
    "/pages/:pageId/assistant/plan",
    { schema: { tags: ["assistant"], security: bearer, params: pageParams, body: promptBody } },
    async (request) => {
      const user = guards.signedInUser(request);
      const { pageId } = request.params;
      const role = (await guards.pageRole(request, pageId, "editor", "editor or owner access required for AI edits"))!;
      const state = await documentContext(pageId);
      try {
        const plan = await planGemini(gemini(), { prompt: request.body.prompt, title: state.title, blocks: state.blocks, role });
        recordAudit(guards.pool(), {
          userId: user.userId,
          pageId,
          event: "assistant_edit_planned",
          metadata: { role, operationCount: plan.operations.length, baseSeq: state.baseSeq },
        });
        return { plan, baseSeq: state.baseSeq, model: deps.config.geminiModel };
      } catch (err) {
        throw assistantError(err);
      }
    }
  );

  // Applies a reviewed plan only if the document hasn't moved since it was
  // generated; the edit commits through the room's admission queue.
  app.post(
    "/pages/:pageId/assistant/apply",
    { schema: { tags: ["assistant"], security: bearer, params: pageParams, body: applyBody } },
    async (request) => {
      const user = guards.signedInUser(request);
      const { pageId } = request.params;
      const role = await guards.pageRole(request, pageId, "editor", "editor or owner access required for AI edits");
      const { baseSeq } = request.body;
      const plan = parseAgentPlan(JSON.stringify(request.body.plan));
      const currentSeq = await guards.pageStore().currentSeq(pageId);
      if (currentSeq !== baseSeq)
        throw new HttpError(409, "document changed while Gemini was preparing this edit; generate a new plan", { currentSeq });
      const room = await deps.registry.getOrCreateRoom(pageId);
      const detached = new Y.Doc();
      try {
        if (room.persistedSeq !== baseSeq)
          throw new HttpError(409, "gateway is catching up; generate a new plan", { currentSeq: room.persistedSeq });
        let update: Uint8Array | null = null;
        Y.applyUpdate(detached, Y.encodeStateAsUpdate(room.doc));
        detached.on("update", (next: Uint8Array) => {
          update = next;
        });
        try {
          applyAgentPlan(detached, plan);
        } catch (err) {
          if (err instanceof Error && /block .* does not exist/.test(err.message)) {
            throw new HttpError(409, "The proposed edit targeted an outdated block. Ask Gemini again to refresh the document.");
          }
          throw err;
        }
        if (update) await room.applyServerUpdate(update);
      } finally {
        detached.destroy();
        deps.registry.releaseRoom(pageId);
      }
      recordAudit(guards.pool(), {
        userId: user.userId,
        pageId,
        event: "assistant_edit_applied",
        metadata: { role, operationCount: plan.operations.length, baseSeq },
      });
      return { pageId, applied: plan.operations.length, summary: plan.summary };
    }
  );
};
