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
  createdAt: string;
}

export function fetchVersions(pageId: string): Promise<{ pageId: string; versions: VersionSummary[] }> {
  return apiFetch(`/pages/${pageId}/versions`);
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

export function fetchPageRoles(pageId: string): Promise<{ pageId: string; roles: PageRole[] }> {
  return apiFetch(`/pages/${pageId}/roles`);
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
