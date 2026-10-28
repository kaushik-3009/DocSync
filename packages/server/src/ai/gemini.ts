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

export async function askGemini(
  config: GeminiConfig,
  input: { prompt: string; title: string; blocks: SerializedBlock[]; role: string }
): Promise<string> {
  if (!config.apiKey) throw new AiNotConfiguredError();
  const context = serializeContext(input.title, input.blocks);
  const response = await fetch("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.model,
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
    }),
  });
  const body = (await response.json().catch(() => ({}))) as {
    choices?: Array<{ message?: { content?: string } }>;
    error?: { message?: string };
  };
  if (!response.ok)
    throw new GeminiProviderError(body.error?.message ?? `Gemini request failed with HTTP ${response.status}`, response.status, "answer");
  const answer = body.choices?.[0]?.message?.content?.trim();
  if (!answer)
    throw new GeminiProviderError(
      "Gemini returned no answer (the provider may have filtered or truncated the response)",
      response.status,
      "answer"
    );
  return answer;
}

/** Generates prose/code independently from document Q&A and JSON planning.
 * This avoids asking one model call to classify, write content, and describe a
 * mutation all at once. */
async function generateGeminiContent(
  config: GeminiConfig,
  input: { prompt: string; role: string; kind: "prose" | "code" }
): Promise<string> {
  if (!config.apiKey) throw new AiNotConfiguredError();
  const response = await fetch("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.model,
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
    }),
  });
  const body = (await response.json().catch(() => ({}))) as {
    choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>;
    error?: { message?: string };
  };
  if (!response.ok)
    throw new GeminiProviderError(body.error?.message ?? `Gemini request failed with HTTP ${response.status}`, response.status, "content");
  const rawContent = body.choices?.[0]?.message?.content;
  const content = (typeof rawContent === "string" ? rawContent : rawContent?.map((part) => part.text ?? "").join(""))?.trim();
  if (!content)
    throw new GeminiProviderError(
      "Gemini returned no generated content (the provider may have filtered or truncated the response)",
      response.status,
      "content"
    );
  return content;
}

export async function planGemini(
  config: GeminiConfig,
  input: { prompt: string; title: string; blocks: SerializedBlock[]; role: string }
): Promise<AgentPlan> {
  if (!config.apiKey) throw new AiNotConfiguredError();
  const context = serializeContext(input.title, input.blocks);
  const response = await fetch("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.model,
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
    }),
  });
  const body = (await response.json().catch(() => ({}))) as {
    choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>;
    error?: { message?: string };
  };
  if (!response.ok)
    throw new GeminiProviderError(body.error?.message ?? `Gemini request failed with HTTP ${response.status}`, response.status, "plan");
  const rawContent = body.choices?.[0]?.message?.content;
  const content = typeof rawContent === "string" ? rawContent : rawContent?.map((part) => part.text ?? "").join("");
  if (!content)
    throw new GeminiProviderError(
      "Gemini returned no edit plan (the provider may have filtered or truncated the response)",
      response.status,
      "plan"
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
  const response = await fetch("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.model,
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
    }),
  });
  const body = (await response.json().catch(() => ({}))) as {
    choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>;
    error?: { message?: string };
  };
  if (!response.ok)
    throw new GeminiProviderError(
      body.error?.message ?? `Gemini request failed with HTTP ${response.status}`,
      response.status,
      "classification"
    );
  const rawContent = body.choices?.[0]?.message?.content;
  const content = (typeof rawContent === "string" ? rawContent : rawContent?.map((part) => part.text ?? "").join(""))?.trim();
  if (!content)
    throw new GeminiProviderError(
      "Gemini returned no conversational response (the provider may have filtered or truncated the response)",
      response.status,
      "classification"
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
