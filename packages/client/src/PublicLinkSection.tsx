import { useEffect, useState } from "react";
import { createShareLink, listShareLinks, publicPageUrl, revokeShareLink, type ShareLinkSummary } from "./api.js";
import { formatRelativeTime } from "./relativeTime.js";

/** Owner-only management of read-only public links. A link's URL contains a
 *  secret the server never stores, so it is shown once, right after creation. */
export function PublicLinkSection({ pageId }: { pageId: string }) {
  const [links, setLinks] = useState<ShareLinkSummary[] | null>(null);
  const [freshUrl, setFreshUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listShareLinks(pageId)
      .then((res) => setLinks(res.links))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [pageId]);

  async function create() {
    setError(null);
    try {
      const { link, token } = await createShareLink(pageId);
      setLinks((prev) => [link, ...(prev ?? [])]);
      setFreshUrl(publicPageUrl(token));
      setCopied(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function revoke(linkId: string) {
    await revokeShareLink(pageId, linkId).catch((err) => setError(err instanceof Error ? err.message : String(err)));
    setLinks((prev) => prev?.filter((link) => link.id !== linkId) ?? null);
    setFreshUrl(null);
  }

  return (
    <section className="public-links" aria-label="Public links">
      <div className="share-invite-heading">
        <span className="share-section-title">Public read-only link</span>
        <button type="button" className="share-invite-button" onClick={() => void create()}>
          Create link
        </button>
      </div>
      <p className="public-links-hint">Anyone with the link can read the current page without signing in. Revoke it at any time.</p>
      {freshUrl && (
        <div className="public-link-fresh">
          <input readOnly value={freshUrl} aria-label="New public link" onFocus={(event) => event.currentTarget.select()} />
          <button
            type="button"
            onClick={() =>
              void navigator.clipboard
                .writeText(freshUrl)
                .then(() => setCopied(true))
                .catch(() => setCopied(false))
            }
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      )}
      {error && (
        <p className="share-invite-message is-error" role="alert">
          {error}
        </p>
      )}
      {links && links.length > 0 && (
        <ul className="public-link-list">
          {links.map((link) => (
            <li key={link.id}>
              <span>Created {formatRelativeTime(Date.parse(link.createdAt))}</span>
              <button type="button" onClick={() => void revoke(link.id)}>
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
