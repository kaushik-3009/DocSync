import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  createBlock,
  deleteBlock,
  setBlockType,
  setBlockChecked,
  indentBlock,
  outdentBlock,
  serializeDocument,
  serializeDocumentWithDeltas,
  splitBlock,
  mergeBlockIntoPrevious,
  restoreBlocksFromSnapshot,
  createComment,
  commentsForBlock,
  getBlockText,
  getRootOrder,
} from "@collab/shared";

describe("block types", () => {
  it("defaults to paragraph, unchecked, and can change type", () => {
    const doc = new Y.Doc();
    createBlock(doc, "b1", { type: "paragraph", text: "hi" });

    expect(serializeDocument(doc)).toMatchObject([{ id: "b1", type: "paragraph", checked: false }]);

    setBlockType(doc, "b1", "todo");
    expect(serializeDocument(doc)[0].type).toBe("todo");

    setBlockChecked(doc, "b1", true);
    expect(serializeDocument(doc)[0].checked).toBe(true);
  });
});

describe("block nesting", () => {
  it("indents a block under its preceding sibling", () => {
    const doc = new Y.Doc();
    createBlock(doc, "b1", { type: "paragraph", text: "parent" });
    createBlock(doc, "b2", { type: "paragraph", text: "child" });

    indentBlock(doc, "b2");

    const tree = serializeDocument(doc);
    expect(tree).toHaveLength(1);
    expect(tree[0].id).toBe("b1");
    expect(tree[0].children.map((c) => c.id)).toEqual(["b2"]);
  });

  it("is a no-op indenting the first block (no preceding sibling)", () => {
    const doc = new Y.Doc();
    createBlock(doc, "b1", { type: "paragraph", text: "only" });

    indentBlock(doc, "b1");

    const tree = serializeDocument(doc);
    expect(tree).toHaveLength(1);
    expect(tree[0].children).toHaveLength(0);
  });

  it("outdents a nested block back to its parent's level, right after the parent", () => {
    const doc = new Y.Doc();
    createBlock(doc, "b1", { type: "paragraph", text: "parent" });
    createBlock(doc, "b2", { type: "paragraph", text: "child" });
    createBlock(doc, "b3", { type: "paragraph", text: "after" });
    indentBlock(doc, "b2");

    outdentBlock(doc, "b2");

    const tree = serializeDocument(doc);
    expect(tree.map((b) => b.id)).toEqual(["b1", "b2", "b3"]);
    expect(tree[0].children).toHaveLength(0);
  });

  it("is a no-op outdenting an already-top-level block", () => {
    const doc = new Y.Doc();
    createBlock(doc, "b1", { type: "paragraph", text: "top" });

    outdentBlock(doc, "b1");

    expect(serializeDocument(doc).map((b) => b.id)).toEqual(["b1"]);
  });

  it("supports multiple levels of nesting via repeated indents, one level at a time", () => {
    const doc = new Y.Doc();
    createBlock(doc, "b1", { type: "paragraph", text: "l0" });
    createBlock(doc, "b2", { type: "paragraph", text: "l1" });
    createBlock(doc, "b3", { type: "paragraph", text: "l2" });
    indentBlock(doc, "b2"); // b2 becomes a child of b1
    indentBlock(doc, "b3"); // b3's preceding sibling in root is now b1 -> becomes b1's child too (sibling of b2)
    indentBlock(doc, "b3"); // b3's preceding sibling in b1.children is now b2 -> becomes b2's child

    const tree = serializeDocument(doc);
    expect(tree).toHaveLength(1);
    expect(tree[0].children[0].id).toBe("b2");
    expect(tree[0].children[0].children[0].id).toBe("b3");
  });

  it("deleting a nested block's ancestor recursively deletes descendants and their comments", () => {
    const doc = new Y.Doc();
    createBlock(doc, "b1", { type: "paragraph", text: "parent" });
    createBlock(doc, "b2", { type: "paragraph", text: "child" });
    indentBlock(doc, "b2");
    createComment(doc, "c1", { blockId: "b2", authorId: "u1", authorName: "Alice", text: "on the child" });

    deleteBlock(doc, "b1");

    expect(serializeDocument(doc)).toEqual([]);
    expect(commentsForBlock(doc, "b2")).toHaveLength(0);
  });
});

describe("splitBlock", () => {
  it("splits a block's text at the offset into two sibling blocks", () => {
    const doc = new Y.Doc();
    createBlock(doc, "b1", { type: "paragraph", text: "hello world" });

    const ok = splitBlock(doc, "b1", 5, "b2");

    expect(ok).toBe(true);
    const tree = serializeDocument(doc);
    expect(tree.map((b) => ({ id: b.id, text: b.text }))).toEqual([
      { id: "b1", text: "hello" },
      { id: "b2", text: " world" },
    ]);
  });

  it("preserves formatting attributes on both sides of the split", () => {
    const doc = new Y.Doc();
    createBlock(doc, "b1", { type: "paragraph", text: "hello world" });
    const ytext = getBlockText(doc, "b1")!;
    doc.transact(() => ytext.format(0, 11, { bold: true }));

    splitBlock(doc, "b1", 5, "b2");

    const deltas = serializeDocumentWithDeltas(doc);
    expect(deltas[0].delta.every((op) => op.attributes?.bold)).toBe(true);
    expect(deltas[1].delta.every((op) => op.attributes?.bold)).toBe(true);
  });

  it("inserts the new block immediately after the original, preserving nesting level", () => {
    const doc = new Y.Doc();
    createBlock(doc, "b1", { type: "paragraph", text: "parent" });
    createBlock(doc, "b2", { type: "paragraph", text: "hello world" });
    createBlock(doc, "b3", { type: "paragraph", text: "after" });
    indentBlock(doc, "b2");

    splitBlock(doc, "b2", 5, "b2b");

    const tree = serializeDocument(doc);
    expect(tree.map((b) => b.id)).toEqual(["b1", "b3"]);
    expect(tree[0].children.map((c) => c.id)).toEqual(["b2", "b2b"]);
  });

  it("returns false for a non-existent block", () => {
    const doc = new Y.Doc();
    expect(splitBlock(doc, "missing", 0, "new")).toBe(false);
  });
});

describe("mergeBlockIntoPrevious", () => {
  it("appends the block's text onto the end of the previous sibling and removes it", () => {
    const doc = new Y.Doc();
    createBlock(doc, "b1", { type: "paragraph", text: "hello" });
    createBlock(doc, "b2", { type: "paragraph", text: " world" });

    const result = mergeBlockIntoPrevious(doc, "b2");

    expect(result).toEqual({ survivingBlockId: "b1", joinOffset: 5 });
    const tree = serializeDocument(doc);
    expect(tree.map((b) => ({ id: b.id, text: b.text }))).toEqual([{ id: "b1", text: "hello world" }]);
  });

  it("preserves formatting from both sides after merging", () => {
    const doc = new Y.Doc();
    createBlock(doc, "b1", { type: "paragraph", text: "hello" });
    createBlock(doc, "b2", { type: "paragraph", text: "world" });
    doc.transact(() => getBlockText(doc, "b2")!.format(0, 5, { italic: true }));

    mergeBlockIntoPrevious(doc, "b2");

    const deltas = serializeDocumentWithDeltas(doc);
    expect(deltas[0].delta.map((op) => [op.insert, op.attributes?.italic ?? false])).toEqual([
      ["hello", false],
      ["world", true],
    ]);
  });

  it("is a no-op for the first block (nothing to merge into)", () => {
    const doc = new Y.Doc();
    createBlock(doc, "b1", { type: "paragraph", text: "only" });

    const result = mergeBlockIntoPrevious(doc, "b1");

    expect(result).toBeNull();
    expect(serializeDocument(doc)).toHaveLength(1);
  });

  it("reassigns comments from the removed block onto the surviving block", () => {
    const doc = new Y.Doc();
    createBlock(doc, "b1", { type: "paragraph", text: "hello" });
    createBlock(doc, "b2", { type: "paragraph", text: "world" });
    createComment(doc, "c1", { blockId: "b2", authorId: "u1", authorName: "Alice", text: "note" });

    mergeBlockIntoPrevious(doc, "b2");

    expect(commentsForBlock(doc, "b1")).toHaveLength(1);
    expect(commentsForBlock(doc, "b2")).toHaveLength(0);
  });

  it("moves the removed block's children onto the surviving block", () => {
    const doc = new Y.Doc();
    createBlock(doc, "b1", { type: "paragraph", text: "hello" });
    createBlock(doc, "b2", { type: "paragraph", text: "world" });
    createBlock(doc, "b3", { type: "paragraph", text: "child" });
    indentBlock(doc, "b3"); // b3 becomes a child of b2

    mergeBlockIntoPrevious(doc, "b2");

    const tree = serializeDocument(doc);
    expect(tree).toHaveLength(1);
    expect(tree[0].id).toBe("b1");
    expect(tree[0].children.map((c) => c.id)).toEqual(["b3"]);
  });
});

describe("restoreBlocksFromSnapshot", () => {
  it("leaves unchanged blocks' underlying Y.Text instance untouched", () => {
    const doc = new Y.Doc();
    createBlock(doc, "b1", { type: "paragraph", text: "unchanged" });
    createBlock(doc, "b2", { type: "paragraph", text: "old text" });
    const snapshot = serializeDocument(doc);
    const originalYText = getBlockText(doc, "b1");

    setBlockChecked(doc, "b2", true); // simulate a later live edit
    doc.transact(() => getBlockText(doc, "b2")!.insert(0, "prefix "));

    restoreBlocksFromSnapshot(doc, snapshot);

    expect(getBlockText(doc, "b1")).toBe(originalYText);
    expect(serializeDocument(doc).map((b) => ({ id: b.id, text: b.text, checked: b.checked }))).toEqual([
      { id: "b1", text: "unchanged", checked: false },
      { id: "b2", text: "old text", checked: false },
    ]);
  });

  it("recreates a block that was deleted after the snapshot was taken", () => {
    const doc = new Y.Doc();
    createBlock(doc, "b1", { type: "paragraph", text: "first" });
    createBlock(doc, "b2", { type: "paragraph", text: "second" });
    const snapshot = serializeDocument(doc);

    deleteBlock(doc, "b2");
    expect(serializeDocument(doc)).toHaveLength(1);

    restoreBlocksFromSnapshot(doc, snapshot);

    expect(serializeDocument(doc).map((b) => b.id)).toEqual(["b1", "b2"]);
  });

  it("deletes a block that was created after the snapshot was taken", () => {
    const doc = new Y.Doc();
    createBlock(doc, "b1", { type: "paragraph", text: "first" });
    const snapshot = serializeDocument(doc);

    createBlock(doc, "b2", { type: "paragraph", text: "added later" });
    expect(serializeDocument(doc)).toHaveLength(2);

    restoreBlocksFromSnapshot(doc, snapshot);

    expect(serializeDocument(doc).map((b) => b.id)).toEqual(["b1"]);
  });

  it("restores order when blocks were reordered after the snapshot", () => {
    const doc = new Y.Doc();
    createBlock(doc, "b1", { type: "paragraph", text: "a" });
    createBlock(doc, "b2", { type: "paragraph", text: "b" });
    createBlock(doc, "b3", { type: "paragraph", text: "c" });
    const snapshot = serializeDocument(doc);

    // Reorder in place (not delete+recreate) so this exercises the "same
    // block, different position" path rather than restoreBlocksFromSnapshot's
    // recreate-on-move fallback.
    doc.transact(() => {
      const root = getRootOrder(doc);
      root.delete(0, root.length);
      root.push(["b3", "b1", "b2"]);
    });
    expect(serializeDocument(doc).map((b) => b.id)).toEqual(["b3", "b1", "b2"]);

    restoreBlocksFromSnapshot(doc, snapshot);

    expect(serializeDocument(doc).map((b) => b.id)).toEqual(["b1", "b2", "b3"]);
  });
});
