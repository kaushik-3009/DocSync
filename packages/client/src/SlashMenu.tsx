import type { BlockType } from "@collab/shared";
import { BLOCK_TYPE_OPTIONS } from "./blockTypes.js";

/**
 * Inline "type / to insert a block type" menu — the seamless document's
 * replacement for a persistent block-type dropdown. Purely presentational:
 * `BlockRow` owns the query string (derived from the block's own text, which
 * is already reactive), the highlighted index, and what happens on commit;
 * this component only renders the filtered list and reports clicks.
 */
export function SlashMenu({
  query,
  highlightIndex,
  onSelect,
}: {
  query: string;
  highlightIndex: number;
  onSelect: (type: BlockType) => void;
}) {
  const filtered = filterBlockTypeOptions(query);

  if (filtered.length === 0) {
    return (
      <div className="slash-menu">
        <div className="slash-menu-empty">No matching block type</div>
      </div>
    );
  }

  return (
    <div className="slash-menu">
      {filtered.map((opt, i) => (
        <button
          key={opt.type}
          type="button"
          className={`slash-menu-item${i === highlightIndex ? " active" : ""}`}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onSelect(opt.type)}
        >
          <span className="slash-menu-icon">{opt.icon}</span>
          {opt.label}
        </button>
      ))}
    </div>
  );
}

export function filterBlockTypeOptions(query: string): typeof BLOCK_TYPE_OPTIONS {
  const q = query.trim().toLowerCase();
  if (!q) return BLOCK_TYPE_OPTIONS;
  return BLOCK_TYPE_OPTIONS.filter((opt) => opt.label.toLowerCase().includes(q) || opt.type.includes(q));
}
