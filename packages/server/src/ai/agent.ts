import { randomUUID } from "node:crypto";
import * as Y from "yjs";
import {
  createBlock,
  deleteBlock,
  getBlockText,
  getBlocksMap,
  getTitleText,
  insertBlockAfter,
  setBlockChecked,
  setBlockLanguage,
  setBlockType,
  type BlockType,
  type CodeLanguage,
} from "@collab/shared";

export type AgentOperation =
  | { op: "replace_text"; blockId: string; text: string }
  | { op: "set_block_type"; blockId: string; type: BlockType }
  | { op: "set_checked"; blockId: string; checked: boolean }
  | { op: "set_language"; blockId: string; language: CodeLanguage }
  | { op: "insert_block"; afterBlockId?: string; type: BlockType; text?: string }
  | { op: "delete_block"; blockId: string }
  | { op: "set_title"; text: string };

export interface AgentPlan {
  summary: string;
  operations: AgentOperation[];
}

const blockTypes = new Set<BlockType>(["paragraph", "heading", "todo", "bullet", "canvas", "code"]);
const languages = new Set<CodeLanguage>(["javascript", "python", "plaintext"]);

function normalizeBlockType(value: unknown): BlockType | null {
  if (typeof value !== "string") return null;
  const normalized = value.toLowerCase().replace(/[ -]/g, "_");
  if (normalized === "text" || normalized === "plain_text" || normalized === "text_block") return "paragraph";
  if (normalized === "code_block" || normalized === "codeblock") return "code";
  return blockTypes.has(normalized as BlockType) ? normalized as BlockType : null;
}

/** Parses Gemini's JSON-only response and rejects anything outside the small
 * mutation vocabulary the server can validate and commit. The model never
 * gets to send a raw Yjs update or arbitrary JavaScript. */
export function parseAgentPlan(raw: string): AgentPlan {
  const stripped = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const normalized = stripped.startsWith("{") ? stripped : stripped.match(/\{[\s\S]*\}/)?.[0];
  if (!normalized) throw new Error("Gemini returned an invalid edit plan");
  const value = JSON.parse(normalized) as { summary?: unknown; message?: unknown; operations?: unknown; edits?: unknown; changes?: unknown };
  if (!value || typeof value !== "object") throw new Error("Gemini returned an invalid edit plan");
  const candidates = value.operations ?? value.edits ?? value.changes;
  const operationList = Array.isArray(candidates) ? candidates : candidates && typeof candidates === "object" ? [candidates] : [];
  if (operationList.length > 20) throw new Error("Gemini returned too many document operations");
  const summaryValue = value.summary ?? value.message;
  const summary = typeof summaryValue === "string" ? summaryValue.trim().slice(0, 500) : "Proposed document changes";
  const operations = operationList.map((candidate) => validateOperation(candidate));
  return { summary, operations };
}

function validateOperation(candidate: unknown): AgentOperation {
  if (!candidate || typeof candidate !== "object") throw new Error("Gemini returned an invalid operation");
  const operation = candidate as Record<string, unknown>;
  const rawOp = operation.op ?? operation.action ?? operation.operation;
  if (rawOp !== undefined && typeof rawOp !== "string") throw new Error("Gemini returned an invalid operation");
  const opAliases: Record<string, AgentOperation["op"]> = {
    replace: "replace_text", update_text: "replace_text", edit_text: "replace_text",
    insert: "insert_block", add_block: "insert_block", create_block: "insert_block",
    set_type: "set_block_type", change_type: "set_block_type",
    remove: "delete_block", delete: "delete_block",
    title: "set_title",
  };
  const op = typeof rawOp === "string" ? (opAliases[rawOp] ?? rawOp) : undefined;
  const blockId = stringValue(operation.blockId, operation.block_id, operation.id);
  const text = stringValue(operation.text, operation.content, operation.newText, operation.new_text);
  const blockType = normalizeBlockType(operation.type ?? operation.blockType ?? operation.block_type);
  const afterBlockId = stringValue(operation.afterBlockId, operation.after_block_id, operation.after);
  if (op === "replace_text" && blockId && text !== undefined && text.length <= 12_000) {
    return { op, blockId, text };
  }
  // A few Gemini responses omit `op` for an obvious new-block object. Infer
  // only this unambiguous shape; all other mutations remain explicit.
  const inferredInsert = op === undefined && !blockId && blockType !== null && (text !== undefined || afterBlockId !== undefined);
  if ((op === "insert_block" || inferredInsert) && blockType && (text === undefined || text.length <= 12_000)) {
    return { op: "insert_block", afterBlockId, type: blockType, text };
  }
  if (op === "set_block_type" && blockId && blockType) {
    return { op, blockId, type: blockType };
  }
  if (op === "set_checked" && blockId && typeof (operation.checked ?? operation.isChecked) === "boolean") {
    return { op, blockId, checked: (operation.checked ?? operation.isChecked) as boolean };
  }
  if (op === "set_language" && blockId && typeof operation.language === "string" && languages.has(operation.language as CodeLanguage)) {
    return { op, blockId, language: operation.language as CodeLanguage };
  }
  if (op === "delete_block" && blockId) return { op, blockId };
  if (op === "set_title" && text !== undefined && text.length <= 500) return { op, text };
  throw new Error("Gemini returned an unsupported or invalid document operation");
}

function stringValue(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string");
}

/** Applies a validated plan to a detached copy. Callers capture the resulting
 * Yjs update and submit it through Room.applyServerUpdate, preserving the
 * normal Postgres-before-fanout admission boundary. */
export function applyAgentPlan(doc: Y.Doc, plan: AgentPlan): void {
  const blocks = getBlocksMap(doc);
  doc.transact(() => {
    for (const operation of plan.operations) {
      if (operation.op === "set_title") {
        const title = getTitleText(doc);
        title.delete(0, title.length);
        title.insert(0, operation.text);
        continue;
      }
      if (operation.op === "insert_block") {
        const id = randomUUID();
        if (operation.afterBlockId) {
          if (!insertBlockAfter(doc, operation.afterBlockId, id, operation.type, operation.text)) throw new Error(`block ${operation.afterBlockId} does not exist`);
        } else {
          createBlock(doc, id, { type: operation.type, text: operation.text });
        }
        continue;
      }
      const block = blocks.get(operation.blockId);
      if (!block) throw new Error(`block ${operation.blockId} does not exist`);
      if (operation.op === "replace_text") {
        const text = getBlockText(doc, operation.blockId);
        if (!text) throw new Error(`block ${operation.blockId} has no text field`);
        text.delete(0, text.length);
        if (operation.text) text.insert(0, operation.text);
      } else if (operation.op === "set_block_type") setBlockType(doc, operation.blockId, operation.type);
      else if (operation.op === "set_checked") setBlockChecked(doc, operation.blockId, operation.checked);
      else if (operation.op === "set_language") setBlockLanguage(doc, operation.blockId, operation.language);
      else if (operation.op === "delete_block") deleteBlock(doc, operation.blockId);
    }
  });
}
