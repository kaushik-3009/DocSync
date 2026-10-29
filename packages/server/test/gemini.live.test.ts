import type { SerializedBlock } from "@docsync/shared";
import { describe, expect, it } from "vitest";
import { chatGemini, planGemini, streamAssistantReply, type AssistantStreamEvent } from "../src/ai/gemini.js";
import { GeminiEmbedder } from "../src/ai/embeddings.js";
import { streamAnswerFromWorkspace } from "../src/ai/workspace-qa.js";

/**
 * Contract tests against the real Gemini API: they catch provider-side
 * changes (structured-output support, streaming frame shape, embedding
 * dimensions) that the stubbed unit tests cannot. Opt-in, because they need a
 * key and the network:
 *
 *   GEMINI_LIVE=1 GEMINI_API_KEY=... pnpm --filter @docsync/server test gemini.live
 */
const apiKey = process.env.GEMINI_API_KEY;
const live = process.env.GEMINI_LIVE === "1" && Boolean(apiKey);
const config = { apiKey, model: process.env.GEMINI_MODEL ?? "gemini-3.5-flash-lite" };

const block = (id: string, text: string, type: SerializedBlock["type"] = "paragraph"): SerializedBlock => ({
  id,
  type,
  text,
  checked: false,
  language: "plaintext",
  uploadId: null,
  children: [],
});

const runbook = {
  title: "Database runbook",
  role: "editor",
  blocks: [
    block("intro", "Failover procedure", "heading"),
    block("steps", "When the primary fails, promote the replica and repoint the gateway at the new writer endpoint."),
  ],
};

const cosine = (a: number[], b: number[]) => a.reduce((sum, value, index) => sum + value * b[index]!, 0);

describe.skipIf(!live)("Gemini (live)", { timeout: 60_000 }, () => {
  it("embeds at the stored width and ranks by meaning, not shared words", async () => {
    const [query, related, unrelated] = await new GeminiEmbedder(apiKey!).embed([
      "what happens if postgres goes down",
      "When the primary fails, promote the replica.",
      "Lunch options for the team offsite.",
    ]);
    expect(query).toHaveLength(768);
    // No word in the query appears in the related sentence.
    expect(cosine(query!, related!)).toBeGreaterThan(cosine(query!, unrelated!));
  });

  it("answers a question from the document", async () => {
    const result = await chatGemini(config, { ...runbook, prompt: "What should I do when the primary fails?" });
    expect(result.kind).toBe("answer");
    if (result.kind === "answer") expect(result.answer.toLowerCase()).toContain("replica");
  });

  it("returns a schema-valid edit plan that targets existing blocks", async () => {
    const plan = await planGemini(config, { ...runbook, prompt: "Change the heading to say 'Primary failover'." });
    expect(plan.operations.length).toBeGreaterThan(0);
    const ids = new Set(runbook.blocks.map((b) => b.id));
    for (const operation of plan.operations) {
      if ("blockId" in operation) expect(ids).toContain(operation.blockId);
    }
  });

  it("streams a cited answer in several deltas", async () => {
    const parts: string[] = [];
    for await (const part of streamAnswerFromWorkspace(
      config,
      "How do we recover from a primary database failure? Answer in two sentences.",
      `[1] Database runbook\n${runbook.blocks[1]!.text}`
    ))
      parts.push(part);
    expect(parts.join("")).toMatch(/\[1\]/);
  });

  it("streams a document answer, and turns an implicit change request into a plan", async () => {
    const collect = async (prompt: string) => {
      const events: AssistantStreamEvent[] = [];
      for await (const event of streamAssistantReply(config, { ...runbook, prompt })) events.push(event);
      return events;
    };
    const answer = await collect("In one sentence, what does this page tell me to do?");
    expect(answer.every((event) => event.type === "delta")).toBe(true);
    expect(answer.map((event) => (event.type === "delta" ? event.text : "")).join("")).toMatch(/replica/i);

    // No edit verb + target, so this relies on the model choosing the sentinel.
    const edit = await collect("Make the failover steps sound more urgent.");
    expect(edit.map((event) => event.type)).toEqual(["plan"]);
  });
});
