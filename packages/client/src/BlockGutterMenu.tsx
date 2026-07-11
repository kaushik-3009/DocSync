import { useEffect, useRef, useState } from "react";
import type { BlockType } from "@collab/shared";
import { BLOCK_TYPE_OPTIONS } from "./blockTypes.js";

/**
 * The "⋮" popover in a block's hover gutter — change type, toggle comments,
 * delete. Replaces what used to be a permanently-visible `<select>` plus two
 * permanently-visible buttons on every row; those affordances are needed
 * occasionally, not constantly, so they only render while this is open.
 */
export function BlockGutterMenu({
  commentCount,
  onChangeType,
  onToggleComments,
  onDelete,
}: {
  commentCount: number;
  onChangeType: (type: BlockType) => void;
  onToggleComments: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  return (
    <div className="block-gutter-menu-root" ref={rootRef}>
      <button
        type="button"
        aria-label="block options"
        className="block-gutter-btn"
        onClick={() => setOpen((v) => !v)}
      >
        ⋮
      </button>
      {open && (
        <div className="type-menu">
          <div className="type-menu-section-label">Turn into</div>
          {BLOCK_TYPE_OPTIONS.map((opt) => (
            <button
              key={opt.type}
              type="button"
              className="type-menu-item"
              onClick={() => {
                onChangeType(opt.type);
                setOpen(false);
              }}
            >
              <span className="slash-menu-icon">{opt.icon}</span>
              {opt.label}
            </button>
          ))}
          <div className="type-menu-divider" />
          <button
            type="button"
            className="type-menu-item"
            onClick={() => {
              onToggleComments();
              setOpen(false);
            }}
          >
            💬 Comments{commentCount > 0 ? ` (${commentCount})` : ""}
          </button>
          <button
            type="button"
            className="type-menu-item type-menu-item-danger"
            onClick={() => {
              onDelete();
              setOpen(false);
            }}
          >
            🗑 Delete
          </button>
        </div>
      )}
    </div>
  );
}
