import type * as Y from "yjs";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { splitBlock, mergeBlockIntoPrevious, indentBlock, outdentBlock, getBlockText } from "@collab/shared";
import { getCaretCharOffset, isCaretAtFirstVisualLine, isCaretAtLastVisualLine, getCaretClientRect, focusAtColumn } from "./caret.js";
import { requestFocus, getBlockElement } from "./blockFocus.js";

export interface BlockKeyDownContext {
  doc: Y.Doc;
  blockId: string;
  container: HTMLElement;
  /** Adjacent ids in reading order (depth-first, from `flattenBlockIds`) —
   *  undefined at the very start/end of the document. */
  prevBlockId: string | undefined;
  nextBlockId: string | undefined;
}

/**
 * The single place that owns "what does pressing this key do to a block" for
 * the seamless document — Enter splits, Backspace-at-start merges into the
 * previous block, Arrow Up/Down at a visual line boundary moves into the
 * adjacent block, Tab/Shift+Tab indent/outdent. One ordered list of checks
 * here (rather than each behavior scattered across components) is what lets
 * "Enter never also indents" etc. stay true without every caller re-deriving
 * the precedence.
 *
 * Intentionally does *not* handle the slash-command menu — that has its own
 * open/highlighted-index state living in `BlockRow`, which checks for it
 * before ever calling this, since an open menu redirects Up/Down/Enter to
 * navigating the menu instead of the document.
 */
export function handleBlockKeyDown(e: ReactKeyboardEvent, ctx: BlockKeyDownContext): void {
  if (e.key === "Tab") {
    e.preventDefault();
    if (e.shiftKey) outdentBlock(ctx.doc, ctx.blockId);
    else indentBlock(ctx.doc, ctx.blockId);
    return;
  }

  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    const offset = getCaretCharOffset(ctx.container) ?? 0;
    const newBlockId = crypto.randomUUID();
    if (splitBlock(ctx.doc, ctx.blockId, offset, newBlockId)) {
      const newYText = getBlockText(ctx.doc, newBlockId);
      if (newYText) requestFocus(newYText, 0);
    }
    return;
  }

  if (e.key === "Backspace") {
    const selection = window.getSelection();
    const offset = getCaretCharOffset(ctx.container);
    if (offset === 0 && (selection?.isCollapsed ?? true)) {
      e.preventDefault();
      const result = mergeBlockIntoPrevious(ctx.doc, ctx.blockId);
      if (result) {
        const survivingYText = getBlockText(ctx.doc, result.survivingBlockId);
        if (survivingYText) requestFocus(survivingYText, result.joinOffset);
      }
    }
    return;
  }

  if (e.key === "ArrowUp" || e.key === "ArrowDown") {
    const goingUp = e.key === "ArrowUp";
    const atBoundary = goingUp ? isCaretAtFirstVisualLine(ctx.container) : isCaretAtLastVisualLine(ctx.container);
    if (!atBoundary) return;
    const targetId = goingUp ? ctx.prevBlockId : ctx.nextBlockId;
    if (!targetId) return;
    const targetEl = getBlockElement(targetId);
    if (!targetEl) return;
    e.preventDefault();
    const caretRect = getCaretClientRect(ctx.container);
    const x = caretRect ? caretRect.left : targetEl.getBoundingClientRect().left;
    // Moving up lands on the target's *last* line (arriving from below);
    // moving down lands on its *first* line (arriving from above).
    focusAtColumn(targetEl, x, goingUp);
  }
}
