import { useCallback, useEffect, useMemo, useState } from "react";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import {
  serializeDocument,
  serializeComments,
  createComment,
  setCommentResolved,
  deleteComment,
  dedupePresenceByUser,
  type SerializedBlock,
  type SerializedComment,
  type PresenceState,
} from "@collab/shared";
import { getLocalUser } from "./localUser.js";
import { getStoredToken, type AuthUser } from "./auth.js";

const SERVER_URL = import.meta.env.VITE_WS_URL ?? "ws://localhost:1234/ws";

export interface YDocHandle {
  doc: Y.Doc;
  /** Null until the connection effect below has run (and again after it tears
   *  down on unmount) — see that effect's doc comment for why this can no
   *  longer be a non-null value produced eagerly during render. */
  provider: WebsocketProvider | null;
  blocks: SerializedBlock[];
  synced: boolean;
  /** True once the server has permanently refused this connection (expired/
   *  invalid token, or no access to this page — WS close codes 4401/4403).
   *  Distinguishing this from plain `!synced` matters: without it, a token
   *  expiring mid-session looks identical in the UI to ordinary network lag
   *  ("Connecting…" forever) instead of telling the user they need to sign
   *  in again. */
  connectionDenied: boolean;
  localUser: { id: string; name: string; color: string };
  /** Other connected clients' presence, excluding our own. */
  peers: PresenceState[];
  setCursor: (blockId: string, offset: number) => void;
  clearCursor: () => void;
  /** All comments in the doc, any block — App.tsx filters by blockId itself
   *  (same "hook exposes the whole synced doc slice, caller narrows it"
   *  shape as `blocks`). */
  comments: SerializedComment[];
  addComment: (blockId: string, text: string) => void;
  toggleCommentResolved: (commentId: string, resolved: boolean) => void;
  removeComment: (commentId: string) => void;
}

/**
 * Owns the Y.Doc + WebsocketProvider lifecycle for a given pageId and
 * re-renders the block list whenever the doc changes. This is the only
 * client-side seam that talks to the network — swapping transports later
 * touches only this hook.
 *
 * Presence (Phase 3): our own identity is published into y-protocols'
 * awareness state on connect, and every other client's awareness state is
 * surfaced as `peers`. Awareness already flowed over the wire since Phase 1
 * (it's part of the y-websocket/y-protocols convention) — this hook is what
 * actually puts data in it.
 */
export function useYDoc(pageId: string, authUser?: AuthUser | null, enabled = true): YDocHandle {
  const doc = useMemo(() => new Y.Doc(), [pageId]);
  // Recomputed (and, via the connect effect's dependency on `localUser`
  // below, reconnected) whenever sign-in state changes — logging in or out
  // mid-session should re-identify presence, not just affect new page loads.
  const localUser = useMemo(() => getLocalUser(authUser), [authUser]);

  const [blocks, setBlocks] = useState<SerializedBlock[]>([]);
  const [comments, setComments] = useState<SerializedComment[]>([]);
  const [synced, setSynced] = useState(false);
  const [connectionDenied, setConnectionDenied] = useState(false);
  const [peers, setPeers] = useState<PresenceState[]>([]);
  const [provider, setProvider] = useState<WebsocketProvider | null>(null);

  // Switching pages without a full reload (e.g. clicking a search result)
  // changes `doc` (a fresh, empty Y.Doc) synchronously mid-render via the
  // useMemo above, but `blocks`/`comments` are separate state that would
  // otherwise still hold the *previous* page's values for one render — long
  // enough for a stale block id to get diffed against the new empty doc and
  // crash (`getBlockText` returns undefined, RichText dereferences it). This
  // is React's documented pattern for resetting state in the same render a
  // prop changes, rather than one render late via an effect.
  const [blocksForPageId, setBlocksForPageId] = useState(pageId);
  if (blocksForPageId !== pageId) {
    setBlocksForPageId(pageId);
    setBlocks([]);
    setComments([]);
    setSynced(false);
    setConnectionDenied(false);
  }

  useEffect(() => {
    // `enabled` is false while the app doesn't yet know it's safe to connect
    // — before the one-time /health check resolves, or while a mandatory
    // login gate is still up. Skipping the connection entirely here (rather
    // than opening it and letting the server reject it) matters: a rejected
    // WS upgrade makes y-websocket auto-reconnect immediately, and enough of
    // those in a few seconds trips the server's per-IP `rl:ws-connect`
    // limiter (30/60s) — which then also blocks the *real*, authenticated
    // connection attempt the instant the user actually signs in, for
    // whatever's left of that window. That looked like "History doesn't
    // work" (the room never actually received the edits to snapshot) and a
    // "Connecting…" status that wouldn't clear, but the connection itself
    // was never the problem — the doomed-to-fail early attempts were.
    if (!enabled) return undefined;

    // The provider is constructed here, inside the effect, not via useMemo
    // above (as it originally was) — useMemo's contract only guarantees the
    // *value* is stable, not that its factory runs exactly once. React 18's
    // Strict Mode double-invokes render in development, and a factory that
    // opens a real WebSocket (`connect: true` does this synchronously) has
    // that side effect happen twice, with no cleanup ever run against the
    // discarded call's connection: React only ever cleans up an *effect*'s
    // return value, not a memo factory's. The result was two competing WS
    // connections per page load, one abandoned mid-handshake, and `synced`
    // permanently stuck on whichever provider's "sync" listener never fired
    // again — exactly the "stuck on connecting…" symptom this fixes. An
    // effect's mount/cleanup/remount is the one lifecycle React actually
    // guarantees symmetry for, so connection setup/teardown belongs here.
    const token = getStoredToken();
    const nextProvider = new WebsocketProvider(SERVER_URL, pageId, doc, {
      connect: true,
      params: token ? { token } : {},
    });
    setProvider(nextProvider);

    const updateBlocks = () => {
      setBlocks(serializeDocument(doc));
      setComments(serializeComments(doc));
    };
    updateBlocks();
    doc.on("update", updateBlocks);

    const onSync = (isSynced: boolean) => setSynced(isSynced);
    nextProvider.on("sync", onSync);

    // A rejection for an invalid/expired token (4401) or a denied role
    // (4403) is permanent — retrying won't ever succeed, since neither
    // changes without the user re-authenticating or being re-granted
    // access. y-websocket doesn't know that: left alone, it retries on a
    // fixed ~2.5s backoff cap forever. A single tab left open past its
    // token's expiry (or on a page it lost access to) then hammers the
    // server indefinitely — and since the server's connect-rate limiter is
    // keyed by IP, not by page, that alone can exhaust the shared budget
    // for every other page/tab on the same machine, including ones with a
    // perfectly valid session. Setting `shouldConnect = false` here is what
    // `provider.disconnect()` does internally; it stops y-websocket's own
    // reconnect loop without tearing down anything this hook still owns.
    const onConnectionClose = (event: CloseEvent | null) => {
      if (event?.code === 4401 || event?.code === 4403) {
        nextProvider.shouldConnect = false;
        setConnectionDenied(true);
      }
    };
    nextProvider.on("connection-close", onConnectionClose);

    nextProvider.awareness.setLocalStateField("presence", {
      user: localUser,
      cursor: null,
    } satisfies PresenceState);
    // A sibling top-level "user" field (not nested under "presence" like the
    // rest of our own presence system) — y-codemirror.next's remote-cursor
    // rendering (used by CodeBlock) reads `awareness state.user.{name,color}`
    // directly, a shape it defines itself, independent of ours.
    nextProvider.awareness.setLocalStateField("user", { name: localUser.name, color: localUser.color });

    const onAwarenessChange = () => {
      const states = Array.from(nextProvider.awareness.getStates().entries());
      const rawPeers = states
        .filter(([clientId]) => clientId !== nextProvider.awareness.clientID)
        .map(([, state]) => state.presence as PresenceState)
        .filter((presence): presence is PresenceState => Boolean(presence))
        // Excluding "self" by clientID alone isn't enough: a reloaded tab gets
        // a brand new clientID (fresh Y.Doc/Awareness per mount) while its
        // *previous* clientID's state can still be lingering (socket-close
        // handler hasn't run, or the unload aborted the connection before it
        // could) — that stale entry has a different clientID from us but the
        // same stable user.id, so it survives the clientID filter and shows
        // up as a "ghost" of ourselves until the ~30s awareness GC clears it.
        .filter((presence) => presence.user.id !== localUser.id);
      setPeers(dedupePresenceByUser(rawPeers));
    };
    nextProvider.awareness.on("change", onAwarenessChange);
    onAwarenessChange();

    // Proactive fast path for the same stale-self-entry problem: rather than
    // waiting on the server's socket-close handler or the ~30s awareness GC,
    // clear our own awareness state the instant this tab is going away.
    // `pagehide` (not `beforeunload`) fires on the bfcache path too and is
    // the recommended unload signal; a synchronous `setLocalState(null)`
    // here still has a chance to flush before the socket actually closes.
    const onPageHide = () => nextProvider.awareness.setLocalState(null);
    window.addEventListener("pagehide", onPageHide);

    return () => {
      window.removeEventListener("pagehide", onPageHide);
      doc.off("update", updateBlocks);
      nextProvider.off("sync", onSync);
      nextProvider.off("connection-close", onConnectionClose);
      nextProvider.awareness.off("change", onAwarenessChange);
      // Deliberately not doc.destroy() here: `doc` is the same memoized
      // instance across a Strict Mode mount/cleanup/remount cycle (unlike
      // `nextProvider`, which is fresh every effect run), so destroying it
      // in this cleanup would leave the *next* mount trying to reuse an
      // already-destroyed Y.Doc. A Y.Doc holds no external resource on its
      // own (unlike the socket the provider owns) — once nothing references
      // it, it's just garbage-collected, no explicit teardown required.
      nextProvider.destroy();
      setProvider(null);
      setSynced(false);
      setConnectionDenied(false);
    };
  }, [doc, pageId, localUser, enabled]);

  const setCursor = useCallback(
    (blockId: string, offset: number) => {
      if (!provider) return;
      const current = provider.awareness.getLocalState()?.presence as PresenceState | undefined;
      provider.awareness.setLocalStateField("presence", {
        user: current?.user ?? localUser,
        cursor: { blockId, offset },
      } satisfies PresenceState);
    },
    [provider, localUser]
  );

  const clearCursor = useCallback(() => {
    if (!provider) return;
    const current = provider.awareness.getLocalState()?.presence as PresenceState | undefined;
    provider.awareness.setLocalStateField("presence", {
      user: current?.user ?? localUser,
      cursor: null,
    } satisfies PresenceState);
  }, [provider, localUser]);

  const addComment = useCallback(
    (blockId: string, text: string) => {
      createComment(doc, crypto.randomUUID(), {
        blockId,
        authorId: localUser.id,
        authorName: localUser.name,
        text,
      });
    },
    [doc, localUser]
  );

  const toggleCommentResolved = useCallback(
    (commentId: string, resolved: boolean) => setCommentResolved(doc, commentId, resolved),
    [doc]
  );

  const removeComment = useCallback((commentId: string) => deleteComment(doc, commentId), [doc]);

  return {
    doc,
    provider,
    blocks,
    synced,
    connectionDenied,
    localUser,
    peers,
    setCursor,
    clearCursor,
    comments,
    addComment,
    toggleCommentResolved,
    removeComment,
  };
}
