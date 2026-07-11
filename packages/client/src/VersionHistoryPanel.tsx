import { useEffect, useRef, useState } from "react";
import type { SerializedBlockWithDelta } from "@collab/shared";
import { fetchVersions, fetchVersionAt, restoreVersion, type VersionSummary } from "./api.js";
import { formatRelativeTime } from "./relativeTime.js";
import { renderDelta } from "./renderDelta.js";

/**
 * Browse + restore, GDocs-style: a slide-over listing every snapshot for
 * this page (newest first), a read-only preview of whichever one is
 * selected (rendered from its delta — bold/italic/link marks included, not
 * just plain text), and a two-step "Restore this version" action. Restoring
 * replaces the *live* document via the server's HTTP restore endpoint; the
 * requesting client doesn't need to do anything with the response itself —
 * the restore runs as a real transaction on the room's doc, which syncs
 * back down over this client's own WebSocket connection exactly like any
 * other edit would.
 */
export function VersionHistoryPanel({ pageId, onClose }: { pageId: string; onClose: () => void }) {
  const [versions, setVersions] = useState<VersionSummary[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null);
  const [preview, setPreview] = useState<SerializedBlockWithDelta[] | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [confirmingRestore, setConfirmingRestore] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [restored, setRestored] = useState(false);
  const selectedSeqRef = useRef<number | null>(null);

  useEffect(() => {
    fetchVersions(pageId)
      .then((res) => setVersions(res.versions))
      .catch((err) => setListError(err instanceof Error ? err.message : String(err)));
  }, [pageId]);

  function selectVersion(seq: number) {
    setSelectedSeq(seq);
    selectedSeqRef.current = seq;
    setPreview(null);
    setPreviewError(null);
    setConfirmingRestore(false);
    // A slower-resolving fetch for a previously selected version can land
    // after a faster one for whatever's selected now — this feeds a
    // "restore this version" action, so showing the wrong version's content
    // here isn't just cosmetic. Only apply a response if its version is
    // still the one selected when it comes back.
    fetchVersionAt(pageId, seq)
      .then((res) => {
        if (selectedSeqRef.current === seq) setPreview(res.blocks);
      })
      .catch((err) => {
        if (selectedSeqRef.current === seq) setPreviewError(err instanceof Error ? err.message : String(err));
      });
  }

  function confirmRestore() {
    if (selectedSeq === null) return;
    setRestoring(true);
    restoreVersion(pageId, selectedSeq)
      .then(() => {
        setRestored(true);
        setTimeout(onClose, 900);
      })
      .catch((err) => setPreviewError(err instanceof Error ? err.message : String(err)))
      .finally(() => setRestoring(false));
  }

  return (
    <div className="version-panel-overlay" onClick={onClose}>
      <div className="version-panel" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Version history">
        <div className="version-panel-header">
          <h3>Version history</h3>
          <button type="button" aria-label="close version history" className="version-panel-close" onClick={onClose}>
            ×
          </button>
        </div>

        {listError && (
          <div className="version-panel-message">Version history isn't available right now — {listError}</div>
        )}
        {!listError && versions === null && <div className="version-panel-message">Loading…</div>}
        {!listError && versions !== null && versions.length === 0 && (
          <div className="version-panel-message">No earlier versions yet — they build up as you keep editing.</div>
        )}

        {!listError && versions !== null && versions.length > 0 && (
          <div className="version-panel-body">
            <div className="version-list">
              {versions.map((v) => (
                <button
                  key={v.seq}
                  type="button"
                  className={`version-item${v.seq === selectedSeq ? " active" : ""}`}
                  onClick={() => selectVersion(v.seq)}
                >
                  <span className="version-item-time">{formatRelativeTime(new Date(v.createdAt).getTime())}</span>
                  <span className="version-item-date">
                    {new Date(v.createdAt).toLocaleString(undefined, {
                      month: "short",
                      day: "numeric",
                      hour: "numeric",
                      minute: "2-digit",
                    })}
                  </span>
                </button>
              ))}
            </div>

            {selectedSeq !== null && (
              <div className="version-preview">
                {previewError && <div className="version-panel-message">{previewError}</div>}
                {!previewError && preview === null && <div className="version-panel-message">Loading…</div>}
                {preview && (
                  <>
                    <div className="version-preview-content">
                      {preview.map((block) => (
                        <VersionPreviewBlock key={block.id} block={block} depth={0} />
                      ))}
                    </div>
                    <div className="version-preview-actions">
                      {restored ? (
                        <span className="version-restored-message">Restored ✓</span>
                      ) : confirmingRestore ? (
                        <div className="version-restore-confirm">
                          <span>Replace the current document with this version?</span>
                          <button type="button" onClick={confirmRestore} disabled={restoring}>
                            {restoring ? "Restoring…" : "Yes, restore"}
                          </button>
                          <button type="button" onClick={() => setConfirmingRestore(false)} disabled={restoring}>
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button type="button" className="version-restore-btn" onClick={() => setConfirmingRestore(true)}>
                          Restore this version
                        </button>
                      )}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function VersionPreviewBlock({ block, depth }: { block: SerializedBlockWithDelta; depth: number }) {
  return (
    <div style={{ marginLeft: `${depth * 1.25}rem` }}>
      <div
        className="version-preview-block"
        style={{
          fontWeight: block.type === "heading" ? 700 : 400,
          fontSize: block.type === "heading" ? "1.1rem" : "0.9rem",
          textDecoration: block.type === "todo" && block.checked ? "line-through" : "none",
        }}
      >
        {block.type === "todo" && <span aria-hidden="true">{block.checked ? "☑ " : "☐ "}</span>}
        {block.type === "bullet" && <span aria-hidden="true">• </span>}
        {block.type === "canvas" ? (
          <em>Canvas</em>
        ) : block.type === "code" ? (
          <code>{block.text}</code>
        ) : (
          renderDelta(block.delta)
        )}
      </div>
      {block.children.map((child) => (
        <VersionPreviewBlock key={child.id} block={child} depth={depth + 1} />
      ))}
    </div>
  );
}
