/**
 * Yjs's own delta shape (matches Quill's convention) — `Y.Text.toDelta()`
 * returns this even though the yjs types expose it as `any`. Shared so both
 * the live editor (`RichText`), the block mutators that need to inspect
 * formatted text (`splitBlock`, `restoreBlocksFromSnapshot`), and read-only
 * renderers (version history preview) use one definition instead of two that
 * can drift apart.
 */
export interface DeltaOp {
  insert: string;
  attributes?: { bold?: boolean; italic?: boolean; link?: string };
}

/**
 * Smallest edit that turns `oldText` into `newText` — a common-prefix /
 * common-suffix diff, not a full text replace. This matters for rich text
 * specifically: replacing the whole string on every change would wipe every
 * formatting attribute on untouched characters, since Y.Text attributes live
 * on ranges of the deleted/reinserted content. Touching only the changed
 * middle section leaves surrounding formatted ranges alone.
 */
export function computeTextDiff(
  oldText: string,
  newText: string
): { start: number; deleteCount: number; insertText: string } {
  let start = 0;
  const maxPrefix = Math.min(oldText.length, newText.length);
  while (start < maxPrefix && oldText[start] === newText[start]) start++;

  let oldEnd = oldText.length;
  let newEnd = newText.length;
  while (oldEnd > start && newEnd > start && oldText[oldEnd - 1] === newText[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }

  return { start, deleteCount: oldEnd - start, insertText: newText.slice(start, newEnd) };
}
