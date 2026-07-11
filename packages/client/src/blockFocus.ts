import type * as Y from "yjs";

/**
 * Two small module-level registries that let cross-block operations (split,
 * merge, arrow-key navigation) work without prop-drilling a "focus this
 * block" callback through every level of the recursive block tree.
 *
 * Keyed by `Y.Text` reference, not block id: the caller performing a split
 * or merge already has the target's `Y.Text` in hand (it just created or
 * appended to it), and reference identity survives exactly as long as the
 * DOM node it's paired with does — a block id string would work too, but
 * would need a second lookup back into the blocks map for no benefit.
 */

let pendingFocus: { ytext: Y.Text; offset: number } | null = null;

/** Called by a mutation (split/merge) right after changing the doc, to say
 *  "once the block bound to this Y.Text is on screen, put the caret here." */
export function requestFocus(ytext: Y.Text, offset: number): void {
  pendingFocus = { ytext, offset };
}

/** Called by `RichText` on mount and on every content change; returns the
 *  requested offset (and clears the request) if this is the Y.Text someone
 *  asked to focus, or null otherwise. */
export function consumePendingFocus(ytext: Y.Text): number | null {
  if (pendingFocus && pendingFocus.ytext === ytext) {
    const offset = pendingFocus.offset;
    pendingFocus = null;
    return offset;
  }
  return null;
}

const blockElements = new Map<string, HTMLElement>();

/** `RichText`'s container ref callback registers/unregisters itself here so
 *  arrow-key navigation can find "the DOM node for block X" without walking
 *  React refs through every intermediate BlockRow. */
export function registerBlockElement(blockId: string, el: HTMLElement | null): void {
  if (el) blockElements.set(blockId, el);
  else blockElements.delete(blockId);
}

export function getBlockElement(blockId: string): HTMLElement | undefined {
  return blockElements.get(blockId);
}
