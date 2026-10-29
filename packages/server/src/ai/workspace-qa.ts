import { postChat, streamChat, type GeminiConfig } from "./gemini.js";
import type { SemanticHit } from "../search/semantic.js";

const SYSTEM_PROMPT =
  "You answer questions about a team's workspace using only the numbered sources provided. " +
  "Cite every claim with its source number in square brackets, e.g. [2]. " +
  "If the sources do not contain the answer, say so plainly instead of guessing. Be concise, and write plain text, not Markdown.";

export interface Citation {
  n: number;
  pageId: string;
  title: string;
  snippet: string;
}

/** Keeps sources within half of the best match's score. Nearest-neighbour
 *  search always returns *something*; weakly related chunks pad the prompt
 *  and invite spurious citations. Relative, so it works across embedders
 *  whose absolute similarity scales differ. */
export function selectSources(hits: SemanticHit[], relativeFloor = 0.5): SemanticHit[] {
  const best = hits[0]?.score ?? 0;
  if (best <= 0) return [];
  return hits.filter((hit) => hit.score >= best * relativeFloor);
}

/** Sources are numbered so the model can cite them and the client can link
 *  each [n] back to its page. */
export function buildSources(hits: SemanticHit[]): { citations: Citation[]; prompt: string } {
  const citations = hits.map((hit, index) => ({
    n: index + 1,
    pageId: hit.pageId,
    title: hit.title,
    snippet: hit.content.length > 240 ? `${hit.content.slice(0, 240)}…` : hit.content,
  }));
  const prompt = hits.map((hit, index) => `[${index + 1}] ${hit.title}\n${hit.content}`).join("\n\n");
  return { citations, prompt };
}

function requestPayload(question: string, sources: string) {
  return {
    temperature: 0.1,
    max_tokens: 900,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `Sources:\n${sources || "(no matching sources)"}\n\nQuestion: ${question}` },
    ],
  };
}

export async function answerFromWorkspace(
  config: GeminiConfig,
  question: string,
  hits: SemanticHit[]
): Promise<{ answer: string; citations: Citation[] }> {
  const { citations, prompt } = buildSources(hits);
  const answer = await postChat(config, requestPayload(question, prompt), "answer", "Gemini returned no answer");
  return { answer, citations };
}

/** Yields answer text as the provider streams it. */
export function streamAnswerFromWorkspace(
  config: GeminiConfig,
  question: string,
  sources: string,
  signal?: AbortSignal
): AsyncGenerator<string> {
  return streamChat(config, requestPayload(question, sources), "answer", signal);
}
