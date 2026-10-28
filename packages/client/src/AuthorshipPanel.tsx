import { useEffect, useState } from "react";
import { pickPresenceColor } from "@docsync/shared";
import { fetchAuthorship, type AuthorshipSpan, type PageAuthorship } from "./api.js";

const UNKNOWN_COLOR = "#9a9a92";

function colorFor(userId: string | null): string {
  return userId ? pickPresenceColor(userId) : UNKNOWN_COLOR;
}

function Spans({ spans }: { spans: AuthorshipSpan[] }) {
  return (
    <>
      {spans.map((span, index) => (
        <span
          key={index}
          className="authorship-span"
          style={{ backgroundColor: `color-mix(in srgb, ${colorFor(span.userId)} 22%, transparent)` }}
        >
          {span.text}
        </span>
      ))}
    </>
  );
}

/** "Who wrote this": the page's current text, highlighted by author. */
export function AuthorshipPanel({ pageId, onClose }: { pageId: string; onClose: () => void }) {
  const [data, setData] = useState<PageAuthorship | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchAuthorship(pageId)
      .then((next) => !cancelled && setData(next))
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : String(err)));
    const onKeyDown = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKeyDown);
    return () => {
      cancelled = true;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [pageId, onClose]);

  const total = data?.authors.reduce((sum, author) => sum + author.characters, 0) ?? 0;

  return (
    <div className="share-panel-overlay" onMouseDown={onClose}>
      <section
        className="share-panel authorship-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="authorship-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="share-panel-header">
          <div>
            <h3 id="authorship-title">Authors</h3>
            <p>Every character is attributed to the person whose session typed it.</p>
          </div>
          <button type="button" aria-label="Close authors" className="share-panel-close" onClick={onClose}>
            ×
          </button>
        </header>

        {error ? (
          <div className="share-panel-message" role="alert">
            Authorship is unavailable right now — {error}
          </div>
        ) : !data ? (
          <div className="share-panel-message">Loading authors…</div>
        ) : (
          <>
            <ul className="authorship-legend" aria-label="Contribution by author">
              {data.authors.map((author) => (
                <li key={author.userId ?? "unknown"}>
                  <span className="authorship-swatch" style={{ backgroundColor: colorFor(author.userId) }} />
                  <span className="authorship-name">{author.email ?? "Earlier edits (not attributed)"}</span>
                  <span className="authorship-share">{total ? Math.round((author.characters / total) * 100) : 0}%</span>
                </li>
              ))}
            </ul>
            <article className="authorship-document">
              {data.title.length > 0 && (
                <h2>
                  <Spans spans={data.title} />
                </h2>
              )}
              {data.blocks
                .filter((block) => block.spans.length > 0)
                .map((block) => (
                  <p key={block.blockId}>
                    <Spans spans={block.spans} />
                  </p>
                ))}
              {data.blocks.every((block) => block.spans.length === 0) && <p className="share-panel-message">This page has no text yet.</p>}
            </article>
          </>
        )}
      </section>
    </div>
  );
}
