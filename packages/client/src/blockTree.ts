import type { SerializedBlock } from "@collab/shared";

/** Depth-first order of every block id in the tree — the order a reader's
 *  eye (and Arrow Up/Down) actually moves through the document in, which is
 *  not the same as "root order": a block's children are visited immediately
 *  after it, before its next sibling. */
export function flattenBlockIds(blocks: SerializedBlock[]): string[] {
  const ids: string[] = [];
  (function walk(list: SerializedBlock[]) {
    for (const block of list) {
      ids.push(block.id);
      walk(block.children);
    }
  })(blocks);
  return ids;
}
