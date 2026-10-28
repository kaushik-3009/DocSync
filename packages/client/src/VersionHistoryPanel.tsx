import { useEffect, useRef, useState } from "react";
import type { SerializedBlockWithDelta } from "@collab/shared";
import { fetchVersions, fetchVersionAt, restoreVersion, type VersionSummary } from "./api.js";
import { formatRelativeTime } from "./relativeTime.js";
import { renderDelta } from "./renderDelta.js";

/** Full-height, Google Docs-style history workspace. The server exposes
 * grouped logical versions (30-second edit windows), while each selected
 * version still resolves to its exact durable end sequence for preview/restore. */
export function VersionHistoryPanel({ pageId, onClose }: { pageId: string; onClose: () => void }) {
  const [versions, setVersions] = useState<VersionSummary[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null);
  const [preview, setPreview] = useState<SerializedBlockWithDelta[] | null>(null);
  const [baseline, setBaseline] = useState<SerializedBlockWithDelta[] | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [confirmingRestore, setConfirmingRestore] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [restored, setRestored] = useState(false);
  const [versionFilter, setVersionFilter] = useState<"all" | "today" | "week">("all");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [showSequenceRanges, setShowSequenceRanges] = useState(true);
  const [refreshTick, setRefreshTick] = useState(0);
  const selectedSeqRef = useRef<number | null>(null);
  const latestSeqRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      fetchVersions(pageId)
        .then((res) => {
          if (cancelled) return;
          setVersions(res.versions);
          setListError(null);
          // The newest version is the current document, matching the first
          // card shown by Google Docs when history opens.
          const wasFollowingCurrent = selectedSeqRef.current === null || selectedSeqRef.current === latestSeqRef.current;
          latestSeqRef.current = res.versions[0]?.seq ?? null;
          if (wasFollowingCurrent && res.versions[0]) selectVersion(res.versions[0].seq, res.versions);
        })
        .catch((err) => {
          if (!cancelled) setListError(err instanceof Error ? err.message : String(err));
        });
    };
    refresh();
    // Logical versions are derived from durable timestamps. Polling keeps the
    // open history view live while another collaborator is editing, without
    // creating client-side versions or changing the durability boundary.
    const interval = setInterval(refresh, 5_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
    // selectVersion is recreated every render; the poll is keyed by page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageId, refreshTick]);

  function selectVersion(seq: number, sourceVersions = versions ?? []) {
    setSelectedSeq(seq);
    selectedSeqRef.current = seq;
    setPreview(null);
    setBaseline(null);
    setPreviewError(null);
    setConfirmingRestore(false);
    const selectedIndex = sourceVersions.findIndex((version) => version.seq === seq);
    // Versions are newest-first. The immediately older logical version is the
    // baseline, so the selected version can show additions/deletions like Docs.
    const baselineSeq = selectedIndex >= 0 ? sourceVersions[selectedIndex + 1]?.seq : undefined;
    Promise.all([fetchVersionAt(pageId, seq), baselineSeq === undefined ? Promise.resolve(null) : fetchVersionAt(pageId, baselineSeq)])
      .then(([selected, previous]) => {
        if (selectedSeqRef.current === seq) {
          setPreview(selected.blocks);
          setBaseline(previous?.blocks ?? []);
        }
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

  const selectedVersion = versions?.find((version) => version.seq === selectedSeq) ?? null;
  const visibleVersions = filterVersions(versions ?? [], versionFilter);
  const versionGroups = groupVersionsByDay(visibleVersions);
  const isCurrentVersion = selectedVersion?.seq === versions?.[0]?.seq;

  return (
    <div className="version-panel-overlay" role="presentation">
      <div className="version-history-shell" role="dialog" aria-label="Version history">
        <header className="version-history-topbar">
          <button type="button" className="version-history-back" onClick={onClose} aria-label="Close version history">
            ←
          </button>
          <div className="version-history-title">
            <strong>Version history</strong>
            <span className="version-history-live">
              <span className="version-history-live-dot" />
              Live
            </span>
          </div>
          <button type="button" className="version-panel-close" onClick={onClose} aria-label="Close version history">
            ×
          </button>
        </header>

        <div className="version-history-workspace">
          <main className="version-history-preview-column">
            <div className="version-history-preview-toolbar">
              <div>
                <span className="version-history-toolbar-label">Selected version</span>
                <strong>{selectedVersion ? formatVersionDate(selectedVersion.updatedAt) : "Choose a version"}</strong>
              </div>
              <div className="version-history-toolbar-meta">
                {selectedVersion && (
                  <span>
                    {selectedVersion.editCount} edit{selectedVersion.editCount === 1 ? "" : "s"}
                  </span>
                )}
                {showSequenceRanges && <span>{selectedVersion ? `${selectedVersion.startSeq}–${selectedVersion.endSeq}` : ""}</span>}
              </div>
              <div className="version-history-toolbar-actions">
                {restored ? (
                  <span className="version-restored-message">Version restored ✓</span>
                ) : selectedVersion && !isCurrentVersion && preview ? (
                  confirmingRestore ? (
                    <div className="version-restore-confirm" role="alertdialog" aria-label="Confirm version restore">
                      <span>Restore this version?</span>
                      <div className="version-restore-confirm-actions">
                        <button type="button" className="version-restore-primary" onClick={confirmRestore} disabled={restoring}>
                          {restoring ? "Restoring…" : "Restore"}
                        </button>
                        <button
                          type="button"
                          className="version-restore-secondary"
                          onClick={() => setConfirmingRestore(false)}
                          disabled={restoring}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button type="button" className="version-restore-btn" onClick={() => setConfirmingRestore(true)}>
                      Restore version
                    </button>
                  )
                ) : null}
              </div>
            </div>

            <div className="version-document-stage">
              {listError && <div className="version-panel-message">Version history isn’t available right now — {listError}</div>}
              {!listError && versions === null && <div className="version-panel-message">Loading version history…</div>}
              {!listError && versions !== null && versions.length === 0 && (
                <div className="version-empty-state">
                  <strong>Your versions will appear here</strong>
                  <span>Keep editing and DocSync will group rapid changes into live 30-second versions.</span>
                </div>
              )}
              {previewError && <div className="version-panel-message">{previewError}</div>}
              {!previewError && selectedSeq !== null && preview === null && (
                <div className="version-panel-message">Loading selected version…</div>
              )}
              {preview && (
                <div className="version-document-paper">
                  <div className="version-diff-legend" aria-label="Version diff legend">
                    <span>
                      <mark className="version-diff-added">Added</mark>
                    </span>
                    <span>
                      <mark className="version-diff-removed">Removed</mark>
                    </span>
                  </div>
                  {preview.map((block) => (
                    <VersionDiffBlock key={block.id} block={block} before={findBlock(baseline ?? [], block.id)} depth={0} />
                  ))}
                  {(baseline ?? [])
                    .filter((block) => !findBlock(preview, block.id))
                    .map((block) => (
                      <VersionDiffBlock key={`removed-${block.id}`} block={block} before={block} depth={0} removed />
                    ))}
                </div>
              )}
            </div>
          </main>

          <aside className="version-history-sidebar">
            <div className="version-history-sidebar-heading">
              <strong>Version history</strong>
              <div className="version-history-settings-wrap">
                <button
                  type="button"
                  aria-label="Version history options"
                  className="version-history-more"
                  aria-expanded={settingsOpen}
                  onClick={() => setSettingsOpen((open) => !open)}
                >
                  ⋮
                </button>
                {settingsOpen && (
                  <div className="version-history-settings-menu" role="menu">
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setSettingsOpen(false);
                        setVersionFilter("all");
                        setRefreshTick((tick) => tick + 1);
                      }}
                    >
                      Refresh version list
                    </button>
                    <label role="menuitemcheckbox">
                      <input
                        type="checkbox"
                        checked={showSequenceRanges}
                        onChange={(event) => setShowSequenceRanges(event.target.checked)}
                      />
                      Show sequence ranges
                    </label>
                  </div>
                )}
              </div>
            </div>
            <label className="version-history-filter">
              <span className="sr-only">Version filter</span>
              <select value={versionFilter} onChange={(event) => setVersionFilter(event.target.value as typeof versionFilter)}>
                <option value="all">All versions</option>
                <option value="today">Today</option>
                <option value="week">Last 7 days</option>
              </select>
            </label>
            <div className="version-history-list">
              {versionGroups.map(([day, dayVersions]) => (
                <section key={day} className="version-day-group">
                  <h4>{day}</h4>
                  {dayVersions.map((version) => (
                    <button
                      key={version.seq}
                      type="button"
                      className={`version-item${version.seq === selectedSeq ? " active" : ""}`}
                      onClick={() => selectVersion(version.seq)}
                    >
                      <span className="version-item-heading">
                        <strong>{formatVersionDate(version.updatedAt)}</strong>
                        {version.seq === versions?.[0]?.seq && <span className="version-current-badge">Current</span>}
                      </span>
                      <span className="version-item-subtitle">
                        {version.editCount} edit{version.editCount === 1 ? "" : "s"} ·{" "}
                        {formatRelativeTime(new Date(version.updatedAt).getTime())}
                      </span>
                      <span className="version-item-author">
                        <span className="version-author-dot" />
                        Collaborators
                      </span>
                    </button>
                  ))}
                </section>
              ))}
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}

function groupVersionsByDay(versions: VersionSummary[]): Array<[string, VersionSummary[]]> {
  const groups = new Map<string, VersionSummary[]>();
  for (const version of versions) {
    const day = new Date(version.updatedAt).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
    const bucket = groups.get(day) ?? [];
    bucket.push(version);
    groups.set(day, bucket);
  }
  return Array.from(groups.entries());
}

function filterVersions(versions: VersionSummary[], filter: "all" | "today" | "week"): VersionSummary[] {
  if (filter === "all") return versions;
  const now = Date.now();
  const cutoff = filter === "today" ? new Date().setHours(0, 0, 0, 0) : now - 7 * 24 * 60 * 60 * 1000;
  return versions.filter((version) => new Date(version.updatedAt).getTime() >= cutoff);
}

function formatVersionDate(value: string): string {
  return new Date(value).toLocaleString(undefined, { month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function findBlock(blocks: SerializedBlockWithDelta[], id: string): SerializedBlockWithDelta | undefined {
  for (const block of blocks) {
    if (block.id === id) return block;
    const nested = findBlock(block.children, id);
    if (nested) return nested;
  }
  return undefined;
}

function VersionDiffBlock({
  block,
  before,
  depth,
  removed = false,
}: {
  block: SerializedBlockWithDelta;
  before?: SerializedBlockWithDelta;
  depth: number;
  removed?: boolean;
}) {
  const isAdded = removed ? false : !before;
  const changed =
    removed ||
    isAdded ||
    before?.text !== block.text ||
    before?.type !== block.type ||
    before?.checked !== block.checked ||
    before?.language !== block.language;
  const childrenBefore = before?.children ?? [];
  return (
    <div style={{ marginLeft: `${depth * 1.25}rem` }}>
      <div
        className={`version-preview-block${isAdded ? " version-block-added" : ""}${removed ? " version-block-removed" : ""}`}
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
          <code>{changed ? renderInlineTextDiff(before?.text ?? "", block.text, removed) : block.text}</code>
        ) : changed ? (
          renderInlineTextDiff(before?.text ?? "", block.text, removed)
        ) : (
          renderDelta(block.delta)
        )}
      </div>
      {block.children.map((child) => (
        <VersionDiffBlock key={child.id} block={child} before={findBlock(childrenBefore, child.id)} depth={depth + 1} />
      ))}
      {childrenBefore
        .filter((child) => !findBlock(block.children, child.id))
        .map((child) => (
          <VersionDiffBlock key={`removed-${child.id}`} block={child} before={child} depth={depth + 1} removed />
        ))}
    </div>
  );
}

function renderInlineTextDiff(before: string, after: string, removed: boolean) {
  if (removed) return <mark className="version-diff-removed">{before}</mark>;
  if (!before) return <mark className="version-diff-added">{after || "(empty)"}</mark>;
  if (before === after) return after;
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  )
    suffix += 1;
  return (
    <>
      {after.slice(0, prefix)}
      <mark className="version-diff-removed">{before.slice(prefix, before.length - suffix)}</mark>
      <mark className="version-diff-added">{after.slice(prefix, after.length - suffix)}</mark>
      {suffix ? after.slice(after.length - suffix) : null}
    </>
  );
}
