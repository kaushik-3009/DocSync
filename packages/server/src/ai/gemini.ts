import type { SerializedBlock } from "@docsync/shared";
import { z } from "zod/v4";
import { AGENT_PLAN_JSON_SCHEMA, agentPlanSchema, parseAgentPlan, providerJsonSchema, type AgentPlan } from "./agent.js";

/** Unified chat reply: an answer, or a proposed (never applied) edit plan. */
const CHAT_RESPONSE_JSON_SCHEMA = providerJsonSchema(
  z.union([z.object({ kind: z.literal("answer"), answer: z.string() }), agentPlanSchema.extend({ kind: z.literal("edit_plan") })])
);

function structuredOutput(name: string, schema: Record<string, unknown>) {
  return { type: "json_schema", json_schema: { name, strict: true, schema } };
}

export interface GeminiConfig {
  apiKey?: string;
  model: string;
}

export type GeminiChatResult = { kind: "answer"; answer: string } | { kind: "edit_plan"; plan: AgentPlan };

export class AiNotConfiguredError extends Error {
  constructor() {
    super("AI assistant is not configured");
    this.name = "AiNotConfiguredError";
  }
}

/** Provider and response-shape failures stay distinguishable at the HTTP
 * boundary. They must not all collapse into the old "safe response" copy. */
export class GeminiProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly phase: "answer" | "classification" | "content" | "plan" = "classification"
  ) {
    super(message);
    this.name = "GeminiProviderError";
  }
}

export class GeminiFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeminiFormatError";
  }
}

export const CHAT_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";

/** Gemini's OpenAI-compatible endpoint sometimes wraps its error object in a
 *  one-element array; read both shapes so the provider's reason survives. */
export function providerErrorMessage(body: unknown, status: number): string {
  const error = (Array.isArray(body) ? body[0] : body) as { error?: { message?: unknown } } | undefined;
  const message = error?.error?.message;
  return typeof message === "string" && message ? message : `Gemini request failed with HTTP ${status}`;
}

type ChatPhase = GeminiProviderError["phase"];

/** One chat-completions round trip. Returns the reply text, or throws a
 *  GeminiProviderError naming the phase that failed. */
export async function postChat(
  config: GeminiConfig,
  payload: Record<string, unknown>,
  phase: ChatPhase,
  emptyMessage: string
): Promise<string> {
  if (!config.apiKey) throw new AiNotConfiguredError();
  const response = await fetch(CHAT_ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: config.model, ...payload }),
  });
  const body = (await response.json().catch(() => ({}))) as {
    choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>;
  };
  if (!response.ok) throw new GeminiProviderError(providerErrorMessage(body, response.status), response.status, phase);
  const rawContent = body.choices?.[0]?.message?.content;
  const content = (typeof rawContent === "string" ? rawContent : rawContent?.map((part) => part.text ?? "").join(""))?.trim();
  if (!content)
    throw new GeminiProviderError(`${emptyMessage} (the provider may have filtered or truncated the response)`, response.status, phase);
  return content;
}

/** Streams a chat completion's text deltas. Breaking out of the loop
 *  cancels the provider request. */
export async function* streamChat(
  config: GeminiConfig,
  payload: Record<string, unknown>,
  phase: ChatPhase,
  signal?: AbortSignal
): AsyncGenerator<string> {
  if (!config.apiKey) throw new AiNotConfiguredError();
  const response = await fetch(CHAT_ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: config.model, ...payload, stream: true }),
    signal,
  });
  if (!response.ok || !response.body) {
    const body = await response.json().catch(() => ({}));
    throw new GeminiProviderError(providerErrorMessage(body, response.status), response.status, phase);
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

export async function askGemini(
  config: GeminiConfig,
  input: { prompt: string; title: string; blocks: SerializedBlock[]; role: string }
): Promise<string> {
  const context = serializeContext(input.title, input.blocks);
  return postChat(
    config,
    {
      temperature: 0.2,
      max_tokens: 1200,
      messages: [
        {
          role: "system",
          content:
            "You are DocSync's document assistant. Answer only from the supplied document when the user asks about its contents. Clearly say when the document does not contain the answer. Never claim to have edited the document. Keep responses concise and useful.",
        },
        {
          role: "user",
          content: `The caller has ${input.role} access.\n\nDocument:\n${context}\n\nRequest:\n${input.prompt}`,
        },
      ],
    },
    "answer",
    "Gemini returned no answer"
  );
}

/** Generates prose/code independently from document Q&A and JSON planning.
 * This avoids asking one model call to classify, write content, and describe a
 * mutation all at once. */
async function generateGeminiContent(
  config: GeminiConfig,
  input: { prompt: string; role: string; kind: "prose" | "code" }
): Promise<string> {
  return postChat(
    config,
    {
      temperature: 0.2,
      max_tokens: 1200,
      messages: [
        {
          role: "system",
          content:
            input.kind === "code"
              ? "Generate only the requested code. Return raw code with no markdown fences, explanation, JSON, or claim that you edited a document."
              : "Generate only the requested prose. Return the prose itself with no preamble, explanation, JSON, markdown fences, or claim that you edited a document.",
        },
        { role: "user", content: `The caller has ${input.role} access. Write the requested ${input.kind} content:\n${input.prompt}` },
      ],
    },
    "content",
    "Gemini returned no generated content"
  );
}

export async function planGemini(
  config: GeminiConfig,
  input: { prompt: string; title: string; blocks: SerializedBlock[]; role: string }
): Promise<AgentPlan> {
  const context = serializeContext(input.title, input.blocks);
  const content = await postChat(
    config,
    {
      temperature: 0.1,
      max_tokens: 1800,
      response_format: structuredOutput("agent_plan", AGENT_PLAN_JSON_SCHEMA),
      messages: [
        {
          role: "system",
          content:
            'You are DocSync\'s editing agent. Return JSON only with this exact shape: {"summary": string, "operations": [{"op": "replace_text", "blockId": string, "text": string} | {"op": "set_block_type", "blockId": string, "type": "paragraph"|"heading"|"todo"|"bullet"|"canvas"|"code"} | {"op": "set_checked", "blockId": string, "checked": boolean} | {"op": "set_language", "blockId": string, "language": "javascript"|"python"|"plaintext"} | {"op": "insert_block", "afterBlockId": string, "type": string, "text": string} | {"op": "delete_block", "blockId": string} | {"op": "set_title", "text": string}]}. Preserve existing block IDs. Use at most 20 operations. Never invent block IDs. If no change is needed, return an empty operations array. Do not include markdown fences or commentary.',
        },
        {
          role: "user",
          content: `The caller has ${input.role} access.\n\nDocument (existing block IDs are authoritative):\n${context}\n\nRequested edit:\n${input.prompt}`,
        },
      ],
    },
    "plan",
    "Gemini returned no edit plan"
  );
  try {
    return parseAgentPlan(content);
  } catch (error) {
    throw new GeminiFormatError(error instanceof Error ? error.message : "Gemini returned an invalid edit plan");
  }
}

/** Unified conversational entry point. Gemini decides whether the user is
 * asking a question or requesting a document change. Changes still return a
 * typed proposal; only the explicit client Apply action can commit it. */
export async function chatGemini(
  config: GeminiConfig,
  input: { prompt: string; title: string; blocks: SerializedBlock[]; role: string }
): Promise<GeminiChatResult> {
  if (!config.apiKey) throw new AiNotConfiguredError();
  const editIntent = isExplicitEditRequest(input.prompt);
  if (editIntent) {
    if (input.role !== "owner" && input.role !== "editor") {
      return { kind: "answer", answer: "You have viewer access to this document, so I can answer questions but cannot prepare edits." };
    }
    // Explicit content requests do not need a model classification round trip.
    // The old two-call fallback made ordinary essay/code requests the most
    // likely path to a malformed or provider-filtered response.
    if (wantsGeneratedContent(input.prompt)) return { kind: "edit_plan", plan: await fallbackEditPlan(config, input) };
    return { kind: "edit_plan", plan: await planGemini(config, input) };
  }
  const context = serializeContext(input.title, input.blocks);
  const content = await postChat(
    config,
    {
      temperature: 0.2,
      max_tokens: 1800,
      response_format: structuredOutput("chat_response", CHAT_RESPONSE_JSON_SCHEMA),
      messages: [
        {
          role: "system",
          content:
            'You are DocSync\'s unified document assistant. Decide whether the request is informational or asks to change the document. Return JSON only. For questions use {"kind":"answer","answer":"..."}. For requested changes use {"kind":"edit_plan","summary":"...","operations":[...]} using only the typed operations: replace_text(blockId,text), set_block_type(blockId,type), set_checked(blockId,checked), set_language(blockId,language), insert_block(afterBlockId,type,text), delete_block(blockId), set_title(text). Preserve existing block IDs, use at most 20 operations, and never invent IDs. If the user asks to add content, prepare an edit plan instead of claiming it was applied. The caller\'s access is authoritative; do not propose edits for viewers.',
        },
        {
          role: "user",
          content: `The caller has ${input.role} access.\n\nDocument (existing block IDs are authoritative):\n${context}\n\nRequest:\n${input.prompt}`,
        },
      ],
    },
    "classification",
    "Gemini returned no conversational response"
  );
  const normalized = content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const jsonCandidate = normalized.startsWith("{") ? normalized : normalized.match(/\{[\s\S]*\}/)?.[0];
  let parsed: { kind?: unknown; answer?: unknown; operations?: unknown; edits?: unknown; changes?: unknown };
  try {
    parsed = JSON.parse(jsonCandidate ?? normalized) as {
      kind?: unknown;
      answer?: unknown;
      operations?: unknown;
      edits?: unknown;
      changes?: unknown;
    };
  } catch {
    throw new GeminiFormatError("Gemini returned non-JSON conversational content");
  }
  if (parsed.kind === "answer" && typeof parsed.answer === "string") return { kind: "answer", answer: parsed.answer.trim() };
  if (parsed.kind === "edit_plan") {
    try {
      return { kind: "edit_plan", plan: parseAgentPlan(normalized) };
    } catch {
      return { kind: "edit_plan", plan: await fallbackEditPlan(config, input) };
    }
  }
  if (parsed.kind === undefined && (parsed.operations !== undefined || parsed.edits !== undefined || parsed.changes !== undefined)) {
    try {
      return { kind: "edit_plan", plan: parseAgentPlan(normalized) };
    } catch {
      return { kind: "edit_plan", plan: await fallbackEditPlan(config, input) };
    }
  }
  throw new GeminiFormatError("Gemini returned neither an answer nor an edit plan");
}

/** What the model replies with, alone, when a streamed request turns out to
 *  be a change. Short enough to buffer before forwarding any text. */
export const EDIT_SENTINEL = "[[EDIT]]";

export type AssistantStreamEvent = { type: "delta"; text: string } | { type: "plan"; plan: AgentPlan };

/**
 * Streamed counterpart of chatGemini. Questions stream as plain text (no JSON
 * envelope, so tokens can be forwarded as they arrive). Edits are never
 * streamed: an unambiguous edit request skips straight to a typed plan, and
 * for anything else the model may answer with EDIT_SENTINEL, which aborts the
 * stream and produces a plan instead. Either way the plan is only a proposal.
 */
export async function* streamAssistantReply(
  config: GeminiConfig,
  input: { prompt: string; title: string; blocks: SerializedBlock[]; role: string },
  signal?: AbortSignal
): AsyncGenerator<AssistantStreamEvent> {
  if (!config.apiKey) throw new AiNotConfiguredError();
  const canEdit = input.role === "owner" || input.role === "editor";
  const viewerReply: AssistantStreamEvent = {
    type: "delta",
    text: "You have viewer access to this document, so I can answer questions but cannot prepare edits.",
  };
  const plan = async (): Promise<AssistantStreamEvent> => ({
    type: "plan",
    plan: wantsGeneratedContent(input.prompt) ? await fallbackEditPlan(config, input) : await planGemini(config, input),
  });

  if (isExplicitEditRequest(input.prompt)) {
    yield canEdit ? await plan() : viewerReply;
    return;
  }

  const context = serializeContext(input.title, input.blocks);
  const deltas = streamChat(
    config,
    {
      temperature: 0.2,
      max_tokens: 1200,
      messages: [
        {
          role: "system",
          content: `You are DocSync's document assistant. Answer in chat: questions, explanations, walkthroughs, summaries and reviews are all answered in chat, concisely. Base answers about the document only on its contents, and say when it does not contain the answer. Only when the user explicitly asks you to modify the document itself (rewrite, reformat, add to, remove from, or translate it) reply with exactly ${EDIT_SENTINEL} and nothing else; asking you to explain or describe something is never a modification, however detailed. Write plain text, not Markdown.`,
        },
        {
          role: "user",
          content: `The caller has ${input.role} access.\n\nDocument:\n${context}\n\nRequest:\n${input.prompt}`,
        },
      ],
    },
    "answer",
    signal
  );
  // Hold text back until it can no longer be the sentinel.
  let head = "";
  let decided = false;
  for await (const delta of deltas) {
    if (decided) {
      yield { type: "delta", text: delta };
      continue;
    }
    head += delta;
    const trimmed = head.trimStart();
    if (trimmed.startsWith(EDIT_SENTINEL)) {
      yield canEdit ? await plan() : viewerReply; // leaving the loop cancels the stream
      return;
    }
    if (trimmed.length >= EDIT_SENTINEL.length || !EDIT_SENTINEL.startsWith(trimmed)) {
      decided = true;
      yield { type: "delta", text: head };
    }
  }
  if (!decided && head.trim()) yield { type: "delta", text: head };
  else if (!decided)
    throw new GeminiProviderError(
      "Gemini returned no answer (the provider may have filtered or truncated the response)",
      undefined,
      "answer"
    );
}

async function fallbackEditPlan(
  config: GeminiConfig,
  input: { prompt: string; title: string; blocks: SerializedBlock[]; role: string }
): Promise<AgentPlan> {
  if (input.role !== "owner" && input.role !== "editor") throw new Error("editor or owner access is required for document edits");
  const wantsEssayOrParagraph = /\b(essay|paragraph|prose|article|text)\b/i.test(input.prompt);
  const wantsCode = /\b(code ?block|codeblock|snippet)\b/i.test(input.prompt);
  if (!wantsEssayOrParagraph && !wantsCode) return planGemini(config, input);
  const generated = await generateGeminiContent(config, {
    prompt: input.prompt,
    role: input.role,
    kind: wantsCode ? "code" : "prose",
  });
  const afterBlockId = lastBlockId(input.blocks);
  return {
    summary: `Add a new ${wantsCode ? "code" : "paragraph"} block below the current content`,
    operations: [{ op: "insert_block", afterBlockId, type: wantsCode ? "code" : "paragraph", text: generated.trim() }],
  };
}

function wantsGeneratedContent(prompt: string): boolean {
  return /\b(essay|paragraph|prose|article|text|code ?block|codeblock|snippet)\b/i.test(prompt);
}

/** Deterministic routing for unambiguous mutation language. Gemini still
 * handles ordinary questions and ambiguous conversation, but it no longer
 * gets to turn an explicit add/write/insert request into an unusable answer. */
function isExplicitEditRequest(prompt: string): boolean {
  if (wantsGeneratedContent(prompt)) return true;
  const verb = /\b(add|insert|create|append|write|edit|change|rewrite|replace|remove|delete|convert|set|rename|update)\b/i.test(prompt);
  const target = /\b(document|page|block|paragraph|heading|title|text|code|canvas|todo|bullet|below|after|content)\b/i.test(prompt);
  return verb && target;
}

function lastBlockId(blocks: SerializedBlock[]): string | undefined {
  const last = blocks[blocks.length - 1];
  if (!last) return undefined;
  return lastBlockId(last.children) ?? last.id;
}

function serializeContext(title: string, blocks: SerializedBlock[]): string {
  const lines: string[] = [`# ${title || "Untitled"}`];
  const visit = (items: SerializedBlock[], depth: number) => {
    for (const block of items) {
      const text = block.text.trim() || "(empty)";
      // IDs are part of the model context because an edit plan must target
      // an existing block. Omitting them forces the model to invent IDs,
      // which is rejected at the durable apply boundary.
      lines.push(`${"  ".repeat(depth)}[${block.type} id=${block.id}] ${text}`);
      visit(block.children, depth + 1);
    }
  };
  visit(blocks, 0);
  // Bound user-controlled context before it reaches a paid external API.
  return lines.join("\n").slice(0, 40_000);
}
