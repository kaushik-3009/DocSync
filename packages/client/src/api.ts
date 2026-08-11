import type { SerializedBlock, SerializedBlockWithDelta } from "@collab/shared";
import { getStoredToken } from "./auth.js";

const WS_URL = import.meta.env.VITE_WS_URL ?? "ws://localhost:1234/ws";

/** The collab server's plain-HTTP routes (versions, restore, roles, ...) live
 *  on the same host/port as the WebSocket gateway — just derive one URL from
 *  the other rather than requiring a second env var kept in sync with it. */
function httpBase(): string {
  return WS_URL.replace(/^ws/, "http").replace(/\/ws\/?$/, "");
}

class ApiError extends Error {}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getStoredToken();
  const res = await fetch(`${httpBase()}${path}`, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
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

/** Neither call attaches a stale Authorization header on purpose — you're
 *  acquiring a token, not using one — but `apiFetch` doing so anyway is
 *  harmless since these two routes don't check auth. */
export function registerUser(email: string, password: string): Promise<{ token: string }> {
  return postJson("/auth/register", { email, password });
}

export function loginUser(email: string, password: string): Promise<{ token: string }> {
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

export function fetchVersionAt(
  pageId: string,
  seq: number
): Promise<{ pageId: string; seq: number; blocks: SerializedBlockWithDelta[] }> {
  return apiFetch(`/pages/${pageId}/versions/${seq}`);
}

export function restoreVersion(
  pageId: string,
  seq: number
): Promise<{ pageId: string; restoredSeq: number; blocks: SerializedBlock[] }> {
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
    socket = new WebSocket(`${endpoint}?token=${encodeURIComponent(token)}`);
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
): Promise<{ pageId: string; granteeEmail: string; role: "editor" | "viewer"; invitationId: string; emailStatus: "sent" | "skipped" | "failed" }> {
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
export async function fetchExportBlob(exportId: string): Promise<Blob> {
  const token = getStoredToken();
  const res = await fetch(`${httpBase()}/exports/${exportId}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new ApiError(`export download failed with HTTP ${res.status}`);
  return res.blob();
}
