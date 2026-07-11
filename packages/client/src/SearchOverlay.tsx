import { useEffect, useRef, useState } from "react";
import { searchPages, type SearchHit } from "./api.js";

/**
 * A command-palette-style overlay, not a sidebar panel like version history —
 * search is a "jump somewhere else" action, so it should feel transient and
 * keyboard-first rather than parked next to the document. Debounced so
 * typing doesn't fire a request per keystroke; RBAC scoping (which pages a
 * result can even mention) is entirely server-side, this just renders what
 * `GET /search` returns.
 */
export function SearchOverlay({ onNavigate, onClose }: { onNavigate: (pageId: string) => void; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setHits(null);
      setError(null);
      return;
    }
    setHighlight(0);
    const timer = setTimeout(() => {
      // The debounce only delays *scheduling* a request, it doesn't cancel
      // one already in flight — a slower response for an earlier query can
      // still land after a faster one for the current query, overwriting
      // correct results with stale ones. Guard by only applying a response
      // if the query it was for is still current when it resolves.
      searchPages(trimmed)
        .then((res) => {
          if (query.trim() === trimmed) {
            setHits(res.hits);
            setError(null);
          }
        })
        .catch((err) => {
          if (query.trim() === trimmed) setError(err instanceof Error ? err.message : String(err));
        });
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  function select(pageId: string) {
    onNavigate(pageId);
    onClose();
  }

  return (
    <div className="search-overlay" onClick={onClose}>
      <div className="search-panel" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Search pages">
        <input
          ref={inputRef}
          className="search-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search pages…"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              onClose();
            } else if (e.key === "ArrowDown" && hits && hits.length > 0) {
              e.preventDefault();
              setHighlight((h) => Math.min(h + 1, hits.length - 1));
            } else if (e.key === "ArrowUp" && hits && hits.length > 0) {
              e.preventDefault();
              setHighlight((h) => Math.max(h - 1, 0));
            } else if (e.key === "Enter" && hits && hits.length > 0) {
              select(hits[highlight].pageId);
            }
          }}
        />

        {error && <div className="search-message">Search isn't available right now — {error}</div>}
        {!error && query.trim() && hits === null && <div className="search-message">Searching…</div>}
        {!error && hits !== null && hits.length === 0 && <div className="search-message">No matches for "{query.trim()}"</div>}

        {!error && hits !== null && hits.length > 0 && (
          <div className="search-results">
            {hits.map((hit, i) => (
              <button
                key={hit.pageId}
                type="button"
                className={`search-result-item${i === highlight ? " active" : ""}`}
                onMouseEnter={() => setHighlight(i)}
                onClick={() => select(hit.pageId)}
              >
                <span className="search-result-page-id">{hit.pageId}</span>
                <span className="search-result-snippet">{hit.snippet}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
