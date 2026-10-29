import { randomUUID } from "node:crypto";
import type { Browser, BrowserContext, Page, WebSocketRoute } from "@playwright/test";
import { E2E_API_URL } from "../playwright.config.js";

export interface TestUser {
  email: string;
  token: string;
  refreshToken: string;
}

async function api<T>(path: string, init: { method?: string; token?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(`${E2E_API_URL}${path}`, {
    method: init.method ?? "GET",
    headers: { "content-type": "application/json", ...(init.token ? { authorization: `Bearer ${init.token}` } : {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (!response.ok) throw new Error(`${path} failed with ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
}

export async function registerUser(label: string): Promise<TestUser> {
  const email = `${label}-${randomUUID().slice(0, 8)}@e2e.test`;
  const session = await api<{ token: string; refreshToken: string }>("/auth/register", {
    method: "POST",
    body: { email, password: "correct horse battery staple" },
  });
  return { email, ...session };
}

export async function createDocument(owner: TestUser, title: string): Promise<string> {
  return (await api<{ document: { id: string } }>("/documents", { method: "POST", token: owner.token, body: { title } })).document.id;
}

/** Invites `member` with `role` and accepts on their behalf. */
export async function share(owner: TestUser, pageId: string, member: TestUser, role: "editor" | "viewer"): Promise<void> {
  const { invitationId } = await api<{ invitationId: string }>(`/pages/${pageId}/roles`, {
    method: "POST",
    token: owner.token,
    body: { email: member.email, role },
  });
  await api(`/invitations/${invitationId}/accept`, { method: "POST", token: member.token, body: {} });
}

/** A browser context already signed in as `user` (session lives in sessionStorage). */
export async function signedInContext(browser: Browser, user: TestUser): Promise<BrowserContext> {
  const context = await browser.newContext();
  await context.addInitScript(
    (session) => {
      window.sessionStorage.setItem("docsync-session", JSON.stringify(session));
    },
    { token: user.token, refreshToken: user.refreshToken }
  );
  return context;
}

export async function openPage(context: BrowserContext, pageId: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`/?page=${pageId}`);
  return page;
}

/**
 * Real network loss for a context. `context.setOffline` flips navigator.onLine
 * but does not reliably sever an already-open WebSocket, so the collaboration
 * socket is routed through Playwright and cut explicitly.
 */
export async function controllableNetwork(context: BrowserContext): Promise<{ goOffline(): Promise<void>; goOnline(): Promise<void> }> {
  let offline = false;
  const live = new Set<WebSocketRoute>();
  await context.routeWebSocket(/\/ws\//, (socket) => {
    if (offline) {
      void socket.close();
      return;
    }
    socket.connectToServer();
    live.add(socket);
    socket.onClose(() => live.delete(socket));
  });
  return {
    async goOffline() {
      offline = true;
      await context.setOffline(true);
      await Promise.all([...live].map((socket) => socket.close()));
    },
    async goOnline() {
      offline = false;
      await context.setOffline(false);
    },
  };
}
