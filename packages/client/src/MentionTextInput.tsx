import { useRef, useState } from "react";

/** Matches an "@partial-email" run trailing right up to the caret — must be
 *  preceded by start-of-string or whitespace so "foo@bar" mid-word (already a
 *  complete address, or just a stray @) doesn't keep re-triggering. */
const TRAILING_MENTION_PATTERN = /(?:^|\s)@([A-Za-z0-9._%+-]*)$/;

/**
 * A plain text `<input>` with `@`-triggered autocomplete layered on top —
 * suggests only `candidates` (a page's actual collaborators, from `GET
 * /pages/:id/roles`), not a global user search, so it stays fast and never
 * leaks who else exists on the system.
 */
export function MentionTextInput({
  value,
  onChange,
  onSubmit,
  candidates,
  placeholder,
  style,
}: {
  value: string;
  onChange: (next: string) => void;
  onSubmit: () => void;
  candidates: string[];
  placeholder?: string;
  style?: React.CSSProperties;
}) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const caret = inputRef.current?.selectionStart ?? value.length;
  const match = open ? TRAILING_MENTION_PATTERN.exec(value.slice(0, caret)) : null;
  const query = match?.[1] ?? "";
  const filtered = match
    ? candidates.filter((email) => email.toLowerCase().includes(query.toLowerCase())).slice(0, 6)
    : [];

  function selectCandidate(email: string) {
    if (!match) return;
    const start = caret - match[0].length + (match[0].startsWith("@") ? 0 : 1);
    const next = `${value.slice(0, start)}@${email} ${value.slice(caret)}`;
    onChange(next);
    setOpen(false);
    requestAnimationFrame(() => {
      const pos = start + email.length + 2;
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(pos, pos);
    });
  }

  return (
    <div style={{ position: "relative", flex: 1 }}>
      <input
        ref={inputRef}
        style={{ width: "100%", ...style }}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (filtered.length > 0) {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setHighlight((h) => Math.min(h + 1, filtered.length - 1));
              return;
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setHighlight((h) => Math.max(h - 1, 0));
              return;
            }
            if (e.key === "Enter" || e.key === "Tab") {
              e.preventDefault();
              selectCandidate(filtered[highlight]);
              return;
            }
            if (e.key === "Escape") {
              setOpen(false);
              return;
            }
          }
          if (e.key === "Enter") onSubmit();
        }}
        placeholder={placeholder}
      />
      {filtered.length > 0 && (
        <div className="mention-menu">
          {filtered.map((email, i) => (
            <button
              key={email}
              type="button"
              className={`mention-menu-item${i === highlight ? " active" : ""}`}
              onMouseEnter={() => setHighlight(i)}
              onClick={() => selectCandidate(email)}
            >
              {email}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
