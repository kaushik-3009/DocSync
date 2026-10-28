import { useEffect, useState } from "react";
import { HTTP_BASE } from "./config.js";
import { clearOfflineCopies } from "./offline.js";

const SESSION_KEY = "docsync-session";
/** Refresh this long before the access token expires. */
const REFRESH_LEAD_MS = 60_000;

export interface AuthUser {
  id: string;
  email: string;
}

export interface Session {
  token: string;
  refreshToken: string;
}

type AuthListener = (user: AuthUser | null) => void;
const listeners = new Set<AuthListener>();
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let refreshInFlight: Promise<string | null> | null = null;

/** Decodes (never verifies — that's the server's job) a JWT's payload for
 *  display and scheduling. */
function decodeToken(token: string): (AuthUser & { expMs: number | null }) | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const decoded = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))) as { sub?: string; email?: string; exp?: number };
    if (!decoded.sub || !decoded.email) return null;
    return { id: decoded.sub, email: decoded.email, expMs: typeof decoded.exp === "number" ? decoded.exp * 1000 : null };
  } catch {
    return null;
  }
}

/** `sessionStorage`, not `localStorage`: one tab is one signed-in user, so
 *  two tabs can hold two accounts side by side (the manual collaboration
 *  test setup) without overwriting each other. */
function readSession(): Session | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

/** The current access token, even if it is about to expire; use
 *  `getFreshToken` before a request. */
export function getStoredToken(): string | null {
  return readSession()?.token ?? null;
}

export function getAuthUser(): AuthUser | null {
  const session = readSession();
  const decoded = session ? decodeToken(session.token) : null;
  // A stale access token still identifies the user while a refresh token
  // can renew it.
  return decoded ? { id: decoded.id, email: decoded.email } : null;
}

export function storeSession(session: Session): void {
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  scheduleRefresh(session.token);
  const user = getAuthUser();
  listeners.forEach((listener) => listener(user));
}

/** Forgets the session locally without telling the server (e.g. after it
 *  already rejected the session). */
export function clearToken(): void {
  sessionStorage.removeItem(SESSION_KEY);
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = null;
  listeners.forEach((listener) => listener(null));
}

/** Ends the session on the server too, so the refresh token can't be reused. */
export async function signOut(): Promise<void> {
  const session = readSession();
  const user = getAuthUser();
  clearToken();
  // Offline copies are per user; remove them so the next person on this
  // machine can't read them.
  if (user) await clearOfflineCopies(user.id).catch(() => undefined);
  if (!session) return;
  await fetch(`${HTTP_BASE}/auth/logout`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken: session.refreshToken }),
  }).catch(() => undefined);
}

/** Exchanges the refresh token for a new pair. Single-flight: concurrent
 *  callers share one request, which matters because refresh tokens are
 *  single-use and a second concurrent use would look like token theft. */
export function refreshSession(): Promise<string | null> {
  if (refreshInFlight) return refreshInFlight;
  const session = readSession();
  if (!session) return Promise.resolve(null);
  refreshInFlight = (async () => {
    try {
      const response = await fetch(`${HTTP_BASE}/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: session.refreshToken }),
      });
      if (response.status === 401) {
        clearToken();
        return null;
      }
      if (!response.ok) return session.token; // transient: keep the current token
      const next = (await response.json()) as Session;
      storeSession({ token: next.token, refreshToken: next.refreshToken });
      return next.token;
    } catch {
      return session.token;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

/** An access token valid for at least REFRESH_LEAD_MS, refreshing if needed. */
export async function getFreshToken(): Promise<string | null> {
  const token = getStoredToken();
  if (!token) return null;
  const expMs = decodeToken(token)?.expMs;
  if (expMs && expMs - Date.now() < REFRESH_LEAD_MS) return refreshSession();
  return token;
}

/** Keeps the stored token fresh in the background so WebSocket reconnects,
 *  which read it synchronously, never present an expired one. */
function scheduleRefresh(token: string): void {
  if (refreshTimer) clearTimeout(refreshTimer);
  const expMs = decodeToken(token)?.expMs;
  if (!expMs) return;
  refreshTimer = setTimeout(() => void refreshSession(), Math.max(0, expMs - Date.now() - REFRESH_LEAD_MS));
}

export function onAuthChange(listener: AuthListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAuthUser(): AuthUser | null {
  const [user, setUser] = useState<AuthUser | null>(getAuthUser);
  useEffect(() => onAuthChange(setUser), []);
  return user;
}

// Resume background refresh after a reload.
const existing = getStoredToken();
if (existing) scheduleRefresh(existing);
