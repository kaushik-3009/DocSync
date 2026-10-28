import { useEffect, useRef, useState } from "react";
import type * as Y from "yjs";
import { setBlockImage } from "@docsync/shared";
import { fetchImageUrl, uploadImage } from "./api.js";

/**
 * An image block. The block stores only an upload id; each viewer exchanges
 * it for a short-lived signed URL after the server checks page access. An
 * expired URL is renewed once when the image fails to load.
 */
export function ImageBlock({
  doc,
  blockId,
  pageId,
  uploadId,
  readOnly,
}: {
  doc: Y.Doc;
  blockId: string;
  pageId: string;
  uploadId: string | null;
  readOnly: boolean;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const renewed = useRef(false);
  const input = useRef<HTMLInputElement | null>(null);

  const load = (id: string) =>
    fetchImageUrl(pageId, id)
      .then((res) => setUrl(res.url))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));

  useEffect(() => {
    setUrl(null);
    setError(null);
    renewed.current = false;
    if (uploadId) void load(uploadId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageId, uploadId]);

  async function upload(file: File | undefined) {
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      setBlockImage(doc, blockId, await uploadImage(pageId, file));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  }

  if (uploadId) {
    return (
      <figure className="image-block">
        {url ? (
          <img
            src={url}
            alt=""
            onError={() => {
              if (renewed.current) return setError("The image could not be loaded.");
              renewed.current = true;
              void load(uploadId);
            }}
          />
        ) : (
          !error && <div className="embed-card-loading">Loading image…</div>
        )}
        {error && <p className="image-block-error">{error}</p>}
      </figure>
    );
  }

  if (readOnly) return <div className="image-block-empty">Empty image block</div>;

  return (
    <div
      className="image-block-empty"
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        void upload(event.dataTransfer.files[0]);
      }}
    >
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        hidden
        onChange={(event) => void upload(event.target.files?.[0])}
      />
      <button type="button" onClick={() => input.current?.click()} disabled={uploading}>
        {uploading ? "Uploading…" : "Upload image"}
      </button>
      <span>or drop one here (PNG, JPEG, GIF, WebP · up to 5 MB)</span>
      {error && <p className="image-block-error">{error}</p>}
    </div>
  );
}
