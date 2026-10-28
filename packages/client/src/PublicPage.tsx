import { useEffect, useState } from "react";
import type { SerializedBlockWithDelta } from "@collab/shared";
import { fetchPublicPage } from "./api.js";
import { renderDelta } from "./renderDelta.js";

function Block({ block }: { block: SerializedBlockWithDelta }) {
  const children = block.children.length > 0 && (
    <div className="public-page-children">
      {block.children.map((child) => (
        <Block key={child.id} block={child} />
      ))}
    </div>
  );
  switch (block.type) {
    case "heading":
      return (
        <>
          <h2>{renderDelta(block.delta)}</h2>
          {children}
        </>
      );
    case "code":
      return (
        <>
          <pre className="public-page-code">
            <code>{block.text}</code>
          </pre>
          {children}
        </>
      );
    case "todo":
      return (
        <>
          <label className="public-page-todo">
            <input type="checkbox" checked={block.checked} readOnly disabled /> <span>{renderDelta(block.delta)}</span>
          </label>
          {children}
        </>
      );
    case "bullet":
      return (
        <>
          <ul>
            <li>{renderDelta(block.delta)}</li>
          </ul>
          {children}
        </>
      );
    case "canvas":
      return <p className="public-page-muted">(Canvas — open the page in DocSync to view drawings.)</p>;
    case "image":
      // Image URLs are signed per signed-in viewer; public links show text only.
      return <p className="public-page-muted">(Image — open the page in DocSync to view it.)</p>;
    default:
      return (
        <>
          <p>{renderDelta(block.delta)}</p>
          {children}
        </>
      );
  }
}

/** Read-only page for a public share link: no sign-in, no live connection. */
export function PublicPage({ token }: { token: string }) {
  const [page, setPage] = useState<{ title: string; blocks: SerializedBlockWithDelta[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchPublicPage(token)
      .then((next) => {
        setPage(next);
        if (next.title) document.title = `${next.title} — DocSync`;
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [token]);

  return (
    <main className="public-page">
      <div className="public-page-badge">Read-only shared page</div>
      {error ? (
        <p role="alert">{error}</p>
      ) : !page ? (
        <p className="public-page-muted">Loading…</p>
      ) : (
        <article>
          <h1>{page.title || "Untitled"}</h1>
          {page.blocks.map((block) => (
            <Block key={block.id} block={block} />
          ))}
        </article>
      )}
    </main>
  );
}
