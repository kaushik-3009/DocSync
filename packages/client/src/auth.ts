import { useEffect, useState } from "react";

const TOKEN_KEY = "collab-auth-token";

export interface AuthUser {
  id: string;
  email: string;
}

type AuthListener = (user: AuthUser | null) => void;
const listeners = new Set<AuthListener>();

/** Decodes (never verifies — that's the server's job) a JWT's payload segment
 *  just enough to read `sub`/`email` for display and to derive a stable
 *  identity. An expired token decodes fine but is treated as absent so a
 *  stale stored entry doesn't silently show as "signed in" while every
 *  request 401s. */
function decodeTokenPayload(token: string): AuthUser | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    const decoded = JSON.parse(json) as { sub?: string; email?: string; exp?: number };
    if (!decoded.sub || !decoded.email) return null;
    if (typeof decoded.exp === "number" && decoded.exp * 1000 < Date.now()) return null;
    return { id: decoded.sub, email: decoded.email };
  } catch {
    return null;
  }
}

/** Deliberately `sessionStorage`, not `localStorage`: this app's whole
 *  manual-testing model is "one browser tab == one simulated user" (see
 *  `localUser.ts`'s guest identity, unchanged since Phase 1) — `localStorage`
 *  is shared across every tab of the same origin, so two tabs signed into
 *  two different accounts would each overwrite the other's token, and a
 *  reload would leave both tabs showing whichever account signed in last.
 *  `sessionStorage` is per-tab by design, so each tab keeps its own signed-in
 *  session exactly the way it already keeps its own guest identity. Falls
 *  back to the pre-login-UI `?token=` URL convention (see docs/TESTING.md)
 *  so existing manual-testing links keep working. */
export function getStoredToken(): string | null {
  const stored = sessionStorage.getItem(TOKEN_KEY);
  if (stored) return stored;
  return new URLSearchParams(window.location.search).get("token");
}

export function getAuthUser(): AuthUser | null {
  const token = getStoredToken();
  return token ? decodeTokenPayload(token) : null;
}

export function storeToken(token: string): void {
  sessionStorage.setItem(TOKEN_KEY, token);
  const user = decodeTokenPayload(token);
  listeners.forEach((listener) => listener(user));
}

export function clearToken(): void {
  sessionStorage.removeItem(TOKEN_KEY);
  listeners.forEach((listener) => listener(null));
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
