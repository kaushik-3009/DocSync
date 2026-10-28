import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type * as Y from "yjs";
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
  type Role,
  canEditContent,
} from "@docsync/shared";
import { useYDoc } from "./useYDoc.js";
import { RichText } from "./RichText.js";
// tldraw and CodeMirror's language packages are the two biggest contributors
// to bundle size by far (tldraw alone is several hundred kB) — most pages
// never use a canvas or code block at all, so loading them eagerly on every
// page load costs everyone for a feature most sessions never touch.
const CanvasBlock = lazy(() => import("./CanvasBlock.js").then((m) => ({ default: m.CanvasBlock })));
const CodeBlock = lazy(() => import("./CodeBlock.js").then((m) => ({ default: m.CodeBlock })));
const ImageBlock = lazy(() => import("./ImageBlock.js").then((m) => ({ default: m.ImageBlock })));
import { flattenBlockIds } from "./blockTree.js";
import { handleBlockKeyDown } from "./keyboard.js";
import { requestFocus, getBlockElement } from "./blockFocus.js";
import { SlashMenu, filterBlockTypeOptions } from "./SlashMenu.js";
import { BlockGutterMenu } from "./BlockGutterMenu.js";
import { VersionHistoryPanel } from "./VersionHistoryPanel.js";
import { AuthorshipPanel } from "./AuthorshipPanel.js";
import { SearchOverlay } from "./SearchOverlay.js";
import { MentionTextInput } from "./MentionTextInput.js";
import { formatRelativeTime } from "./relativeTime.js";
import {
  fetchPageRoles,
  requestPdfExport,
  getExportStatus,
  fetchExportDownload,
  fetchHealth,
  fetchDocuments,
  createDocument,
  fetchNotifications,
  respondToInvitation,
  respondToInvitationToken,
  subscribeToNotificationChanges,
  type WorkspaceDocument,
  type InvitationNotification,
} from "./api.js";
import { SharePanel } from "./SharePanel.js";
import { useTheme } from "./theme.js";
import { useAuthUser, signOut } from "./auth.js";
import { LoginScreen } from "./LoginScreen.js";
import type { WebsocketProvider } from "y-websocket";
import { AssistantPanel } from "./AssistantPanel.js";
import { InvitationToast } from "./InvitationToast.js";

/** Small localStorage cache for facts the app needs to start offline. */
function readCached<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? null : (JSON.parse(raw) as T);
  } catch {
    return null;
  }
}

function writeCached(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or blocked: offline start just won't be available.
  }
}

/** Browser connectivity, updated by online/offline events. A socket can take
 *  tens of seconds to notice a dead network; these events are immediate. */
function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  return online;
}

const AUTH_REQUIRED_KEY = "docsync-auth-required";
const roleCacheKey = (userId: string, pageId: string) => `docsync-role:${userId}:${pageId}`;

function getPageIdFromUrl(): string {
  const params = new URLSearchParams(window.location.search);
  return params.get("page") ?? "";
}

export function App() {
  const [pageId, setPageId] = useState(getPageIdFromUrl());
  // Separate draft state for the "Page:" input, committed on blur/Enter
  // rather than on every keystroke: `pageId` changing tears down and
  // reopens the WebSocket connection (see useYDoc), so wiring the input
  // straight to `joinPage` reconnected on every character typed while
  // editing/fixing a page id, which could also trip the server's per-IP
  // connect-rate limiter under fast typing.
  const authUser = useAuthUser();
  // Null until the one-time /health check below resolves — the client has no
  // way to know in advance whether this server was started with JWT_SECRET
  // configured, and guessing wrong in either direction is worse than a brief
  // loading state: assuming "required" would flash a login gate at every
  // guest-mode dev instance, assuming "not required" would let the app render
  // (and its WS connection silently fail to authenticate) before redirecting
  // into the gate a moment later.
  // Seeded from the last successful health check so the app can open
  // offline; refreshed whenever the server is reachable.
  const [authRequired, setAuthRequired] = useState<boolean | null>(() => readCached<boolean>(AUTH_REQUIRED_KEY));
  const [healthUnavailable, setHealthUnavailable] = useState(false);
  const [showLoginModal, setShowLoginModal] = useState(false);
  // Don't even attempt the WS connection until we know it has a real chance
  // of succeeding: an unauthenticated connection attempt against a server
  // that requires auth gets its upgrade rejected, y-websocket immediately
  // retries, and a burst of those trips the server's per-IP connect-rate
  // limiter — which then also blocks the real, authenticated attempt the
  // moment the user actually signs in. See useYDoc's `enabled` param.
  const canConnect = Boolean(pageId) && authRequired !== null && (!authRequired || Boolean(authUser));
  const {
    doc,
    provider,
    blocks,
    synced,
    loadedFromDevice,
    connectionDenied,
    connectionDeniedReason,
    localUser,
    peers,
    setCursor,
    clearCursor,
    addComment,
    toggleCommentResolved,
    removeComment,
    // Signed-in users keep an on-device copy of each page so it opens and
    // stays editable offline; Yjs merges it with the server on reconnect.
  } = useYDoc(pageId, authUser, canConnect, Boolean(authUser));
  const [documents, setDocuments] = useState<WorkspaceDocument[]>([]);
  const [documentsLoading, setDocumentsLoading] = useState(true);
  const [creatingDocument, setCreatingDocument] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [showVersionHistory, setShowVersionHistory] = useState(false);
  const [showAuthorship, setShowAuthorship] = useState(false);
  const closeAuthorship = useCallback(() => setShowAuthorship(false), []);
  const [showSharePanel, setShowSharePanel] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [showAssistant, setShowAssistant] = useState(false);
  const [notifications, setNotifications] = useState<InvitationNotification[]>([]);
  const [respondingInvitation, setRespondingInvitation] = useState(false);
  const inviteToken = new URLSearchParams(window.location.search).get("invite");
  const [mentionEmails, setMentionEmails] = useState<string[]>([]);
  // The gateway enforces this role on every update. Keeping the resolved role
  // here lets the client make viewer links genuinely read-only instead of
  // allowing edits that only appear locally and are then discarded by the
  // server. While the role fetch is pending, auth-required pages stay
  // conservative and render read-only until access is confirmed.
  const [pageRole, setPageRole] = useState<Role | null>(null);
  const canEdit = authRequired === false || canEditContent(pageRole);
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
  const online = useOnline();
  const closeSharePanel = useCallback(() => setShowSharePanel(false), []);

  useEffect(() => {
    const check = () =>
      fetchHealth()
        .then((res) => {
          setAuthRequired(res.authRequired);
          writeCached(AUTH_REQUIRED_KEY, res.authRequired);
          setHealthUnavailable(false);
        })
        // Only a first-ever visit is blocked; otherwise keep working offline.
        .catch(() => setHealthUnavailable(readCached<boolean>(AUTH_REQUIRED_KEY) === null));
    void check();
    window.addEventListener("online", check);
    return () => window.removeEventListener("online", check);
  }, []);

  const flatIds = useMemo(() => flattenBlockIds(blocks), [blocks]);

  // A seamless document is never truly "empty" — there's always a caret
  // somewhere ready to type into, the way a blank Google Doc still has a
  // blinking cursor rather than an "add your first block" prompt.
  useEffect(() => {
    if (synced && canEdit && blocks.length === 0) {
      createBlock(doc, crypto.randomUUID(), { type: "paragraph" });
    }
  }, [synced, canEdit, blocks.length, doc]);

  // Switching pages while the panel for a *different* page's history is open
  // would otherwise show stale content mid-transition.
  useEffect(() => {
    setShowVersionHistory(false);
    setShowAuthorship(false);
    setShowSharePanel(false);
    // The last role confirmed for this page lets an offline session keep
    // editing; the gateway re-checks it on every commit once reconnected.
    setPageRole(authUser && pageId ? readCached<Role>(roleCacheKey(authUser.id, pageId)) : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageId]);

  // Powers @mention autocomplete: who can even be mentioned on *this* page.
  // Requires auth (JWT_SECRET + DATABASE_URL) server-side — without it the
  // route 503s and autocomplete quietly has no suggestions, same graceful
  // degradation as the rest of this app's optional server-side features.
  //
  // Wait for synchronization before loading collaborator metadata so page
  // transitions cannot briefly display roles from the previous document.
  useEffect(() => {
    if (!synced) return;
    if (!authUser) {
      // Development-only guest mode has no RBAC row. The server is also
      // running without auth in this mode, so retain the original editor
      // behavior rather than treating every guest as a viewer.
      if (authRequired === false) setPageRole("editor");
      return;
    }
    let cancelled = false;
    fetchPageRoles(pageId)
      .then((res) => {
        if (!cancelled) {
          const current = res.roles.find((role) => role.userId === authUser.id);
          setPageRole(current?.role ?? null);
          writeCached(roleCacheKey(authUser.id, pageId), current?.role ?? null);
          setMentionEmails(res.roles.map((r) => r.email));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPageRole(null);
          setMentionEmails([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [pageId, synced, authRequired, authUser]);

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

  useEffect(() => {
    if (!authUser || authRequired !== true) return;
    let cancelled = false;
    setDocumentsLoading(true);
    fetchDocuments()
      .then(({ documents: next }) => {
        if (cancelled) return;
        setDocuments(next);
        setDocumentsLoading(false);
        const requested = getPageIdFromUrl();
        if (!pageId && requested && next.some((item) => item.id === requested)) joinPage(requested);
        else if (!pageId && next[0]) joinPage(next[0].id);
      })
      .catch(() => {
        if (!cancelled) setDocumentsLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authUser?.id, authRequired]);

  useEffect(() => {
    if (!authUser || authRequired !== true) return;
    let cancelled = false;
    const refresh = () =>
      fetchNotifications()
        .then(({ notifications: next }) => {
          if (!cancelled) setNotifications(next.filter((item) => item.type === "document_invitation" && !item.readAt));
        })
        .catch(() => undefined);
    void refresh();
    const unsubscribe = subscribeToNotificationChanges(refresh);
    // Low-frequency fallback covers a temporary Redis/socket outage.
    const interval = setInterval(refresh, 30_000);
    return () => {
      cancelled = true;
      unsubscribe();
      clearInterval(interval);
    };
    // Keyed by identity: a refreshed token for the same user must not resubscribe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authUser?.id, authRequired]);

  function joinPage(next: string) {
    const url = new URL(window.location.href);
    url.searchParams.set("page", next);
    window.history.replaceState(null, "", url.toString());
    setPageId(next);
  }

  async function newPage() {
    if (creatingDocument) return;
    setCreatingDocument(true);
    try {
      const { document } = await createDocument();
      setDocuments((current) => [document, ...current]);
      joinPage(document.id);
    } finally {
      setCreatingDocument(false);
    }
  }

  async function answerInvitation(notification: InvitationNotification, action: "accept" | "decline") {
    setRespondingInvitation(true);
    try {
      const response = (await respondToInvitation(notification.payload.invitationId, action)) as { invitation: { documentId: string } };
      setNotifications((current) => current.filter((item) => item.id !== notification.id));
      if (action === "accept") {
        const refreshed = await fetchDocuments();
        setDocuments(refreshed.documents);
        joinPage(response.invitation.documentId);
      }
    } finally {
      setRespondingInvitation(false);
    }
  }

  async function answerInviteToken(action: "accept" | "decline") {
    if (!inviteToken) return;
    setRespondingInvitation(true);
    try {
      const response = (await respondToInvitationToken(inviteToken, action)) as { invitation: { documentId: string } };
      const url = new URL(window.location.href);
      url.searchParams.delete("invite");
      window.history.replaceState(null, "", url);
      if (action === "accept") {
        const refreshed = await fetchDocuments();
        setDocuments(refreshed.documents);
        joinPage(response.invitation.documentId);
      }
    } finally {
      setRespondingInvitation(false);
    }
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

  // Enqueue → poll the job every ~1s → download the finished PDF. Each step
  // degrades to an inline error state
  // (never a thrown/unhandled rejection) since this whole pipeline is
  // optional infra that's simply absent without REDIS_URL/DATABASE_URL.
  function exportPdf() {
    const exportPageId = pageId;
    if (exportPollRef.current) {
      clearInterval(exportPollRef.current.interval);
      exportPollRef.current = null;
    }
    setExportState("pending");
    // Guards every state update below against having navigated away from
    // exportPageId in the meantime — see exportPollRef's declaration.
    const stillCurrent = () => exportPollRef.current?.pageId === exportPageId;
    requestPdfExport(exportPageId)
      .then((res) => {
        // Navigation can happen while the enqueue request is in flight. Do
        // not start a poll for a page that is no longer visible; page cleanup
        // cannot cancel a promise that resolves after it has already run.
        if (exportPageId !== pageId) return;

        const checkStatus = () => {
          getExportStatus(exportPageId, res.jobId)
            .then((status) => {
              if (status.state === "completed" && status.exportId) {
                clearInterval(poll);
                return fetchExportDownload(status.exportId).then(({ url, release }) => {
                  if (!stillCurrent()) return release();
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = `${exportPageId}.pdf`;
                  // Revoking the object URL in the same task as click() can
                  // cancel the download in Chromium/Firefox. Keep the anchor
                  // attached briefly and defer revocation until navigation
                  // has started.
                  a.style.display = "none";
                  document.body.appendChild(a);
                  a.click();
                  a.remove();
                  setTimeout(release, 1_000);
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
        };
        const poll = setInterval(checkStatus, 1000);
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
    return (
      <main className="connection-error" role="alert">
        Unable to reach Collab Workspace. Check the server connection and reload.
      </main>
    );
  }

  return (
    <div className="page-shell">
      <PageSidebar
        pages={documents}
        currentPageId={pageId}
        loading={documentsLoading}
        creating={creatingDocument}
        onSelect={joinPage}
        onNewPage={newPage}
      />

      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <div className="doc-toolbar">
          <span
            className="doc-sync-status"
            style={{
              color: connectionDenied ? "var(--color-danger)" : synced && online ? "var(--color-accent)" : "var(--color-warning)",
            }}
          >
            <span className="doc-sync-dot" />
            {connectionDenied
              ? connectionDeniedReason === "access"
                ? "You don't have access to this page"
                : "Sign in again to continue"
              : !online
                ? loadedFromDevice
                  ? "Offline — editing the copy on this device; changes sync when you reconnect"
                  : "Offline — changes will sync when reconnected"
                : synced
                  ? "Synced"
                  : "Reconnecting — changes may be pending"}
          </span>
          <PresenceBar localUser={localUser} peers={peers} />
          <div style={{ flex: 1 }} />
          <button className="toolbar-btn" onClick={() => setShowSearch(true)} title="Search pages (⌘K)">
            Search<span className="kbd">⌘K</span>
          </button>
          <button className="toolbar-btn" onClick={exportPdf} disabled={exportState === "pending"}>
            {exportState === "pending" ? "Exporting…" : exportState === "error" ? "Export failed — retry" : "Export PDF"}
          </button>
          <button className="toolbar-btn" onClick={copyLink}>
            {copied ? "Copied!" : copyFailed ? "Copy failed" : "Copy link"}
          </button>
          <button className="toolbar-btn" onClick={() => setShowSharePanel(true)}>
            Share
          </button>
          <button className="toolbar-btn" onClick={() => setShowVersionHistory(true)}>
            History
          </button>
          <button className="toolbar-btn" onClick={() => setShowAuthorship(true)} disabled={!pageId}>
            Authors
          </button>
          <button className="toolbar-btn" onClick={() => setShowAssistant((visible) => !visible)} disabled={!pageId}>
            Assistant
          </button>
          <button
            className="toolbar-btn toolbar-btn-icon"
            onClick={toggleTheme}
            aria-label={theme === "dark" ? "switch to light mode" : "switch to dark mode"}
          >
            {theme === "dark" ? "☀️" : "🌙"}
          </button>
          {authUser ? (
            <button className="toolbar-btn" onClick={() => void signOut()} title={authUser.email}>
              Sign out
            </button>
          ) : (
            <button className="toolbar-btn" onClick={() => setShowLoginModal(true)}>
              Sign in
            </button>
          )}
        </div>

        <div className="doc-scroll">
          {!pageId ? (
            <div className="workspace-empty">
              <h2>Your workspace is private</h2>
              <p>Create a document or accept an invitation to begin.</p>
              <button onClick={newPage}>Create a document</button>
            </div>
          ) : (
            <div className="doc-page">
              <TitleField doc={doc} firstBlockId={flatIds[0]} readOnly={!canEdit} />

              <div className="doc-body">
                {blocks.map((block) => (
                  <BlockRow
                    pageId={pageId}
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
                    canEdit={canEdit}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {showVersionHistory && <VersionHistoryPanel pageId={pageId} onClose={() => setShowVersionHistory(false)} />}
      {showAuthorship && <AuthorshipPanel pageId={pageId} onClose={closeAuthorship} />}
      {showSharePanel && (
        <SharePanel
          pageId={pageId}
          currentUser={authUser}
          activeUserIds={[localUser.id, ...peers.map((peer) => peer.user.id)]}
          onClose={closeSharePanel}
        />
      )}
      {showSearch && <SearchOverlay onNavigate={joinPage} onClose={() => setShowSearch(false)} />}
      {showLoginModal && <LoginScreen mandatory={false} onClose={() => setShowLoginModal(false)} />}
      {showAssistant && pageId && (
        <AssistantPanel pageId={pageId} blocks={blocks} title={getTitleText(doc).toString()} onClose={() => setShowAssistant(false)} />
      )}
      <div className="notification-stack">
        {inviteToken && authUser && (
          <div className="invitation-toast" role="status">
            <div>You have a document invitation.</div>
            <div className="invitation-actions">
              <button onClick={() => answerInviteToken("accept")} disabled={respondingInvitation}>
                Accept
              </button>
              <button className="is-secondary" onClick={() => answerInviteToken("decline")} disabled={respondingInvitation}>
                Decline
              </button>
            </div>
          </div>
        )}
        {notifications.map((notification) => (
          <InvitationToast
            key={notification.id}
            notification={notification}
            pending={respondingInvitation}
            onRespond={(action) => answerInvitation(notification, action)}
          />
        ))}
      </div>
    </div>
  );
}

function TitleField({ doc, firstBlockId, readOnly }: { doc: Y.Doc; firstBlockId: string | undefined; readOnly: boolean }) {
  const titleText = useMemo(() => getTitleText(doc), [doc]);
  return (
    <RichText
      doc={doc}
      ytext={titleText}
      placeholder="Untitled"
      style={{ padding: "0.15rem 0.2rem", minHeight: "1.4em" }}
      className="doc-title-field"
      readOnly={readOnly}
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
  loading,
  creating,
  onSelect,
  onNewPage,
}: {
  pages: WorkspaceDocument[];
  currentPageId: string;
  loading: boolean;
  creating: boolean;
  onSelect: (pageId: string) => void;
  onNewPage: () => void;
}) {
  return (
    <div className="sidebar" style={{ display: "flex", flexDirection: "column" }}>
      <button className="sidebar-new-page-btn" onClick={onNewPage} disabled={creating}>
        {creating ? "Creating…" : "+ New page"}
      </button>
      <div className="sidebar-section-label">Documents</div>
      <div style={{ display: "flex", flexDirection: "column", gap: "0.1rem", overflowY: "auto" }}>
        {!loading && pages.length === 0 && (
          <span style={{ fontSize: "0.8rem", color: "var(--color-text-muted)", padding: "0.4rem 0.5rem" }}>None yet</span>
        )}
        {pages.map((page) => (
          <button
            key={page.id}
            onClick={() => onSelect(page.id)}
            className={`sidebar-page-item${page.id === currentPageId ? " active" : ""}`}
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            <span>{page.title || "Untitled"}</span>
            <small>{page.role}</small>
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

function PresenceBar({ localUser, peers }: { localUser: { id: string; name: string; color: string }; peers: PresenceState[] }) {
  const activeCount = peers.length + 1;
  return (
    <div
      className="presence-stack"
      role="group"
      aria-label={`${activeCount} ${activeCount === 1 ? "person" : "people"} currently on this page`}
      title={`${activeCount} ${activeCount === 1 ? "person" : "people"} currently on this page`}
    >
      {peers.map((peer) => (
        <span key={peer.user.id} className="presence-avatar" style={{ background: peer.user.color }} title={peer.user.name}>
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
  canEdit,
  pageId,
}: {
  pageId: string;
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
  canEdit: boolean;
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

  const isTextBlock = block.type !== "canvas" && block.type !== "code" && block.type !== "image";
  const rawSlashQuery = isTextBlock && block.text.startsWith("/") ? block.text.slice(1) : null;
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
    // Specialized blocks own a Y.Text for their editor, but continuing below
    // them must always create a normal paragraph. Splitting the source text
    // would preserve `code`/`canvas` and duplicate the specialized block.
    if (block.type === "code" || block.type === "canvas" || block.type === "image") {
      if (insertBlockAfter(doc, block.id, newId, "paragraph")) {
        const newYText = getBlockText(doc, newId);
        if (newYText) requestFocus(newYText, 0);
      }
      return;
    }
    // Splitting at the very end of this block's text is exactly "insert an
    // empty sibling right after it" — the same primitive Enter-at-end-of-
    // block uses, reused here instead of a second insertion code path.
    if (splitBlock(doc, block.id, ytext.length, newId)) {
      const newYText = getBlockText(doc, newId);
      if (newYText) requestFocus(newYText, 0);
    }
  }

  const peerCursors = peers.map((p) => ({ offset: p.cursor!.offset, color: p.user.color, name: p.user.name }));
  const blockText = getBlockText(doc, block.id);

  return (
    <div className="block-row" style={{ marginBottom: "0.05rem" }}>
      <div className="block-row-line" style={{ marginLeft: `${depth * 1.5}rem` }}>
        <span className="block-gutter">
          {canEdit && (
            <>
              <button type="button" aria-label="insert block below" className="block-gutter-btn" onClick={insertBlockBelow}>
                +
              </button>
              <BlockGutterMenu
                commentCount={comments.length}
                onChangeType={(type) => setBlockType(doc, block.id, type)}
                onToggleComments={() => setShowComments((v) => !v)}
                onDelete={() => deleteBlock(doc, block.id)}
              />
            </>
          )}
        </span>

        {isTodo && (
          <input
            type="checkbox"
            aria-label={block.checked ? "Mark todo item as not done" : "Mark todo item as done"}
            checked={block.checked}
            disabled={!canEdit}
            onChange={(e) => setBlockChecked(doc, block.id, e.target.checked)}
          />
        )}
        {block.type === "bullet" && <span aria-hidden="true">•</span>}

        <div style={{ position: "relative", flex: 1, minWidth: 0 }}>
          {block.type === "canvas" || block.type === "code" || block.type === "image" || !blockText ? null : (
            <RichText
              doc={doc}
              ytext={blockText}
              registryId={block.id}
              placeholder={depth === 0 ? "Type '/' for commands" : undefined}
              readOnly={!canEdit}
              peerCursors={peerCursors}
              style={{
                fontWeight: block.type === "heading" ? 700 : 400,
                fontSize: block.type === "heading" ? "1.2rem" : "1rem",
                textDecoration: isDone ? "line-through" : "none",
                color: isDone ? "var(--color-text-muted)" : undefined,
              }}
              onFocusOffset={(offset) => setCursor(block.id, offset)}
              onBlur={clearCursor}
              onKeyDown={
                canEdit
                  ? (e) => {
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
                    }
                  : undefined
              }
            />
          )}
          {canEdit && slashQuery !== null && <SlashMenu query={slashQuery} highlightIndex={slashHighlight} onSelect={commitSlashCommand} />}
        </div>
      </div>

      {block.type === "canvas" && (
        <div
          style={{ marginLeft: `${depth * 1.5 + 1.6}rem`, marginTop: "0.4rem", marginBottom: "0.4rem" }}
          tabIndex={canEdit ? 0 : undefined}
          onKeyDown={
            canEdit
              ? (event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    insertBlockBelow();
                  }
                }
              : undefined
          }
        >
          <Suspense fallback={<div className="embed-card-loading">Loading canvas…</div>}>
            <CanvasBlock doc={doc} blockId={block.id} readOnly={!canEdit} />
          </Suspense>
          {canEdit && (
            <button type="button" className="special-block-tail" onClick={insertBlockBelow}>
              Click or press Enter to continue below
            </button>
          )}
        </div>
      )}
      {block.type === "image" && (
        <div style={{ marginLeft: `${depth * 1.5 + 1.6}rem`, marginTop: "0.4rem", marginBottom: "0.4rem" }}>
          <Suspense fallback={<div className="embed-card-loading">Loading image…</div>}>
            <ImageBlock doc={doc} blockId={block.id} pageId={pageId} uploadId={block.uploadId} readOnly={!canEdit} />
          </Suspense>
          {canEdit && (
            <button type="button" className="special-block-tail" onClick={insertBlockBelow}>
              Continue with text below
            </button>
          )}
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
              readOnly={!canEdit}
              onExit={insertBlockBelow}
            />
          </Suspense>
          {canEdit && (
            <button type="button" className="special-block-tail" onClick={insertBlockBelow}>
              Continue with text below
            </button>
          )}
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
            canEdit={canEdit}
          />
        </div>
      )}
      {block.children.map((child) => (
        <BlockRow
          pageId={pageId}
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
          canEdit={canEdit}
        />
      ))}
    </div>
  );
}

/** Highlights `@email` mentions in a comment's text — purely cosmetic; the
 *  actual mention *indexing* (resolving to a real user, storing a queryable
 *  row) is server-side (see comments/mentions-store.ts) and doesn't care how
 *  this renders. */
const MENTION_DISPLAY_SPLIT_PATTERN = /(@[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
const MENTION_DISPLAY_TOKEN_PATTERN = /^@[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

function renderCommentText(text: string) {
  return text.split(MENTION_DISPLAY_SPLIT_PATTERN).map((part, i) =>
    MENTION_DISPLAY_TOKEN_PATTERN.test(part) ? (
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
  canEdit,
}: {
  comments: SerializedComment[];
  localUserName: string;
  onAdd: (text: string) => void;
  onToggleResolved: (commentId: string, resolved: boolean) => void;
  onRemove: (commentId: string) => void;
  mentionEmails: string[];
  canEdit: boolean;
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
          {canEdit && (
            <>
              <button onClick={() => onToggleResolved(c.id, !c.resolved)} style={{ fontSize: "0.75rem" }}>
                {c.resolved ? "unresolve" : "resolve"}
              </button>
              <button onClick={() => onRemove(c.id)} aria-label="delete comment" style={{ fontSize: "0.75rem" }}>
                ×
              </button>
            </>
          )}
        </div>
      ))}
      {canEdit && (
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
      )}
    </div>
  );
}
