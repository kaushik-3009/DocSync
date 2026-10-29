/**
 * Routing eval for the streamed document assistant: does each prompt come back
 * as a chat answer or as an edit plan? Run it after changing the assistant's
 * prompts; it needs a real key and makes ~15 requests (paced for the free
 * tier's 15 requests per minute):
 *
 *   GEMINI_API_KEY=... pnpm --filter @docsync/server eval:assistant
 */
import type { SerializedBlock } from "@docsync/shared";
import { streamAssistantReply } from "../src/ai/gemini.js";

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error("GEMINI_API_KEY is required");
  process.exit(2);
}
const config = { apiKey, model: process.env.GEMINI_MODEL ?? "gemini-3.5-flash-lite" };
const paceMs = Number(process.env.EVAL_PACE_MS ?? 9_000);

const blocks: SerializedBlock[] = [
  {
    id: "b1",
    type: "paragraph",
    text: "When the primary fails, promote the replica, then repoint both gateways at the new writer endpoint and page the on-call engineer.",
    checked: false,
    language: "plaintext",
    uploadId: null,
    children: [],
  },
];

type Route = "answer" | "plan";
const cases: Array<[Route, string]> = [
  // Detailed or open-ended questions are the ones models over-route to edits.
  ["answer", "Walk me through this runbook in detail: for each step, explain why it matters and what could go wrong."],
  ["answer", "What is a CRDT? Explain in about 100 words."],
  ["answer", "Summarize this page."],
  ["answer", "Is anything missing from this runbook?"],
  ["answer", "Who gets paged?"],
  // Implicit edits: no add/insert/rewrite verb, so the model must choose.
  ["plan", "Make the steps sound more urgent."],
  ["plan", "Turn this into a numbered list."],
  ["plan", "Fix the grammar."],
  ["plan", "Translate it into Spanish."],
  ["plan", "Shorten it."],
];

let correct = 0;
for (const [index, [expected, prompt]] of cases.entries()) {
  if (index > 0) await new Promise((resolve) => setTimeout(resolve, paceMs));
  const routes = new Set<Route>();
  for await (const event of streamAssistantReply(config, { prompt, title: "Incident runbook", blocks, role: "owner" })) {
    routes.add(event.type === "delta" ? "answer" : "plan");
  }
  const actual = [...routes].join("+");
  if (actual === expected) correct += 1;
  console.log(`${actual === expected ? "pass" : "FAIL"}  expected ${expected.padEnd(6)} got ${actual.padEnd(6)} ${prompt}`);
}
console.log(`\n${correct}/${cases.length} routed correctly (${config.model})`);
process.exit(correct === cases.length ? 0 : 1);
