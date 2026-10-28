import { AiNotConfiguredError, GeminiProviderError, type GeminiConfig } from "./gemini.js";
import type { SemanticHit } from "../search/semantic.js";

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";

const SYSTEM_PROMPT =
  "You answer questions about a team's workspace using only the numbered sources provided. " +
  "Cite every claim with its source number in square brackets, e.g. [2]. " +
  "If the sources do not contain the answer, say so plainly instead of guessing. Be concise.";

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

function requestBody(config: GeminiConfig, question: string, sources: string, stream: boolean) {
  return JSON.stringify({
    model: config.model,
    temperature: 0.1,
    max_tokens: 900,
    stream,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `Sources:\n${sources || "(no matching sources)"}\n\nQuestion: ${question}` },
    ],
  });
}

export async function answerFromWorkspace(
  config: GeminiConfig,
  question: string,
  hits: SemanticHit[]
): Promise<{ answer: string; citations: Citation[] }> {
  if (!config.apiKey) throw new AiNotConfiguredError();
  const { citations, prompt } = buildSources(hits);
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
    body: requestBody(config, question, prompt, false),
  });
  const body = (await response.json().catch(() => ({}))) as {
    choices?: Array<{ message?: { content?: string } }>;
    error?: { message?: string };
  };
  if (!response.ok)
    throw new GeminiProviderError(body.error?.message ?? `Gemini request failed with HTTP ${response.status}`, response.status, "answer");
  const answer = body.choices?.[0]?.message?.content?.trim();
  if (!answer) throw new GeminiProviderError("Gemini returned no answer", response.status, "answer");
  return { answer, citations };
}

/** Yields answer text as the provider streams it (server-sent events). */
export async function* streamAnswerFromWorkspace(
  config: GeminiConfig,
  question: string,
  sources: string,
  signal?: AbortSignal
): AsyncGenerator<string> {
  if (!config.apiKey) throw new AiNotConfiguredError();
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
    body: requestBody(config, question, sources, true),
    signal,
  });
  if (!response.ok || !response.body) {
    const body = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new GeminiProviderError(body.error?.message ?? `Gemini request failed with HTTP ${response.status}`, response.status, "answer");
  }
  yield* parseChatStream(response.body);
}

/** Parses an OpenAI-style chat completion SSE stream into content deltas. */
export async function* parseChatStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return;
      try {
        const delta = (JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> }).choices?.[0]?.delta?.content;
        if (delta) yield delta;
      } catch {
        // Ignore keep-alive or partial frames.
      }
    }
  }
}
