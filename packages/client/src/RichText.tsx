import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from "react";
import * as Y from "yjs";
import { computeTextDiff, type DeltaOp } from "@collab/shared";
import { buildDeltaDom } from "./deltaDom.js";
import { getCaretCharOffset, getSelectionCharRange, setCaretCharOffset, getOffsetClientRect } from "./caret.js";
import { registerBlockElement, consumePendingFocus } from "./blockFocus.js";

function formatActiveOverRange(delta: DeltaOp[], attr: "bold" | "italic", start: number, end: number): boolean {
  let pos = 0;
  let touchedAny = false;
  for (const op of delta) {
    const len = op.insert.length;
    if (pos < end && pos + len > start) {
      touchedAny = true;
      if (!op.attributes?.[attr]) return false;
    }
    pos += len;
    if (pos >= end) break;
  }
  return touchedAny;
}

/**
 * Real (not fake) rich text: formatting is stored as Y.Text attribute
 * ranges via `format()`, the same CRDT-native mechanism Yjs's own
 * Quill/ProseMirror bindings use — not a client-only cosmetic layer. A
 * plain `<input>` can't render partial bold/italic within its value, so
 * block text is a `contentEditable` div here, with the DOM content
 * generated from `ytext.toDelta()` on every render.
 *
 * Takes a `Y.Text` directly rather than a block id — this is what lets the
 * exact same editing/formatting/cursor machinery bind to a page's title
 * (`doc.getText("title")`, not a block at all) as well as to block text.
 * Everything block-specific (split/merge/indent/arrow-nav) lives one level
 * up, in `keyboard.ts` and the caller's `onKeyDown`, not in here.
 *
 * Cursor position across a re-render (which happens on every keystroke,
 * local or remote) is tracked via `Y.RelativePosition`, not a raw character
 * index: a raw index would drift wrong the instant a concurrent remote
 * edit inserts/deletes text before the caret, which relative positions are
 * specifically designed to stay correct through.
 */
export interface PeerCursor {
  offset: number;
  color: string;
  name: string;
}

export function RichText({
  doc,
  ytext,
  style,
  className,
  registryId,
  placeholder,
  peerCursors,
  onFocusOffset,
  onBlur,
  onKeyDown,
}: {
  doc: Y.Doc;
  ytext: Y.Text;
  style?: CSSProperties;
  className?: string;
  /** Registers this block's container in `blockFocus`'s DOM registry, so
   *  arrow-key navigation from another block can find it. Omitted for
   *  bindings (e.g. the title) that aren't a navigable block themselves. */
  registryId?: string;
  placeholder?: string;
  /** Other users' cursors currently anchored to *this* block, rendered as an
   *  inline caret + name flag at their exact character offset — never a
   *  background fill across the whole block (see App.tsx's BlockRow, which
   *  is what actually knows who's editing which block). */
  peerCursors?: PeerCursor[];
  onFocusOffset: (offset: number) => void;
  onBlur: () => void;
  onKeyDown?: (e: ReactKeyboardEvent<HTMLDivElement>) => void;
}) {
  const divRef = useRef<HTMLDivElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const relPosRef = useRef<Y.RelativePosition | null>(null);
  const focusedRef = useRef(false);
  // Set right before a transact caused by our own `handleInput`, so the
  // layout effect below knows the browser's native edit already matches the
  // new content and skips rebuilding the DOM from it — see deltaDom.ts for
  // why rebuilding on every local keystroke would duplicate what was typed.
  const skipNextDomSyncRef = useRef(false);
  // Bumped only when the underlying Y.Text content actually changes (local
  // edit or remote), never by a selection-only update — see the caret-restore
  // effect below, which depends on this instead of running after every
  // render, specifically so it doesn't clobber an in-progress drag selection.
  const [docVersion, setDocVersion] = useState(0);
  const [selection, setSelection] = useState<{ start: number; end: number } | null>(null);
  const [peerRects, setPeerRects] = useState<
    Array<{ left: number; top: number; height: number; color: string; name: string }>
  >([]);

  useEffect(() => {
    const handler = () => setDocVersion((n) => n + 1);
    ytext.observe(handler);
    return () => ytext.unobserve(handler);
  }, [ytext]);

  // A stable string key (not the array reference, which BlockRow rebuilds
  // every render) so this only recomputes when a peer's actual position,
  // color, or name changes.
  const peerCursorsKey = (peerCursors ?? []).map((p) => `${p.offset}:${p.color}:${p.name}`).join("|");

  useLayoutEffect(() => {
    const container = divRef.current;
    const wrapper = wrapperRef.current;
    if (!container || !wrapper || !peerCursors || peerCursors.length === 0) {
      setPeerRects((prev) => (prev.length === 0 ? prev : []));
      return;
    }
    const wrapperRect = wrapper.getBoundingClientRect();
    const next = peerCursors
      .map((p) => {
        const rect = getOffsetClientRect(container, p.offset);
        if (!rect) return null;
        return {
          left: rect.left - wrapperRect.left,
          top: rect.top - wrapperRect.top,
          height: rect.height || 18,
          color: p.color,
          name: p.name,
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);
    setPeerRects(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docVersion, peerCursorsKey]);

  // The native `select` event (what React's onSelect prop maps to) is not
  // reliably dispatched for contentEditable elements across every selection
  // method — Cmd/Ctrl+A and some mouse-drag paths don't fire it in all
  // browsers, only for <input>/<textarea> is it dependable. `selectionchange`
  // on `document` is the one event that fires for every way a selection can
  // change, contentEditable included; filtering to "am I focused" keeps this
  // from reacting to selection changes in some other block or the page at
  // large.
  useEffect(() => {
    function onSelectionChange() {
      if (focusedRef.current) handleSelect();
    }
    document.addEventListener("selectionchange", onSelectionChange);
    return () => document.removeEventListener("selectionchange", onSelectionChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ytext]);

  const delta = ytext.toDelta() as DeltaOp[];

  // Handles two distinct reasons to move the caret: a pending focus request
  // from a split/merge targeting this exact Y.Text (checked first — it wins
  // over caret restoration, since there's nothing to "restore" for a block
  // that wasn't focused a moment ago), or restoring position across a
  // content-driven re-render. `useLayoutEffect` always runs once on mount
  // regardless of its dependency array (deps only gate re-runs on updates),
  // which is what makes a single effect enough to cover both "a brand-new
  // block mounting with a pending focus request already queued" and "an
  // existing block's content changed and docVersion bumped." Depends on
  // docVersion (content changes only), not "every render" — a render
  // triggered solely by setSelection (e.g. mid-drag, or after a click) must
  // NOT run this, or it would collapse the very selection the user just
  // made back down to a single point.
  useLayoutEffect(() => {
    if (!divRef.current) return;
    if (skipNextDomSyncRef.current) {
      skipNextDomSyncRef.current = false;
    } else {
      divRef.current.replaceChildren(...buildDeltaDom(ytext.toDelta() as DeltaOp[]));
    }
    const pendingOffset = consumePendingFocus(ytext);
    if (pendingOffset !== null) {
      divRef.current.focus();
      setCaretCharOffset(divRef.current, pendingOffset);
      focusedRef.current = true;
      relPosRef.current = Y.createRelativePositionFromTypeIndex(ytext, pendingOffset);
      return;
    }
    if (!focusedRef.current || !relPosRef.current) return;
    const abs = Y.createAbsolutePositionFromRelativePosition(relPosRef.current, doc);
    if (abs) setCaretCharOffset(divRef.current, abs.index);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docVersion, ytext]);

  function saveCaretAsRelativePosition() {
    if (!divRef.current) return;
    const offset = getCaretCharOffset(divRef.current);
    if (offset === null) return;
    relPosRef.current = Y.createRelativePositionFromTypeIndex(ytext, offset);
  }

  function handleInput() {
    if (!divRef.current) return;
    const newText = divRef.current.textContent ?? "";
    const oldText = ytext.toString();
    const diff = computeTextDiff(oldText, newText);
    const caretOffsetAfterEdit = diff.start + diff.insertText.length;

    if (diff.deleteCount > 0 || diff.insertText.length > 0) {
      skipNextDomSyncRef.current = true;
      doc.transact(() => {
        if (diff.deleteCount > 0) ytext.delete(diff.start, diff.deleteCount);
        if (diff.insertText.length > 0) ytext.insert(diff.start, diff.insertText);
      });
    }

    relPosRef.current = Y.createRelativePositionFromTypeIndex(ytext, caretOffsetAfterEdit);
    onFocusOffset(caretOffsetAfterEdit);
  }

  function handleSelect() {
    if (!divRef.current) return;
    saveCaretAsRelativePosition();
    const range = getSelectionCharRange(divRef.current);
    setSelection(range && range.end > range.start ? range : null);
    const offset = getCaretCharOffset(divRef.current);
    if (offset !== null) onFocusOffset(offset);
  }

  function toggleFormat(attr: "bold" | "italic") {
    if (!selection) return;
    const active = formatActiveOverRange(ytext.toDelta() as DeltaOp[], attr, selection.start, selection.end);
    doc.transact(() => {
      ytext.format(selection.start, selection.end - selection.start, { [attr]: active ? null : true });
    });
  }

  function addLink() {
    if (!selection) return;
    const url = window.prompt("Link URL:");
    if (!url) return;
    doc.transact(() => {
      ytext.format(selection.start, selection.end - selection.start, { link: url });
    });
  }

  const activeBold = selection ? formatActiveOverRange(delta, "bold", selection.start, selection.end) : false;
  const activeItalic = selection ? formatActiveOverRange(delta, "italic", selection.start, selection.end) : false;

  return (
    <div ref={wrapperRef} style={{ position: "relative", flex: 1, minWidth: 0 }}>
      {peerRects.map((r, i) => (
        <span
          key={i}
          className="peer-cursor"
          style={{ left: r.left, top: r.top, height: r.height, ["--peer-color" as string]: r.color } as CSSProperties}
        >
          <span className="peer-cursor-bar" />
          <span className="peer-cursor-flag">{r.name}</span>
        </span>
      ))}
      {selection && (
        <div
          style={{
            position: "absolute",
            top: "-1.9rem",
            left: 0,
            display: "flex",
            gap: "0.2rem",
            background: "var(--color-surface)",
            border: "1px solid var(--color-border-strong)",
            borderRadius: 4,
            padding: "0.15rem",
            zIndex: 10,
            boxShadow: "0 1px 4px rgba(0,0,0,0.15)",
          }}
        >
          <button
            aria-label="bold"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => toggleFormat("bold")}
            style={{ fontWeight: 700, background: activeBold ? "var(--color-accent)" : undefined, color: activeBold ? "white" : undefined }}
          >
            B
          </button>
          <button
            aria-label="italic"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => toggleFormat("italic")}
            style={{ fontStyle: "italic", background: activeItalic ? "var(--color-accent)" : undefined, color: activeItalic ? "white" : undefined }}
          >
            I
          </button>
          <button aria-label="link" onMouseDown={(e) => e.preventDefault()} onClick={addLink}>
            Link
          </button>
        </div>
      )}
      <div
        ref={(el) => {
          divRef.current = el;
          if (registryId) registerBlockElement(registryId, el);
        }}
        contentEditable
        suppressContentEditableWarning
        data-placeholder={delta.length === 0 ? placeholder : undefined}
        className={className ? `rich-text ${className}` : "rich-text"}
        style={{
          outline: "none",
          borderRadius: 4,
          padding: "0.1rem 0.2rem",
          minHeight: "1.4em",
          ...style,
        }}
        onInput={handleInput}
        onFocus={() => {
          focusedRef.current = true;
          handleSelect();
        }}
        onBlur={() => {
          focusedRef.current = false;
          setSelection(null);
          onBlur();
        }}
        onKeyDown={onKeyDown}
      />
    </div>
  );
}
