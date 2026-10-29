import { afterEach, describe, expect, it, vi } from "vitest";
import { streamDocumentAssistant } from "./api.js";

/** A response body delivered in the given chunks, split wherever the test
 *  chooses (including mid-frame). */
function chunkedResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

afterEach(() => vi.unstubAllGlobals());

describe("document assistant stream", () => {
  it("reassembles frames split across chunks and dispatches deltas and plans", async () => {
    const plan = { summary: "Retitle", operations: [{ op: "set_title", text: "New" }] };
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          chunkedResponse([
            'event: delta\ndata: {"text":"Hel',
            'lo"}\n\nevent: plan\ndata: ',
            `${JSON.stringify({ plan, baseSeq: 7, model: "m" })}\n\nevent: done\ndata: {}\n\n`,
          ])
        )
    );
    const deltas: string[] = [];
    const plans: unknown[] = [];
    await streamDocumentAssistant("page-1", "hi", { onDelta: (text) => deltas.push(text), onPlan: (draft) => plans.push(draft) });
    expect(deltas).toEqual(["Hello"]);
    expect(plans).toEqual([{ plan, baseSeq: 7, model: "m" }]);
  });

  it("rejects with the server's message on an error event", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(chunkedResponse(['event: error\ndata: {"error":"quota exceeded"}\n\n'])));
    await expect(streamDocumentAssistant("page-1", "hi", { onDelta: () => {}, onPlan: () => {} })).rejects.toThrow("quota exceeded");
  });
});
