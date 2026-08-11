import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import { createBlock, getBlockText, getTitleText, serializeDocument } from "@collab/shared";
import { applyAgentPlan, parseAgentPlan } from "../src/ai/agent.js";

describe("Gemini editing agent boundary", () => {
  it("accepts only the typed operation vocabulary", () => {
    expect(parseAgentPlan('{"summary":"Make concise","operations":[{"op":"set_title","text":"Short title"}]}')).toEqual({
      summary: "Make concise",
      operations: [{ op: "set_title", text: "Short title" }],
    });
    expect(() => parseAgentPlan('{"summary":"bad","operations":[{"op":"run_code","source":"rm -rf"}]}')).toThrow("unsupported");
    expect(parseAgentPlan(JSON.stringify({ message: "Add two blocks", edits: [
      { action: "add_block", blockType: "code", content: "print(\\\"Hello, world!\\\")" },
      { action: "insert", type: "paragraph", text: "A short essay follows." },
    ]})).operations).toHaveLength(2);
  });

  it("applies validated edits to a detached Yjs document", () => {
    const doc = new Y.Doc();
    createBlock(doc, "block-1", { type: "paragraph", text: "Draft" });
    applyAgentPlan(doc, {
      summary: "Rewrite and add a follow-up",
      operations: [
        { op: "replace_text", blockId: "block-1", text: "Reviewed draft" },
        { op: "insert_block", afterBlockId: "block-1", type: "todo", text: "Publish" },
        { op: "set_title", text: "Project notes" },
      ],
    });
    expect(getTitleText(doc).toString()).toBe("Project notes");
    expect(getBlockText(doc, "block-1")?.toString()).toBe("Reviewed draft");
    expect(serializeDocument(doc)).toHaveLength(2);
    expect(serializeDocument(doc)[1]?.type).toBe("todo");
    expect(serializeDocument(doc)[1]?.text).toBe("Publish");
  });
});
