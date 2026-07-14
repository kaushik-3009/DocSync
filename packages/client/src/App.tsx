import { lazy, Suspense, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import * as Y from "yjs";
import {
  createBlock,
  deleteBlock,
  setBlockType,
  setBlockChecked,
  setBlockLanguage,
  splitBlock,
  insertBlockAfter,
  getBlockText,
  getTitleText,
  commentsForBlock,
  type BlockType,
  type SerializedBlock,
  type PresenceState,
  type SerializedComment,
} from "@collab/shared";
import { useYDoc } from "./useYDoc.js";
import { generatePageId } from "./pageId.js";
import { getRecentPages, recordPageVisit, type RecentPage } from "./recentPages.js";
import { RichText } from "./RichText.js";
// tldraw and CodeMirror's language packages are the two biggest contributors
// to bundle size by far (tldraw alone is several hundred kB) — most pages
// never use a canvas or code block at all, so loading them eagerly on every
// page load costs everyone for a feature most sessions never touch.
const CanvasBlock = lazy(() => import("./CanvasBlock.js").then((m) => ({ default: m.CanvasBlock })));
const CodeBlock = lazy(() => import("./CodeBlock.js").then((m) => ({ default: m.CodeBlock })));
import { flattenBlockIds } from "./blockTree.js";
import { handleBlockKeyDown } from "./keyboard.js";
import { requestFocus, getBlockElement } from "./blockFocus.js";
import { SlashMenu, filterBlockTypeOptions } from "./SlashMenu.js";
import { BlockGutterMenu } from "./BlockGutterMenu.js";
import { VersionHistoryPanel } from "./VersionHistoryPanel.js";
import { SearchOverlay } from "./SearchOverlay.js";
import { MentionTextInput } from "./MentionTextInput.js";
import { formatRelativeTime } from "./relativeTime.js";
import { fetchPageRoles, requestPdfExport, getExportStatus, fetchExportBlob, fetchHealth } from "./api.js";
import { useTheme } from "./theme.js";
import { useAuthUser, clearToken } from "./auth.js";
import { LoginScreen } from "./LoginScreen.js";
import type { WebsocketProvider } from "y-websocket";

function getPageIdFromUrl(): string {
  const params = new URLSearchParams(window.location.search);
  return params.get("page") ?? "demo-page";
}

export function App() {
  const [pageId, setPageId] = useState(getPageIdFromUrl());
  // Separate draft state for the "Page:" input, committed on blur/Enter
  // rather than on every keystroke: `pageId` changing tears down and
  // reopens the WebSocket connection (see useYDoc), so wiring the input
  // straight to `joinPage` reconnected on every character typed while
  // editing/fixing a page id, which could also trip the server's per-IP
  // connect-rate limiter under fast typing.
  const [pageIdDraft, setPageIdDraft] = useState(pageId);
  const authUser = useAuthUser();
  // Null until the one-time /health check below resolves — the client has no
  // way to know in advance whether this server was started with JWT_SECRET
  // configured, and guessing wrong in either direction is worse than a brief
  // loading state: assuming "required" would flash a login gate at every
  // guest-mode dev instance, assuming "not required" would let the app render
  // (and its WS connection silently fail to authenticate) before redirecting
  // into the gate a moment later.
  const [authRequired, setAuthRequired] = useState<boolean | null>(null);
  const [healthUnavailable, setHealthUnavailable] = useState(false);
  const [showLoginModal, setShowLoginModal] = useState(false);
  // Don't even attempt the WS connection until we know it has a real chance
  // of succeeding: an unauthenticated connection attempt against a server
  // that requires auth gets its upgrade rejected, y-websocket immediately
  // retries, and a burst of those trips the server's per-IP connect-rate
  // limiter — which then also blocks the real, authenticated attempt the
  // moment the user actually signs in. See useYDoc's `enabled` param.
  const canConnect = authRequired !== null && (!authRequired || Boolean(authUser));
  const {
    doc,
    provider,
    blocks,
    synced,
    connectionDenied,
    localUser,
    peers,
    setCursor,
    clearCursor,
    addComment,
    toggleCommentResolved,
    removeComment,
  } = useYDoc(pageId, authUser, canConnect);
  const [recentPages, setRecentPages] = useState<RecentPage[]>(() => getRecentPages());
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [showVersionHistory, setShowVersionHistory] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [mentionEmails, setMentionEmails] = useState<string[]>([]);
  const [exportState, setExportState] = useState<"idle" | "pending" | "error">("idle");
  // Tracks which page an in-flight export poll belongs to, and lets the poll
  // interval be torn down if the user navigates away before it resolves —
  // without this, switching pages mid-export left the old page's poll
  // running, and its eventual state update (success/failure) would silently
  // overwrite the *new* current page's export button state.
  const exportPollRef = useRef<{ pageId: string; interval: ReturnType<typeof setInterval> } | null>(null);
  useEffect(() => {
    return () => {
      if (exportPollRef.current) {
        clearInterval(exportPollRef.current.interval);
        exportPollRef.current = null;
        setExportState("idle");
      }
    };
  }, [pageId]);
  const [theme, toggleTheme] = useTheme();

  useEffect(() => {
    fetchHealth()
      .then((res) => {
        setAuthRequired(res.authRequired);
        setHealthUnavailable(false);
      })
      .catch(() => setHealthUnavailable(true));
  }, []);

  const flatIds = useMemo(() => flattenBlockIds(blocks), [blocks]);

  // A seamless document is never truly "empty" — there's always a caret
  // somewhere ready to type into, the way a blank Google Doc still has a
  // blinking cursor rather than an "add your first block" prompt.
  useEffect(() => {
    if (synced && blocks.length === 0) {
      createBlock(doc, crypto.randomUUID(), { type: "paragraph" });
    }
  }, [synced, blocks.length, doc]);

  // Switching pages while the panel for a *different* page's history is open
  // would otherwise show stale content mid-transition.
  useEffect(() => {
    setShowVersionHistory(false);
  }, [pageId]);

  // Powers @mention autocomplete: who can even be mentioned on *this* page.
  // Requires auth (JWT_SECRET + DATABASE_URL) server-side — without it the
  // route 503s and autocomplete quietly has no suggestions, same graceful
  // degradation as the rest of this app's optional server-side features.
  //
  // Gated on `synced`, not just `pageId`: the roles row for a first-time
  // visitor is created by the WS gateway's auto-enrollment (resolveRoleForConnection)
  // *before* it starts the sync handshake, but this HTTP fetch has no such
  // ordering guarantee on its own — firing it immediately on mount raced
  // that WS round-trip and reliably lost, producing a 403 on every fresh
  // page load. Waiting for `synced` guarantees the role row already exists.
  useEffect(() => {
    if (!synced) return;
    let cancelled = false;
    fetchPageRoles(pageId)
      .then((res) => {
        if (!cancelled) setMentionEmails(res.roles.map((r) => r.email));
      })
      .catch(() => {
        if (!cancelled) setMentionEmails([]);
      });
    return () => {
      cancelled = true;
    };
  }, [pageId, synced]);

  // Cmd/Ctrl+K is the near-universal shortcut for "search" — offering it
  // alongside the toolbar button costs nothing and is what users reach for
  // first.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setShowSearch(true);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Recorded as its own effect (not inlined into joinPage) so a page loaded
  // directly from a URL — the common case when someone opens a link you
  // shared — also lands in the sidebar, not just pages reached by clicking
  // through it.
  useEffect(() => {
    setRecentPages(recordPageVisit(pageId));
  }, [pageId]);

  function joinPage(next: string) {
    const url = new URL(window.location.href);
    url.searchParams.set("page", next);
    window.history.replaceState(null, "", url.toString());
    setPageId(next);
    setPageIdDraft(next);
  }

  function newPage() {
    joinPage(generatePageId());
  }

  function copyLink() {
    navigator.clipboard
      .writeText(window.location.href)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {
        // The Clipboard API write can be rejected (permission denied, or
        // unavailable in a non-HTTPS/dev context) — without this, the button
        // silently did nothing, giving no indication the click didn't work.
        setCopyFailed(true);
        setTimeout(() => setCopyFailed(false), 2000);
      });
  }

  // Enqueue → poll the job every ~1s → download the finished PDF, per
  // docs/DESIGN.md section 9. Each step degrades to an inline error state
  // (never a thrown/unhandled rejection) since this whole pipeline is
  // optional infra that's simply absent without REDIS_URL/DATABASE_URL.
  function exportPdf() {
    const exportPageId = pageId;
    setExportState("pending");
    // Guards every state update below against having navigated away from
    // exportPageId in the meantime — see exportPollRef's declaration.
    const stillCurrent = () => exportPollRef.current?.pageId === exportPageId;
    requestPdfExport(exportPageId)
      .then((res) => {
        const poll = setInterval(() => {
          getExportStatus(exportPageId, res.jobId)
            .then((status) => {
              if (status.state === "completed" && status.exportId) {
                clearInterval(poll);
                return fetchExportBlob(status.exportId).then((blob) => {
                  if (!stillCurrent()) return;
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = `${exportPageId}.pdf`;
                  a.click();
                  URL.revokeObjectURL(url);
                  exportPollRef.current = null;
                  setExportState("idle");
                });
              }
              if (status.state === "failed") {
                clearInterval(poll);
                if (stillCurrent()) {
                  exportPollRef.current = null;
                  setExportState("error");
                }
              }
            })
            .catch(() => {
              clearInterval(poll);
              if (stillCurrent()) {
                exportPollRef.current = null;
                setExportState("error");
              }
            });
        }, 1000);
        exportPollRef.current = { pageId: exportPageId, interval: poll };
      })
      .catch(() => {
        if (exportPageId === pageId) setExportState("error");
      });
  }

  if (authRequired === null) {
    return <div className="auth-page" />;
  }

  if (authRequired && !authUser) {
    return <LoginScreen mandatory onClose={() => {}} />;
  }

  if (healthUnavailable) {
    return <main className="connection-error" role="alert">Unable to reach Collab Workspace. Check the server connection and reload.</main>;
  }

  return (
    <div className="page-shell">
      <PageSidebar pages={recentPages} currentPageId={pageId} onSelect={joinPage} onNewPage={newPage} />

      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <div className="doc-toolbar">
          <span
            className="doc-sync-status"
            style={{ color: connectionDenied ? "var(--color-danger)" : synced ? "var(--color-accent)" : "var(--color-warning)" }}
          >
            <span className="doc-sync-dot" />
            {connectionDenied ? "Sign in again to continue" : synced ? "Synced" : navigator.onLine ? "Reconnecting — changes may be pending" : "Offline — changes will sync when reconnected"}
          </span>
          <PresenceBar localUser={localUser} peers={peers} />
          <div style={{ flex: 1 }} />
          <label style={{ fontSize: "0.78rem", color: "var(--color-text-muted)", display: "flex", alignItems: "center", gap: "0.35rem" }}>
            Page:
            <input
              value={pageIdDraft}
              onChange={(e) => setPageIdDraft(e.target.value)}
              onBlur={() => {
                if (pageIdDraft !== pageId) joinPage(pageIdDraft);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
                else if (e.key === "Escape") setPageIdDraft(pageId);
              }}
              style={{ fontFamily: "monospace", fontSize: "0.78rem", width: "9rem" }}
            />
          </label>
          <button className="toolbar-btn" onClick={() => setShowSearch(true)} title="Search pages (⌘K)">
            Search<span className="kbd">⌘K</span>
          </button>
          <button className="toolbar-btn" onClick={exportPdf} disabled={exportState === "pending"}>
            {exportState === "pending" ? "Exporting…" : exportState === "error" ? "Export failed — retry" : "Export PDF"}
          </button>
          <button className="toolbar-btn" onClick={copyLink}>
            {copied ? "Copied!" : copyFailed ? "Copy failed" : "Copy link"}
          </button>
          <button className="toolbar-btn" onClick={() => setShowVersionHistory(true)}>
            History
          </button>
          <button
            className="toolbar-btn toolbar-btn-icon"
            onClick={toggleTheme}
            aria-label={theme === "dark" ? "switch to light mode" : "switch to dark mode"}
          >
            {theme === "dark" ? "☀️" : "🌙"}
          </button>
          {authUser ? (
            <button className="toolbar-btn" onClick={clearToken} title={authUser.email}>
              Sign out
            </button>
          ) : (
            <button className="toolbar-btn" onClick={() => setShowLoginModal(true)}>
              Sign in
            </button>
          )}
        </div>

        <div className="doc-scroll">
          <div className="doc-page">
            <TitleField doc={doc} firstBlockId={flatIds[0]} />

            <div className="doc-body">
              {blocks.map((block) => (
                <BlockRow
                  key={block.id}
                  block={block}
                  depth={0}
                  doc={doc}
                  provider={provider}
                  allPeers={peers}
                  flatIds={flatIds}
                  setCursor={setCursor}
                  clearCursor={clearCursor}
                  localUserName={localUser.name}
                  addComment={addComment}
                  onToggleResolved={toggleCommentResolved}
                  onRemoveComment={removeComment}
                  mentionEmails={mentionEmails}
                />
              ))}
            </div>
          </div>
        </div>
      </div>

      {showVersionHistory && <VersionHistoryPanel pageId={pageId} onClose={() => setShowVersionHistory(false)} />}
      {showSearch && <SearchOverlay onNavigate={joinPage} onClose={() => setShowSearch(false)} />}
      {showLoginModal && <LoginScreen mandatory={false} onClose={() => setShowLoginModal(false)} />}
    </div>
  );
}

function TitleField({ doc, firstBlockId }: { doc: Y.Doc; firstBlockId: string | undefined }) {
  const titleText = useMemo(() => getTitleText(doc), [doc]);
  return (
    <RichText
      doc={doc}
      ytext={titleText}
      placeholder="Untitled"
      style={{ padding: "0.15rem 0.2rem", minHeight: "1.4em" }}
      className="doc-title-field"
      onFocusOffset={() => {}}
      onBlur={() => {}}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === "ArrowDown") {
          e.preventDefault();
          if (firstBlockId) getBlockElement(firstBlockId)?.focus();
        }
      }}
    />
  );
}

function PageSidebar({
  pages,
  currentPageId,
  onSelect,
  onNewPage,
}: {
  pages: RecentPage[];
  currentPageId: string;
  onSelect: (pageId: string) => void;
  onNewPage: () => void;
}) {
  return (
    <div className="sidebar" style={{ display: "flex", flexDirection: "column" }}>
      <button className="sidebar-new-page-btn" onClick={onNewPage}>
        + New page
      </button>
      <div className="sidebar-section-label">Recent pages</div>
      <div style={{ display: "flex", flexDirection: "column", gap: "0.1rem", overflowY: "auto" }}>
        {pages.length === 0 && (
          <span style={{ fontSize: "0.8rem", color: "var(--color-text-muted)", padding: "0.4rem 0.5rem" }}>
            None yet
          </span>
        )}
        {pages.map((page) => (
          <button
            key={page.id}
            onClick={() => onSelect(page.id)}
            className={`sidebar-page-item${page.id === currentPageId ? " active" : ""}`}
            style={{
              fontFamily: "monospace",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {page.id}
          </button>
        ))}
      </div>
    </div>
  );
}

/** First letters of up to the first two words — "Bold Fox" → "BF", "Otter" →
 *  "OT" — enough to tell overlapping avatars apart at a glance without a
 *  photo, same convention Notion/Linear/Google Docs all use for these. */
function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

function PresenceBar({
  localUser,
  peers,
}: {
  localUser: { id: string; name: string; color: string };
  peers: PresenceState[];
}) {
  return (
    <div className="presence-stack">
      {peers.map((peer) => (
        <span
          key={peer.user.id}
          className="presence-avatar"
          style={{ background: peer.user.color }}
          title={peer.user.name}
        >
          {initials(peer.user.name)}
        </span>
      ))}
      <span className="presence-avatar" style={{ background: localUser.color }} title={`${localUser.name} (you)`}>
        {initials(localUser.name)}
      </span>
    </div>
  );
}

function BlockRow({
  block,
  depth,
  doc,
  provider,
  allPeers,
  flatIds,
  setCursor,
  clearCursor,
  localUserName,
  addComment,
  onToggleResolved,
  onRemoveComment,
  mentionEmails,
}: {
  block: SerializedBlock;
  depth: number;
  doc: Y.Doc;
  provider: WebsocketProvider | null;
  allPeers: PresenceState[];
  flatIds: string[];
  setCursor: (blockId: string, offset: number) => void;
  clearCursor: () => void;
  localUserName: string;
  addComment: (blockId: string, text: string) => void;
  onToggleResolved: (commentId: string, resolved: boolean) => void;
  onRemoveComment: (commentId: string) => void;
  mentionEmails: string[];
}) {
  const [showComments, setShowComments] = useState(false);
  const [slashHighlight, setSlashHighlight] = useState(0);
  // Escape dismisses the slash menu without touching the block's text — so
  // "/foo" typed and then escaped stays as the literal text "/foo" rather
  // than being deleted. The menu's visibility is otherwise fully derived
  // from the block's own text (see slashQuery below); this just needs to
  // "win" over that derivation until the text changes again, at which point
  // the effect below clears it so a *new* "/" later still opens the menu.
  const [slashDismissed, setSlashDismissed] = useState(false);
  // Comments live in the same Y.Doc as blocks — reading them straight from
  // `doc` on every render (rather than threading a separate `comments` prop
  // down) is enough, since the parent already re-renders on any doc update
  // (blocks and comments included).
  const comments = commentsForBlock(doc, block.id);
  const peers = allPeers.filter((p) => p.cursor?.blockId === block.id);
  const isTodo = block.type === "todo";
  const isDone = isTodo && block.checked;

  const rawSlashQuery = block.type === "paragraph" && block.text.startsWith("/") ? block.text.slice(1) : null;
  const slashQuery = slashDismissed ? null : rawSlashQuery;
  const slashFiltered = slashQuery !== null ? filterBlockTypeOptions(slashQuery) : [];

  useEffect(() => {
    if (rawSlashQuery === null && slashDismissed) setSlashDismissed(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawSlashQuery]);

  // Keep the highlighted row in range as filtering narrows the list —
  // otherwise typing a more specific query after arrowing down could leave
  // the highlight pointing past the end of the now-shorter filtered list.
  useEffect(() => {
    setSlashHighlight(0);
  }, [rawSlashQuery]);

  const myIndex = flatIds.indexOf(block.id);
  const prevBlockId = myIndex > 0 ? flatIds[myIndex - 1] : undefined;
  const nextBlockId = myIndex >= 0 && myIndex < flatIds.length - 1 ? flatIds[myIndex + 1] : undefined;

  function commitSlashCommand(type: BlockType) {
    setBlockType(doc, block.id, type);
    const ytext = getBlockText(doc, block.id);
    if (ytext) doc.transact(() => ytext.delete(0, ytext.length));
    // Code and canvas blocks render no editable text of their own (see
    // BlockRow's render below) — without this, the only way to keep typing
    // afterward was hunting for the hover-only gutter's "+" button. A plain
    // paragraph sibling right after it, with the caret handed straight to
    // it, means the user never has to reach for that gutter at all.
    if (type === "code" || type === "canvas") {
      const newId = crypto.randomUUID();
      if (insertBlockAfter(doc, block.id, newId, "paragraph")) {
        const newYText = getBlockText(doc, newId);
        if (newYText) requestFocus(newYText, 0);
      }
    }
  }

  function insertBlockBelow() {
    const ytext = getBlockText(doc, block.id);
    if (!ytext) return;
    const newId = crypto.randomUUID();
    // Splitting at the very end of this block's text is exactly "insert an
    // empty sibling right after it" — the same primitive Enter-at-end-of-
    // block uses, reused here instead of a second insertion code path.
    if (splitBlock(doc, block.id, ytext.length, newId)) {
      const newYText = getBlockText(doc, newId);
      if (newYText) requestFocus(newYText, 0);
    }
  }

  const peerCursors = peers.map((p) => ({ offset: p.cursor!.offset, color: p.user.color, name: p.user.name }));

  return (
    <div className="block-row" style={{ marginBottom: "0.05rem" }}>
      <div className="block-row-line" style={{ marginLeft: `${depth * 1.5}rem` }}>
        <span className="block-gutter">
          <button type="button" aria-label="insert block below" className="block-gutter-btn" onClick={insertBlockBelow}>
            +
          </button>
          <BlockGutterMenu
            commentCount={comments.length}
            onChangeType={(type) => setBlockType(doc, block.id, type)}
            onToggleComments={() => setShowComments((v) => !v)}
            onDelete={() => deleteBlock(doc, block.id)}
          />
        </span>

        {isTodo && (
          <input
            type="checkbox"
            aria-label={block.checked ? "Mark todo item as not done" : "Mark todo item as done"}
            checked={block.checked}
            onChange={(e) => setBlockChecked(doc, block.id, e.target.checked)}
          />
        )}
        {block.type === "bullet" && <span aria-hidden="true">•</span>}

        <div style={{ position: "relative", flex: 1, minWidth: 0 }}>
          {block.type === "canvas" || block.type === "code" ? null : (
            <RichText
              doc={doc}
              ytext={getBlockText(doc, block.id)!}
              registryId={block.id}
              placeholder={depth === 0 ? "Type '/' for commands" : undefined}
              peerCursors={peerCursors}
              style={{
                fontWeight: block.type === "heading" ? 700 : 400,
                fontSize: block.type === "heading" ? "1.2rem" : "1rem",
                textDecoration: isDone ? "line-through" : "none",
                color: isDone ? "var(--color-text-muted)" : undefined,
              }}
              onFocusOffset={(offset) => setCursor(block.id, offset)}
              onBlur={clearCursor}
              onKeyDown={(e) => {
                if (slashQuery !== null) {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setSlashHighlight((h) => Math.min(h + 1, Math.max(slashFiltered.length - 1, 0)));
                    return;
                  }
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setSlashHighlight((h) => Math.max(h - 1, 0));
                    return;
                  }
                  if (e.key === "Enter" && slashFiltered.length > 0) {
                    e.preventDefault();
                    commitSlashCommand(slashFiltered[slashHighlight]?.type ?? slashFiltered[0].type);
                    return;
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setSlashDismissed(true);
                    return;
                  }
                }
                handleBlockKeyDown(e, {
                  doc,
                  blockId: block.id,
                  container: e.currentTarget,
                  prevBlockId,
                  nextBlockId,
                });
              }}
            />
          )}
          {slashQuery !== null && (
            <SlashMenu query={slashQuery} highlightIndex={slashHighlight} onSelect={commitSlashCommand} />
          )}
        </div>
      </div>

      {block.type === "canvas" && (
        <div style={{ marginLeft: `${depth * 1.5 + 1.6}rem`, marginTop: "0.4rem", marginBottom: "0.4rem" }}>
          <Suspense fallback={<div className="embed-card-loading">Loading canvas…</div>}>
            <CanvasBlock doc={doc} blockId={block.id} />
          </Suspense>
        </div>
      )}
      {block.type === "code" && (
        <div style={{ marginLeft: `${depth * 1.5 + 1.6}rem`, marginTop: "0.4rem", marginBottom: "0.4rem" }}>
          <Suspense fallback={<div className="embed-card-loading">Loading editor…</div>}>
            <CodeBlock
              doc={doc}
              blockId={block.id}
              provider={provider}
              language={block.language}
              onLanguageChange={(lang) => setBlockLanguage(doc, block.id, lang)}
            />
          </Suspense>
        </div>
      )}
      {showComments && (
        <div style={{ marginLeft: `${depth * 1.5 + 1.6}rem` }}>
          <CommentThread
            comments={comments}
            localUserName={localUserName}
            onAdd={(text) => addComment(block.id, text)}
            onToggleResolved={onToggleResolved}
            onRemove={onRemoveComment}
            mentionEmails={mentionEmails}
          />
        </div>
      )}
      {block.children.map((child) => (
        <BlockRow
          key={child.id}
          block={child}
          depth={depth + 1}
          doc={doc}
          provider={provider}
          allPeers={allPeers}
          flatIds={flatIds}
          setCursor={setCursor}
          clearCursor={clearCursor}
          localUserName={localUserName}
          addComment={addComment}
          onToggleResolved={onToggleResolved}
          onRemoveComment={onRemoveComment}
          mentionEmails={mentionEmails}
        />
      ))}
    </div>
  );
}

/** Highlights `@email` mentions in a comment's text — purely cosmetic; the
 *  actual mention *indexing* (resolving to a real user, storing a queryable
 *  row) is server-side (see comments/mentions-store.ts) and doesn't care how
 *  this renders. */
const MENTION_DISPLAY_PATTERN = /(@[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;

function renderCommentText(text: string) {
  return text.split(MENTION_DISPLAY_PATTERN).map((part, i) =>
    MENTION_DISPLAY_PATTERN.test(part) ? (
      <strong key={i} style={{ color: "var(--color-link)" }}>
        {part}
      </strong>
    ) : (
      <span key={i}>{part}</span>
    )
  );
}

function CommentThread({
  comments,
  localUserName,
  onAdd,
  onToggleResolved,
  onRemove,
  mentionEmails,
}: {
  comments: SerializedComment[];
  localUserName: string;
  onAdd: (text: string) => void;
  onToggleResolved: (commentId: string, resolved: boolean) => void;
  onRemove: (commentId: string) => void;
  mentionEmails: string[];
}) {
  const [draft, setDraft] = useState("");

  function submit() {
    const trimmed = draft.trim();
    if (!trimmed) return;
    onAdd(trimmed);
    setDraft("");
  }

  return (
    <div
      style={{
        marginTop: "0.25rem",
        paddingLeft: "0.75rem",
        borderLeft: "2px solid var(--color-border)",
        fontSize: "0.85rem",
      }}
    >
      {comments.length === 0 && <p style={{ color: "var(--color-text-muted)", margin: "0.25rem 0" }}>No comments yet.</p>}
      {comments.map((c) => (
        <div
          key={c.id}
          style={{
            display: "flex",
            gap: "0.4rem",
            alignItems: "baseline",
            flexWrap: "wrap",
            margin: "0.25rem 0",
            opacity: c.resolved ? 0.5 : 1,
          }}
        >
          <strong>{c.authorName}</strong>
          <span style={{ fontSize: "0.7rem", color: "var(--color-text-muted)" }} title={new Date(c.createdAt).toLocaleString()}>
            {formatRelativeTime(c.createdAt)}
          </span>
          <span style={{ textDecoration: c.resolved ? "line-through" : "none" }}>{renderCommentText(c.text)}</span>
          <button onClick={() => onToggleResolved(c.id, !c.resolved)} style={{ fontSize: "0.75rem" }}>
            {c.resolved ? "unresolve" : "resolve"}
          </button>
          <button onClick={() => onRemove(c.id)} aria-label="delete comment" style={{ fontSize: "0.75rem" }}>
            ×
          </button>
        </div>
      ))}
      <div style={{ display: "flex", gap: "0.4rem", marginTop: "0.4rem" }}>
        <MentionTextInput
          value={draft}
          onChange={setDraft}
          onSubmit={submit}
          candidates={mentionEmails}
          style={{ fontSize: "0.85rem" }}
          placeholder={`Comment as ${localUserName}… (@ to mention)`}
        />
        <button onClick={submit}>Add</button>
      </div>
    </div>
  );
}
