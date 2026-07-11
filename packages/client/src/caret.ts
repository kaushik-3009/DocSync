/**
 * Plain DOM/Selection helpers for translating between a `contentEditable`
 * div's caret and a character offset into its text content. Shared by
 * `RichText` (which owns the text-editing side) and `keyboard.ts` (which
 * needs a block's current caret offset/position for split/merge/arrow-key
 * decisions) so there's exactly one implementation of "what character
 * offset is the caret at" in the app.
 */

export function getCaretCharOffset(container: HTMLElement): number | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!container.contains(range.startContainer)) return null;
  const preRange = range.cloneRange();
  preRange.selectNodeContents(container);
  preRange.setEnd(range.startContainer, range.startOffset);
  return preRange.toString().length;
}

export function getSelectionCharRange(container: HTMLElement): { start: number; end: number } | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!container.contains(range.startContainer) || !container.contains(range.endContainer)) return null;

  const startRange = range.cloneRange();
  startRange.selectNodeContents(container);
  startRange.setEnd(range.startContainer, range.startOffset);
  const start = startRange.toString().length;

  const endRange = range.cloneRange();
  endRange.selectNodeContents(container);
  endRange.setEnd(range.endContainer, range.endOffset);
  const end = endRange.toString().length;

  return start <= end ? { start, end } : { start: end, end: start };
}

export function setCaretCharOffset(container: HTMLElement, offset: number): void {
  const selection = window.getSelection();
  if (!selection) return;
  let remaining = Math.max(0, offset);
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  let lastTextNode: Node | null = null;
  while ((node = walker.nextNode())) {
    lastTextNode = node;
    const len = node.textContent?.length ?? 0;
    if (remaining <= len) {
      const range = document.createRange();
      range.setStart(node, remaining);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }
    remaining -= len;
  }
  const range = document.createRange();
  if (lastTextNode) range.setStart(lastTextNode, lastTextNode.textContent?.length ?? 0);
  else range.selectNodeContents(container);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

/** The bounding rect a caret placed at `offset` *would* have, without moving
 *  the actual selection — unlike `setCaretCharOffset`, this never touches
 *  `window.getSelection()`, so it's safe to call for positions that belong
 *  to someone else entirely (a remote peer's cursor, rendered as an inline
 *  overlay by `RichText`). Returns null for a container with no text nodes. */
export function getOffsetClientRect(container: HTMLElement, offset: number): DOMRect | null {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  let remaining = Math.max(0, offset);
  let lastTextNode: Node | null = null;
  while ((node = walker.nextNode())) {
    lastTextNode = node;
    const len = node.textContent?.length ?? 0;
    if (remaining <= len) {
      const range = document.createRange();
      range.setStart(node, remaining);
      range.collapse(true);
      return range.getBoundingClientRect();
    }
    remaining -= len;
  }
  if (lastTextNode) {
    const range = document.createRange();
    range.setStart(lastTextNode, lastTextNode.textContent?.length ?? 0);
    range.collapse(true);
    return range.getBoundingClientRect();
  }
  return null;
}

/** The caret's own bounding rect (zero-width, at its exact screen position),
 *  or null if there's no caret in `container` right now. */
export function getCaretClientRect(container: HTMLElement): DOMRect | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!container.contains(range.startContainer)) return null;
  const rects = range.getClientRects();
  return rects[0] ?? range.getBoundingClientRect();
}

/** One rect per visual line of `container`'s content — wrapping included,
 *  literal newlines aside. Empty for an empty container. */
function getVisualLineRects(container: HTMLElement): DOMRect[] {
  const range = document.createRange();
  range.selectNodeContents(container);
  return Array.from(range.getClientRects());
}

/** Is the caret on the container's first visual line? Deliberately not
 *  "does the text above the caret contain a newline" — contentEditable
 *  wraps by default, so a single long paragraph is routinely multi-line
 *  with zero literal newlines in it. */
export function isCaretAtFirstVisualLine(container: HTMLElement): boolean {
  const caretRect = getCaretClientRect(container);
  const lineRects = getVisualLineRects(container);
  if (!caretRect || lineRects.length === 0) return true;
  const firstLineTop = Math.min(...lineRects.map((r) => r.top));
  return Math.abs(caretRect.top - firstLineTop) < 4;
}

export function isCaretAtLastVisualLine(container: HTMLElement): boolean {
  const caretRect = getCaretClientRect(container);
  const lineRects = getVisualLineRects(container);
  if (!caretRect || lineRects.length === 0) return true;
  const lastLineTop = Math.max(...lineRects.map((r) => r.top));
  return Math.abs(caretRect.top - lastLineTop) < 4;
}

/** Cross-browser wrapper for the two DOM APIs that turn a screen point into
 *  a text position — Chrome/Safari have `caretRangeFromPoint`, Firefox has
 *  `caretPositionFromPoint`. Used to preserve horizontal column position when
 *  moving the caret into a different block via Arrow Up/Down. */
function caretRangeFromPoint(x: number, y: number): Range | null {
  const doc = document as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  };
  if (doc.caretRangeFromPoint) return doc.caretRangeFromPoint(x, y);
  if (doc.caretPositionFromPoint) {
    const pos = doc.caretPositionFromPoint(x, y);
    if (!pos) return null;
    const range = document.createRange();
    range.setStart(pos.offsetNode, pos.offset);
    range.collapse(true);
    return range;
  }
  return null;
}

/** Focuses `container` and places the caret at the given horizontal column
 *  (`x`, in viewport coordinates), on its first line if `atEnd` is false or
 *  its last line if true — the "arrived from the block above/below, keep my
 *  horizontal position" behavior real editors have. Falls back to the very
 *  start/end of the block if the point APIs are unavailable or land outside
 *  the container (e.g. `x` past the end of a shorter line). */
export function focusAtColumn(container: HTMLElement, x: number, atEnd: boolean): void {
  container.focus();
  const rect = container.getBoundingClientRect();
  const y = atEnd ? rect.bottom - 4 : rect.top + 4;
  const range = caretRangeFromPoint(x, y);
  const selection = window.getSelection();
  if (range && container.contains(range.startContainer) && selection) {
    selection.removeAllRanges();
    selection.addRange(range);
    return;
  }
  setCaretCharOffset(container, atEnd ? container.textContent?.length ?? 0 : 0);
}
