import * as Y from "yjs";
import { getCommentsMap } from "./comments.js";
import { computeTextDiff, type DeltaOp } from "./delta.js";

/**
 * Block-tree document shape (all state lives inside a single Y.Doc per page):
 *
 *   doc.getMap("blocks")       Y.Map<blockId, Y.Map<BlockFields>>
 *   doc.getArray("root")       Y.Array<blockId>   — top-level block order
 *
 * Each block is its own Y.Map so that inserting/editing/reordering one block
 * never touches the Yjs state of any other block — that's what makes blocks
 * "independently syncable" and keeps future per-block features (Phase 2
 * snapshots, Phase 6 search indexing) cheap: you can diff/snapshot/index one
 * block's Y.Map without walking the whole document.
 *
 * Nesting: every block's `children` field (a `Y.Array<string>`, present
 * since Phase 1 but unused until now) holds the ids of blocks indented
 * under it, forming a real tree — `root` is just the depth-0 level of that
 * same tree, not a separate concept. A block's *current* parent (root, or
 * some other block's `children` array) is never stored on the block itself;
 * `findLocation` below finds it by walking the tree, since nothing else in
 * this app needs "who is my parent" often enough to justify keeping a
 * second, invalidatable pointer in sync with the arrays that are the actual
 * source of truth.
 */

export type BlockType = "paragraph" | "heading" | "todo" | "bullet" | "canvas" | "code";

export type CodeLanguage = "javascript" | "python" | "plaintext";

export interface BlockFieldsInit {
  type: BlockType;
  text?: string;
}

const BLOCKS_KEY = "blocks";
const ROOT_KEY = "root";

export function getBlocksMap(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return doc.getMap(BLOCKS_KEY);
}

export function getRootOrder(doc: Y.Doc): Y.Array<string> {
  return doc.getArray(ROOT_KEY);
}

export function getBlockChildren(doc: Y.Doc, blockId: string): Y.Array<string> | undefined {
  const block = getBlocksMap(doc).get(blockId);
  return block?.get("children") as Y.Array<string> | undefined;
}

/** Builds a block's `Y.Map` without touching any order array — shared by
 *  `createBlock` (which appends it to root) and `restoreBlocksFromSnapshot`/
 *  `splitBlock` (which need to prepare the `Y.Text` — e.g. via `applyDelta`
 *  — before the map exists, since a `Y.Map.get()` on an unintegrated map
 *  reads from the CRDT-backed `_map`, not the `_prelimContent` a `.set()`
 *  before integration writes to, and returns `undefined` for anything set
 *  that way). Pass `presetText` when the caller needs to build up the
 *  `Y.Text` itself (e.g. from a delta) rather than a plain string. */
function createBlockMap(init: BlockFieldsInit, presetText?: Y.Text): Y.Map<unknown> {
  const block = new Y.Map<unknown>();
  block.set("type", init.type);
  block.set("checked", false);
  block.set("language", "javascript");
  block.set("children", new Y.Array<string>());
  const text = presetText ?? new Y.Text();
  if (!presetText && init.text) text.insert(0, init.text);
  block.set("text", text);
  return block;
}

/** Creates a block's Y.Map and appends it to the root order, inside one transaction. */
export function createBlock(
  doc: Y.Doc,
  blockId: string,
  init: BlockFieldsInit,
  index?: number
): void {
  doc.transact(() => {
    getBlocksMap(doc).set(blockId, createBlockMap(init));

    const root = getRootOrder(doc);
    if (index === undefined || index >= root.length) {
      root.push([blockId]);
    } else {
      root.insert(index, [blockId]);
    }
  });
}

export function setBlockType(doc: Y.Doc, blockId: string, type: BlockType): void {
  const block = getBlocksMap(doc).get(blockId);
  if (!block) return;
  doc.transact(() => block.set("type", type));
}

/** Only meaningful for `type: "todo"` blocks, but harmless to set on any type
 *  (mirrors how `text`/`children` exist on every block regardless of type). */
export function setBlockChecked(doc: Y.Doc, blockId: string, checked: boolean): void {
  const block = getBlocksMap(doc).get(blockId);
  if (!block) return;
  doc.transact(() => block.set("checked", checked));
}

/** Only meaningful for `type: "code"` blocks — which syntax highlighting
 *  CodeMirror should use. Stored on the block (like `checked`) rather than
 *  inferred from content, since language can't be reliably guessed from a
 *  few lines of code and the user picks it explicitly from a dropdown. */
export function setBlockLanguage(doc: Y.Doc, blockId: string, language: CodeLanguage): void {
  const block = getBlocksMap(doc).get(blockId);
  if (!block) return;
  doc.transact(() => block.set("language", language));
}

interface BlockLocation {
  /** The Y.Array `blockId` currently lives in — `root`, or some other
   *  block's `children` array. */
  array: Y.Array<string>;
  /** Id of the block that owns `array`, or null if it's the root order. */
  parentBlockId: string | null;
  index: number;
}

/** Finds where a block currently lives by walking the tree — root first
 *  (the overwhelmingly common case, so this is cheap for it), then every
 *  block's `children` array. There's no depth limit: a block nested several
 *  levels deep is still found, just at proportionally more cost. */
function findLocation(doc: Y.Doc, blockId: string): BlockLocation | null {
  const root = getRootOrder(doc);
  const rootIdx = root.toArray().indexOf(blockId);
  if (rootIdx !== -1) return { array: root, parentBlockId: null, index: rootIdx };

  let found: BlockLocation | null = null;
  getBlocksMap(doc).forEach((block, id) => {
    if (found) return;
    const children = block.get("children") as Y.Array<string> | undefined;
    if (!children) return;
    const idx = children.toArray().indexOf(blockId);
    if (idx !== -1) found = { array: children, parentBlockId: id, index: idx };
  });
  return found;
}

/** Makes `blockId` a child of its immediately preceding sibling — the usual
 *  "Tab to indent" gesture. A no-op if there's no preceding sibling (the
 *  first item in whatever list it's in has nothing to become a child of). */
export function indentBlock(doc: Y.Doc, blockId: string): void {
  const loc = findLocation(doc, blockId);
  if (!loc || loc.index === 0) return;
  doc.transact(() => {
    const prevSiblingId = loc.array.get(loc.index - 1);
    const prevSiblingChildren = getBlockChildren(doc, prevSiblingId);
    if (!prevSiblingChildren) return;
    loc.array.delete(loc.index, 1);
    prevSiblingChildren.push([blockId]);
  });
}

/** Moves `blockId` out of its parent's children and back to its parent's own
 *  level, immediately after the (former) parent — "Shift+Tab to outdent". A
 *  no-op if `blockId` is already at the root (nothing to outdent from). */
export function outdentBlock(doc: Y.Doc, blockId: string): void {
  const loc = findLocation(doc, blockId);
  if (!loc || loc.parentBlockId === null) return;
  const parentLoc = findLocation(doc, loc.parentBlockId);
  if (!parentLoc) return;
  doc.transact(() => {
    loc.array.delete(loc.index, 1);
    parentLoc.array.insert(parentLoc.index + 1, [blockId]);
  });
}

/**
 * Splits `blockId`'s text at `offset` into two sibling blocks — the "press
 * Enter mid-paragraph" gesture in a seamless document. `newBlockId` is
 * supplied by the caller (matching `createBlock`'s existing convention of
 * not generating ids itself). Returns false if `blockId` doesn't exist.
 *
 * The straddling delta op is sliced into a kept prefix and a moved suffix,
 * each retaining the original op's attributes, and only the departing
 * suffix is deleted from the original `Y.Text` — never delete-and-reinsert
 * the kept prefix, which would tombstone its underlying CRDT items and
 * orphan any concurrent remote edit anchored inside it (e.g. someone else
 * formatting a word in the prefix at the same instant). See docs/DESIGN.md
 * Section 4.
 */
export function splitBlock(doc: Y.Doc, blockId: string, offset: number, newBlockId: string): boolean {
  const blocksMap = getBlocksMap(doc);
  const block = blocksMap.get(blockId);
  const loc = findLocation(doc, blockId);
  if (!block || !loc) return false;

  const ytext = block.get("text") as Y.Text;
  const total = ytext.length;
  const clampedOffset = Math.max(0, Math.min(offset, total));
  const delta = ytext.toDelta() as DeltaOp[];

  const movedDelta: DeltaOp[] = [];
  let pos = 0;
  for (const op of delta) {
    const opStart = pos;
    const opEnd = pos + op.insert.length;
    if (opEnd > clampedOffset) {
      const sliceStart = Math.max(0, clampedOffset - opStart);
      const text = op.insert.slice(sliceStart);
      if (text) movedDelta.push(op.attributes ? { insert: text, attributes: op.attributes } : { insert: text });
    }
    pos = opEnd;
  }

  doc.transact(() => {
    const newYText = new Y.Text();
    if (movedDelta.length > 0) newYText.applyDelta(movedDelta);
    const newBlock = createBlockMap({ type: block.get("type") as BlockType }, newYText);
    newBlock.set("language", (block.get("language") as CodeLanguage) ?? "javascript");
    blocksMap.set(newBlockId, newBlock);

    if (total - clampedOffset > 0) ytext.delete(clampedOffset, total - clampedOffset);

    loc.array.insert(loc.index + 1, [newBlockId]);
  });

  return true;
}

/** Inserts a brand-new block of `type` immediately after `afterBlockId`, in
 *  whatever array that block currently lives in (root, or a parent's
 *  `children`). Unlike `splitBlock`'s sibling (which always inherits the
 *  split block's own type), this always creates exactly the type asked for
 *  — used when a slash-command converts the current block to a non-text
 *  type (code/canvas) and the caller wants a normal empty paragraph right
 *  after it to keep typing into, not another code/canvas block. Returns
 *  false if `afterBlockId` doesn't exist. */
export function insertBlockAfter(doc: Y.Doc, afterBlockId: string, newBlockId: string, type: BlockType): boolean {
  const loc = findLocation(doc, afterBlockId);
  if (!loc) return false;
  doc.transact(() => {
    getBlocksMap(doc).set(newBlockId, createBlockMap({ type }));
    loc.array.insert(loc.index + 1, [newBlockId]);
  });
  return true;
}

/**
 * Merges `blockId`'s content onto the end of its preceding sibling, then
 * deletes `blockId` — the "Backspace at the start of a block" gesture. A
 * no-op if there's no preceding sibling in `blockId`'s current tree location.
 * Comments anchored to the removed block are reassigned to the surviving
 * block (not discarded), and any children the removed block had are moved
 * onto the surviving block rather than silently dropped. Returns the
 * surviving block's id and the character offset the content was joined at
 * (so the caller can place the caret there), or null if this was a no-op.
 */
export function mergeBlockIntoPrevious(
  doc: Y.Doc,
  blockId: string
): { survivingBlockId: string; joinOffset: number } | null {
  const loc = findLocation(doc, blockId);
  if (!loc || loc.index === 0) return null;

  const blocksMap = getBlocksMap(doc);
  const prevId = loc.array.get(loc.index - 1);
  const prevBlock = blocksMap.get(prevId);
  const block = blocksMap.get(blockId);
  if (!prevBlock || !block) return null;

  const prevYText = prevBlock.get("text") as Y.Text;
  const yText = block.get("text") as Y.Text;
  const joinOffset = prevYText.length;
  const delta = yText.toDelta() as DeltaOp[];

  doc.transact(() => {
    if (delta.length > 0) {
      // `Y.Text.applyDelta` inserts at position 0 by default when the delta
      // doesn't start with a `retain` — without this explicit retain, the
      // merged-in content would land *before* the surviving block's
      // existing text instead of after it.
      prevYText.applyDelta([{ retain: joinOffset }, ...delta]);
    }

    const commentsMap = getCommentsMap(doc);
    commentsMap.forEach((comment) => {
      if (comment.get("blockId") === blockId) comment.set("blockId", prevId);
    });

    const children = getBlockChildren(doc, blockId);
    const prevChildren = getBlockChildren(doc, prevId);
    if (children && prevChildren && children.length > 0) {
      prevChildren.push(children.toArray());
    }

    loc.array.delete(loc.index, 1);
    blocksMap.delete(blockId);
  });

  return { survivingBlockId: prevId, joinOffset };
}

/** Deletes a block, all of its descendants (recursively — otherwise a
 *  deleted parent would leave its former children as unreachable but
 *  still-present entries in `blocksMap`, referenced by no array), and any
 *  comments anchored to any of them. */
export function deleteBlock(doc: Y.Doc, blockId: string): void {
  doc.transact(() => deleteBlockRecursive(doc, blockId));
}

function deleteBlockRecursive(doc: Y.Doc, blockId: string): void {
  const blocksMap = getBlocksMap(doc);
  const childIds = getBlockChildren(doc, blockId)?.toArray() ?? [];
  for (const childId of childIds) deleteBlockRecursive(doc, childId);

  const loc = findLocation(doc, blockId);
  if (loc) loc.array.delete(loc.index, 1);
  blocksMap.delete(blockId);

  const commentsMap = getCommentsMap(doc);
  const orphanedCommentIds: string[] = [];
  commentsMap.forEach((comment, commentId) => {
    if (comment.get("blockId") === blockId) orphanedCommentIds.push(commentId);
  });
  for (const commentId of orphanedCommentIds) commentsMap.delete(commentId);
}

export function getBlockText(doc: Y.Doc, blockId: string): Y.Text | undefined {
  const block = getBlocksMap(doc).get(blockId);
  return block?.get("text") as Y.Text | undefined;
}

export interface SerializedBlock {
  id: string;
  type: BlockType;
  text: string;
  checked: boolean;
  language: CodeLanguage;
  children: SerializedBlock[];
}

function serializeBlock(blocksMap: Y.Map<Y.Map<unknown>>, id: string): SerializedBlock {
  const block = blocksMap.get(id);
  const childIds = (block?.get("children") as Y.Array<string> | undefined)?.toArray() ?? [];
  return {
    id,
    type: (block?.get("type") as BlockType) ?? "paragraph",
    text: (block?.get("text") as Y.Text | undefined)?.toString() ?? "",
    checked: (block?.get("checked") as boolean) ?? false,
    language: (block?.get("language") as CodeLanguage) ?? "javascript",
    children: childIds.map((childId) => serializeBlock(blocksMap, childId)),
  };
}

/** Snapshot helper for tests/debugging/UI rendering — not part of the
 *  sync-critical path. Returns the tree rooted at `root`, not a flat list:
 *  a nested block only appears inside its parent's `children`, matching how
 *  the data is actually structured (see the module doc comment above). */
export function serializeDocument(doc: Y.Doc): SerializedBlock[] {
  const blocksMap = getBlocksMap(doc);
  return getRootOrder(doc)
    .toArray()
    .map((id) => serializeBlock(blocksMap, id));
}

export interface SerializedBlockWithDelta extends Omit<SerializedBlock, "children"> {
  /** The block's formatted content as a Quill/Yjs-style delta — needed
   *  because a version-history preview must render bold/italic/link marks
   *  without instantiating a live `RichText`/`CodeBlock`/`CanvasBlock` bound
   *  to a Y.Doc state that was never actually live (see docs/DESIGN.md
   *  Section 4). `renderDelta()` (packages/client/src/renderDelta.tsx) is
   *  the one renderer both the live editor and this preview share. */
  delta: DeltaOp[];
  children: SerializedBlockWithDelta[];
}

function serializeBlockWithDelta(blocksMap: Y.Map<Y.Map<unknown>>, id: string): SerializedBlockWithDelta {
  const block = blocksMap.get(id);
  const childIds = (block?.get("children") as Y.Array<string> | undefined)?.toArray() ?? [];
  const ytext = block?.get("text") as Y.Text | undefined;
  return {
    id,
    type: (block?.get("type") as BlockType) ?? "paragraph",
    text: ytext?.toString() ?? "",
    delta: ytext ? (ytext.toDelta() as DeltaOp[]) : [],
    checked: (block?.get("checked") as boolean) ?? false,
    language: (block?.get("language") as CodeLanguage) ?? "javascript",
    children: childIds.map((childId) => serializeBlockWithDelta(blocksMap, childId)),
  };
}

/** Same shape as `serializeDocument`, plus each block's raw delta — see
 *  `SerializedBlockWithDelta`. */
export function serializeDocumentWithDeltas(doc: Y.Doc): SerializedBlockWithDelta[] {
  const blocksMap = getBlocksMap(doc);
  return getRootOrder(doc)
    .toArray()
    .map((id) => serializeBlockWithDelta(blocksMap, id));
}

/**
 * Restores the live document's blocks to match a previously-serialized
 * snapshot (e.g. an old version) — diff-and-patch, not clear-and-rebuild.
 * Blocks whose serialized content is unchanged are left completely alone;
 * changed blocks are updated in place (text via the same non-destructive
 * diff `RichText` uses, not delete-all-reinsert); blocks absent from the
 * snapshot are deleted; blocks only in the snapshot are recreated. This
 * keeps the blast radius to what actually differs — clearing everything and
 * rebuilding would replace even *unchanged* blocks' Y.Map/Y.Text instances,
 * silently orphaning any in-flight concurrent edit targeting the old
 * instances (e.g. someone mid-keystroke in a paragraph that didn't change
 * between versions). See docs/DESIGN.md Section 4.
 *
 * A block that *moved* to a different parent between the live doc and the
 * snapshot is recreated fresh at its new location rather than relocated in
 * place — a reasonable simplification for how rarely blocks change parents
 * between versions being restored across.
 */
export function restoreBlocksFromSnapshot(doc: Y.Doc, snapshotBlocks: SerializedBlock[]): void {
  doc.transact(() => {
    const keepIds = new Set<string>();
    collectBlockIds(snapshotBlocks, keepIds);

    const blocksMap = getBlocksMap(doc);
    const staleIds: string[] = [];
    blocksMap.forEach((_, id) => {
      if (!keepIds.has(id)) staleIds.push(id);
    });
    for (const id of staleIds) {
      // A block already removed as a descendant of an earlier deletion in
      // this loop no longer exists — skip it rather than double-delete.
      if (blocksMap.has(id)) deleteBlockRecursive(doc, id);
    }

    restoreOrder(doc, getRootOrder(doc), snapshotBlocks);
  });
}

function collectBlockIds(blocks: SerializedBlock[], out: Set<string>): void {
  for (const b of blocks) {
    out.add(b.id);
    collectBlockIds(b.children, out);
  }
}

function restoreOrder(doc: Y.Doc, liveArray: Y.Array<string>, snapshotBlocks: SerializedBlock[]): void {
  const blocksMap = getBlocksMap(doc);

  for (const snapshotBlock of snapshotBlocks) {
    restoreBlockContent(blocksMap, snapshotBlock);
  }

  // Reconcile order to match the snapshot exactly. Content/children are
  // already restored above, so this only ever moves *where* an id sits.
  const snapshotIds = snapshotBlocks.map((b) => b.id);
  if (liveArray.toArray().join(" ") !== snapshotIds.join(" ")) {
    liveArray.delete(0, liveArray.length);
    liveArray.push(snapshotIds);
  }

  for (const snapshotBlock of snapshotBlocks) {
    const childrenArray = getBlockChildren(doc, snapshotBlock.id);
    if (childrenArray) restoreOrder(doc, childrenArray, snapshotBlock.children);
  }
}

function restoreBlockContent(blocksMap: Y.Map<Y.Map<unknown>>, snapshotBlock: SerializedBlock): void {
  let block = blocksMap.get(snapshotBlock.id);
  if (!block) {
    block = createBlockMap({ type: snapshotBlock.type, text: snapshotBlock.text });
    block.set("checked", snapshotBlock.checked);
    block.set("language", snapshotBlock.language);
    blocksMap.set(snapshotBlock.id, block);
    return;
  }

  const current = serializeBlock(blocksMap, snapshotBlock.id);
  if (current.type !== snapshotBlock.type) block.set("type", snapshotBlock.type);
  if (current.checked !== snapshotBlock.checked) block.set("checked", snapshotBlock.checked);
  if (current.language !== snapshotBlock.language) block.set("language", snapshotBlock.language);
  if (current.text !== snapshotBlock.text) {
    const ytext = block.get("text") as Y.Text;
    const diff = computeTextDiff(current.text, snapshotBlock.text);
    if (diff.deleteCount > 0) ytext.delete(diff.start, diff.deleteCount);
    if (diff.insertText.length > 0) ytext.insert(diff.start, diff.insertText);
  }
}
