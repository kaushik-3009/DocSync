import type { SerializedBlock, SerializedBlockWithDelta } from "@collab/shared";
import { getFreshToken, getStoredToken, refreshSession, type Session } from "./auth.js";
import { HTTP_BASE, WS_URL, wsProtocols } from "./config.js";

function httpBase(): string {
  return HTTP_BASE;
}

class ApiError extends Error {}

/** Authenticated fetch with one transparent retry after refreshing an
 *  access token the server rejected (e.g. expired while the tab slept). */
async function authorizedFetch(path: string, init?: RequestInit): Promise<Response> {
  const send = (token: string | null) =>
    fetch(`${httpBase()}${path}`, {
      ...init,
      headers: { ...(init?.headers ?? {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });
  const res = await send(await getFreshToken());
  if (res.status !== 401 || !getStoredToken()) return res;
  const refreshed = await refreshSession();
  return refreshed ? send(refreshed) : res;
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await authorizedFetch(path, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}) as { error?: string });
    throw new ApiError(body.error ?? `${path} failed with HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

function postJson<T>(path: string, body: unknown): Promise<T> {
  return apiFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function registerUser(email: string, password: string): Promise<Session> {
  return postJson("/auth/register", { email, password });
}

export function loginUser(email: string, password: string): Promise<Session> {
  return postJson("/auth/login", { email, password });
}

export function fetchHealth(): Promise<{ status: string; rooms: number; authRequired: boolean }> {
  return apiFetch("/health");
}

export interface VersionSummary {
  seq: number;
  startSeq: number;
  endSeq: number;
  editCount: number;
  createdAt: string;
  updatedAt: string;
}

export function fetchVersions(pageId: string): Promise<{ pageId: string; versions: VersionSummary[] }> {
  return apiFetch<{
    pageId: string;
    versions: Array<Partial<VersionSummary> & { seq: number; createdAt: string }>;
  }>(`/pages/${pageId}/versions`).then((response) => ({
    pageId: response.pageId,
    // Normalize a pre-grouping gateway response so a rolling client refresh
    // remains readable while both replicas are being rebuilt.
    versions: response.versions.map((version) => {
      const endSeq = version.endSeq ?? version.seq;
      return {
        seq: endSeq,
        startSeq: version.startSeq ?? version.seq,
        endSeq,
        editCount: version.editCount ?? 1,
        createdAt: version.createdAt,
        updatedAt: version.updatedAt ?? version.createdAt,
      };
    }),
  }));
}

export function fetchVersionAt(pageId: string, seq: number): Promise<{ pageId: string; seq: number; blocks: SerializedBlockWithDelta[] }> {
  return apiFetch(`/pages/${pageId}/versions/${seq}`);
}

export function restoreVersion(pageId: string, seq: number): Promise<{ pageId: string; restoredSeq: number; blocks: SerializedBlock[] }> {
  return apiFetch(`/pages/${pageId}/versions/${seq}/restore`, { method: "POST" });
}

export interface SearchHit {
  pageId: string;
  snippet: string;
}

export function searchPages(query: string): Promise<{ query: string; hits: SearchHit[] }> {
  return apiFetch(`/search?q=${encodeURIComponent(query)}`);
}

export interface PageRole {
  userId: string;
  email: string;
  role: "owner" | "editor" | "viewer";
}

export interface WorkspaceDocument {
  id: string;
  title: string;
  role: PageRole["role"];
  preview: string;
  createdAt: string;
  updatedAt: string;
}

export function fetchDocuments(): Promise<{ documents: WorkspaceDocument[] }> {
  return apiFetch("/documents");
}

export function createDocument(title = "Untitled"): Promise<{ document: WorkspaceDocument }> {
  return postJson("/documents", { title });
}

export interface InvitationNotification {
  id: string;
  type: "document_invitation";
  payload: {
    invitationId: string;
    documentId: string;
    documentTitle: string;
    inviterEmail: string;
    role: "editor" | "viewer";
  };
  readAt: string | null;
  createdAt: string;
}

export function fetchNotifications(): Promise<{ notifications: InvitationNotification[] }> {
  return apiFetch("/notifications");
}

/** Redis-backed cross-replica notification signal. Payloads stay in the
 * authenticated HTTP store; the socket carries only "refresh now" events. */
export function subscribeToNotificationChanges(onChange: () => void): () => void {
  let stopped = false;
  let socket: WebSocket | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  const connect = () => {
    const token = getStoredToken();
    if (stopped || !token) return;
    const endpoint = WS_URL.replace(/\/ws\/?$/, "/notifications");
    socket = new WebSocket(endpoint, wsProtocols(token));
    socket.onmessage = () => onChange();
    socket.onclose = (event) => {
      socket = null;
      if (!stopped && event.code !== 4401) retry = setTimeout(connect, 1_500);
    };
  };
  connect();
  return () => {
    stopped = true;
    if (retry) clearTimeout(retry);
    socket?.close();
  };
}

export function respondToInvitation(invitationId: string, action: "accept" | "decline") {
  return postJson(`/invitations/${invitationId}/${action}`, {});
}

export function respondToInvitationToken(token: string, action: "accept" | "decline") {
  return postJson("/invitations/respond", { token, action });
}

export function askDocumentAssistant(pageId: string, prompt: string): Promise<{ answer: string; model: string }> {
  return postJson(`/pages/${pageId}/assistant`, { prompt });
}

export type AgentOperation =
  | { op: "replace_text"; blockId: string; text: string }
  | { op: "set_block_type"; blockId: string; type: "paragraph" | "heading" | "todo" | "bullet" | "canvas" | "code" }
  | { op: "set_checked"; blockId: string; checked: boolean }
  | { op: "set_language"; blockId: string; language: "javascript" | "python" | "plaintext" }
  | { op: "insert_block"; afterBlockId?: string; type: "paragraph" | "heading" | "todo" | "bullet" | "canvas" | "code"; text?: string }
  | { op: "delete_block"; blockId: string }
  | { op: "set_title"; text: string };

export interface AgentPlan {
  summary: string;
  operations: AgentOperation[];
}

export type AssistantChatResponse =
  | { kind: "answer"; answer: string; model: string }
  | { kind: "edit_plan"; plan: AgentPlan; baseSeq: number; model: string }
  | { answer: string; model: string };

export function chatDocumentAssistant(pageId: string, prompt: string): Promise<AssistantChatResponse> {
  return postJson(`/pages/${pageId}/assistant`, { prompt });
}

export function planDocumentEdit(pageId: string, prompt: string): Promise<{ plan: AgentPlan; baseSeq: number; model: string }> {
  return postJson(`/pages/${pageId}/assistant/plan`, { prompt });
}

export function applyDocumentEdit(pageId: string, baseSeq: number, plan: AgentPlan): Promise<{ applied: number; summary: string }> {
  return postJson(`/pages/${pageId}/assistant/apply`, { baseSeq, plan });
}

export function fetchPageRoles(pageId: string): Promise<{ pageId: string; roles: PageRole[] }> {
  return apiFetch(`/pages/${pageId}/roles`);
}

/** Grants or changes a registered collaborator's role. The server deliberately
 * returns the same shape for an unregistered email so this client must not
 * infer or expose account-registration status from the response. */
export function grantPageRole(
  pageId: string,
  email: string,
  role: Exclude<PageRole["role"], "owner">
): Promise<{
  pageId: string;
  granteeEmail: string;
  role: "editor" | "viewer";
  invitationId: string;
  emailStatus: "sent" | "skipped" | "failed";
}> {
  return postJson(`/pages/${pageId}/roles`, { email, role });
}

export function requestPdfExport(pageId: string): Promise<{ pageId: string; jobId: string }> {
  return apiFetch(`/pages/${pageId}/export`, { method: "POST" });
}

export function getExportStatus(pageId: string, jobId: string): Promise<{ state: string; exportId?: string }> {
  return apiFetch(`/pages/${pageId}/export/${jobId}`);
}

/** Not JSON like every other route here — the download is a raw PDF body, so
 *  this bypasses `apiFetch` to read a Blob instead, but still attaches the
 *  same auth header. */
/** Resolves an export to something an `<a download>` can open: a short-lived
 *  presigned object-storage URL when the server stores exports in S3, or an
 *  object URL over the bytes otherwise (call `release` when done). */
export async function fetchExportDownload(exportId: string): Promise<{ url: string; release: () => void }> {
  const res = await authorizedFetch(`/exports/${exportId}`, { headers: { Accept: "application/json, application/pdf" } });
  if (!res.ok) throw new ApiError(`export download failed with HTTP ${res.status}`);
  if (res.headers.get("content-type")?.includes("application/json")) {
    const { downloadUrl } = (await res.json()) as { downloadUrl: string };
    return { url: downloadUrl, release: () => undefined };
  }
  const url = URL.createObjectURL(await res.blob());
  return { url, release: () => URL.revokeObjectURL(url) };
}

export interface AuthorshipSpan {
  text: string;
  userId: string | null;
}

export interface PageAuthorship {
  title: AuthorshipSpan[];
  blocks: Array<{ blockId: string; spans: AuthorshipSpan[] }>;
  authors: Array<{ userId: string | null; email: string | null; characters: number }>;
}

export function fetchAuthorship(pageId: string): Promise<PageAuthorship> {
  return apiFetch(`/pages/${pageId}/authorship`);
}

export interface SemanticHit {
  pageId: string;
  title: string;
  content: string;
  score: number;
}

export function semanticSearch(query: string): Promise<{ query: string; hits: SemanticHit[] }> {
  return apiFetch(`/search/semantic?q=${encodeURIComponent(query)}`);
}

export interface Citation {
  n: number;
  pageId: string;
  title: string;
  snippet: string;
}

/** Streams a cited answer from POST /workspace/ask/stream (server-sent
 *  events: citations, then deltas, then done or error). */
export async function askWorkspace(
  question: string,
  handlers: { onCitations: (citations: Citation[]) => void; onDelta: (text: string) => void },
  signal?: AbortSignal
): Promise<void> {
  const res = await authorizedFetch("/workspace/ask/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question }),
    signal,
  });
  if (!res.ok || !res.body) {
    const body = await res.json().catch(() => ({}) as { error?: string });
    throw new ApiError(body.error ?? `ask failed with HTTP ${res.status}`);
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += value;
    let boundary: number;
    while ((boundary = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const event = /^event: (.*)$/m.exec(frame)?.[1];
      const data = /^data: (.*)$/m.exec(frame)?.[1];
      if (!event || data === undefined) continue;
      const payload = JSON.parse(data);
      if (event === "citations") handlers.onCitations(payload as Citation[]);
      else if (event === "delta") handlers.onDelta((payload as { text: string }).text);
      else if (event === "error") throw new ApiError((payload as { error: string }).error);
      else if (event === "done") return;
    }
  }
}

export interface ShareLinkSummary {
  id: string;
  createdAt: string;
  expiresAt: string | null;
}

export function listShareLinks(pageId: string): Promise<{ links: ShareLinkSummary[] }> {
  return apiFetch(`/pages/${pageId}/share-links`);
}

export function createShareLink(pageId: string): Promise<{ link: ShareLinkSummary; token: string }> {
  return postJson(`/pages/${pageId}/share-links`, {});
}

export function revokeShareLink(pageId: string, linkId: string): Promise<{ revoked: boolean }> {
  return apiFetch(`/pages/${pageId}/share-links/${linkId}`, { method: "DELETE" });
}

/** Unauthenticated: anyone holding the link may read the snapshot. */
export async function fetchPublicPage(token: string): Promise<{ title: string; blocks: SerializedBlockWithDelta[] }> {
  const res = await fetch(`${httpBase()}/public/${encodeURIComponent(token)}`);
  if (!res.ok) throw new ApiError(res.status === 404 ? "This link is invalid or has been revoked." : `HTTP ${res.status}`);
  return res.json();
}

export function publicPageUrl(token: string): string {
  const url = new URL(window.location.href);
  url.search = `?share=${encodeURIComponent(token)}`;
  url.hash = "";
  return url.toString();
}
