import { Fragment, useEffect, useRef, useState } from "react";
import { askWorkspace, searchPages, semanticSearch, type Citation } from "./api.js";

type Mode = "keyword" | "meaning" | "ask";

interface ResultRow {
  key: string;
  pageId: string;
  label: string;
  snippet: string;
}

const MODES: Array<{ mode: Mode; label: string; placeholder: string }> = [
  { mode: "keyword", label: "Keyword", placeholder: "Search pages…" },
  { mode: "meaning", label: "Meaning", placeholder: "Describe what you're looking for…" },
  { mode: "ask", label: "Ask", placeholder: "Ask a question about your workspace, then press Enter" },
];

/** The sources an answer actually cites ([2], [1, 3]), in source order.
 *  Retrieval returns every chunk above a similarity cutoff; listing the
 *  uncited ones as "sources" would claim support the answer never used. */
export function citedSources(text: string, citations: Citation[]): Citation[] {
  const cited = new Set<number>();
  for (const match of text.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)) {
    for (const n of match[1]!.split(",")) cited.add(Number(n));
  }
  return citations.filter((citation) => cited.has(citation.n));
}

/** Renders an answer with each [n] turned into a link to its source page. */
function CitedAnswer({ text, citations, onOpen }: { text: string; citations: Citation[]; onOpen: (pageId: string) => void }) {
  const byNumber = new Map(citations.map((citation) => [citation.n, citation]));
  return (
    <p className="search-answer">
      {text.split(/(\[\d+\])/).map((part, index) => {
        const citation = byNumber.get(Number(/^\[(\d+)\]$/.exec(part)?.[1]));
        return citation ? (
          <button key={index} type="button" className="search-citation" title={citation.title} onClick={() => onOpen(citation.pageId)}>
            {part}
          </button>
        ) : (
          <Fragment key={index}>{part}</Fragment>
        );
      })}
    </p>
  );
}

/**
 * Command-palette overlay with three ways to find things: exact keywords,
 * semantic ("meaning") search over embeddings, and a cited answer streamed
 * from the workspace. Access control is server-side; results only ever
 * include pages the caller can read.
 */
export function SearchOverlay({ onNavigate, onClose }: { onNavigate: (pageId: string) => void; onClose: () => void }) {
  const [mode, setMode] = useState<Mode>("keyword");
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<ResultRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(0);
  const [answer, setAnswer] = useState<{ text: string; citations: Citation[]; done: boolean } | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const askAbort = useRef<AbortController | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    return () => askAbort.current?.abort();
  }, [mode]);

  useEffect(() => {
    setError(null);
    setRows(null);
    if (mode === "ask") return;
    const trimmed = query.trim();
    if (!trimmed) return;
    setHighlight(0);
    let current = true;
    // Debounced; a response for an older query is dropped rather than
    // overwriting newer results.
    const timer = setTimeout(() => {
      const request =
        mode === "keyword"
          ? searchPages(trimmed).then((res) =>
              res.hits.map((hit) => ({ key: hit.pageId, pageId: hit.pageId, label: hit.title ?? hit.pageId, snippet: hit.snippet }))
            )
          : semanticSearch(trimmed).then((res) =>
              res.hits.map((hit, index) => ({ key: `${hit.pageId}-${index}`, pageId: hit.pageId, label: hit.title, snippet: hit.content }))
            );
      request
        .then((next) => current && setRows(next))
        .catch((err) => current && setError(err instanceof Error ? err.message : String(err)));
    }, 250);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [query, mode]);

  function select(pageId: string) {
    onNavigate(pageId);
    onClose();
  }

  function ask() {
    const question = query.trim();
    if (question.length < 3) return;
    askAbort.current?.abort();
    const controller = new AbortController();
    askAbort.current = controller;
    setError(null);
    setAnswer({ text: "", citations: [], done: false });
    askWorkspace(
      question,
      {
        onCitations: (citations) => setAnswer((prev) => prev && { ...prev, citations }),
        onDelta: (text) => setAnswer((prev) => prev && { ...prev, text: prev.text + text }),
      },
      controller.signal
    )
      .then(() => setAnswer((prev) => prev && { ...prev, done: true }))
      .catch((err) => {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err));
      });
  }

  const placeholder = MODES.find((entry) => entry.mode === mode)!.placeholder;

  return (
    <div className="search-overlay" onClick={onClose}>
      <div className="search-panel" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Search pages">
        <div className="search-modes" role="tablist" aria-label="Search mode">
          {MODES.map((entry) => (
            <button
              key={entry.mode}
              type="button"
              role="tab"
              aria-selected={mode === entry.mode}
              className={`search-mode${mode === entry.mode ? " active" : ""}`}
              onClick={() => {
                setMode(entry.mode);
                setAnswer(null);
              }}
            >
              {entry.label}
            </button>
          ))}
        </div>
        <input
          ref={inputRef}
          className="search-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={placeholder}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            else if (mode === "ask" && e.key === "Enter") ask();
            else if (e.key === "ArrowDown" && rows && rows.length > 0) {
              e.preventDefault();
              setHighlight((h) => Math.min(h + 1, rows.length - 1));
            } else if (e.key === "ArrowUp" && rows && rows.length > 0) {
              e.preventDefault();
              setHighlight((h) => Math.max(h - 1, 0));
            } else if (e.key === "Enter" && rows && rows.length > 0) select(rows[highlight]!.pageId);
          }}
        />

        {error && <div className="search-message">Search isn't available right now — {error}</div>}

        {mode === "ask" ? (
          answer && (
            <div className="search-answer-panel" aria-live="polite">
              {answer.text ? (
                <CitedAnswer text={answer.text} citations={answer.citations} onOpen={select} />
              ) : (
                !error && <div className="search-message">Reading your pages…</div>
              )}
              {answer.done && citedSources(answer.text, answer.citations).length > 0 && (
                <ol className="search-sources" aria-label="Sources">
                  {citedSources(answer.text, answer.citations).map((citation) => (
                    <li key={citation.n}>
                      <button type="button" onClick={() => select(citation.pageId)}>
                        [{citation.n}] {citation.title}
                      </button>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          )
        ) : (
          <>
            {!error && query.trim() && rows === null && <div className="search-message">Searching…</div>}
            {!error && rows !== null && rows.length === 0 && <div className="search-message">No matches for "{query.trim()}"</div>}
            {!error && rows !== null && rows.length > 0 && (
              <div className="search-results">
                {rows.map((row, i) => (
                  <button
                    key={row.key}
                    type="button"
                    className={`search-result-item${i === highlight ? " active" : ""}`}
                    onMouseEnter={() => setHighlight(i)}
                    onClick={() => select(row.pageId)}
                  >
                    <span className="search-result-title">{row.label}</span>
                    <span className="search-result-snippet">
                      {row.snippet.length > 160 ? `${row.snippet.slice(0, 160)}…` : row.snippet}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
