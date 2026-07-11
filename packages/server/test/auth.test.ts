import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Pool } from "pg";
import * as Y from "yjs";
import ws from "ws";
import { WebsocketProvider } from "y-websocket";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { createTestPool } from "./helpers/test-db.js";
import { createUser, verifyCredentials, EmailAlreadyRegisteredError } from "../src/auth/users.js";
import { signToken, verifyToken } from "../src/auth/jwt.js";
import { resolveRoleForConnection, grantRole, getExistingRole, listRoles, NotOwnerError } from "../src/auth/rbac.js";
import { recordAudit, listAuditLog } from "../src/auth/audit.js";
import { RoomRegistry } from "../src/room-registry.js";
import { attachWsGateway, type WsAuthConfig } from "../src/ws-gateway.js";
import { createBlock, getBlockText, serializeDocument } from "@collab/shared";

const JWT_SECRET = "test-secret";

let pool: Pool;

beforeEach(async () => {
  pool = await createTestPool();
});

describe("users + passwords", () => {
  it("hashes passwords and verifies correct/incorrect credentials", async () => {
    await createUser(pool, "alice@example.com", "correct-horse");
    expect(await verifyCredentials(pool, "alice@example.com", "correct-horse")).toMatchObject({
      email: "alice@example.com",
    });
    expect(await verifyCredentials(pool, "alice@example.com", "wrong-password")).toBeNull();
    expect(await verifyCredentials(pool, "nobody@example.com", "anything")).toBeNull();
  });

  it("rejects a duplicate email registration", async () => {
    await createUser(pool, "alice@example.com", "pw1");
    await expect(createUser(pool, "alice@example.com", "pw2")).rejects.toThrow(EmailAlreadyRegisteredError);
  });
});

describe("jwt", () => {
  it("round-trips a signed token and rejects a tampered or wrong-secret one", () => {
    const token = signToken({ sub: "user-1", email: "a@example.com" }, JWT_SECRET);
    expect(verifyToken(token, JWT_SECRET)).toEqual({ sub: "user-1", email: "a@example.com" });
    expect(verifyToken(token, "wrong-secret")).toBeNull();
    expect(verifyToken(token + "tampered", JWT_SECRET)).toBeNull();
  });
});

describe("RBAC", () => {
  it("auto-bootstraps the first connector of an unclaimed page as owner, and auto-enrolls anyone else as editor", async () => {
    const alice = await createUser(pool, "alice@example.com", "pw");
    const bob = await createUser(pool, "bob@example.com", "pw");

    const aliceRole = await resolveRoleForConnection(pool, "new-page", alice.id);
    expect(aliceRole).toBe("owner");

    // Bob was never explicitly granted access, but opening a page's link is
    // meant to work like a shared doc — he still gets in, as an editor
    // (not owner, since alice got there first and stays the sole admin).
    const bobRole = await resolveRoleForConnection(pool, "new-page", bob.id);
    expect(bobRole).toBe("editor");
    expect(await getExistingRole(pool, "new-page", bob.id)).toBe("editor");
  });

  it("lets an owner grant a role, which resolveRoleForConnection then honors", async () => {
    const alice = await createUser(pool, "alice@example.com", "pw");
    const bob = await createUser(pool, "bob@example.com", "pw");
    await resolveRoleForConnection(pool, "page-x", alice.id); // alice becomes owner

    await grantRole(pool, "page-x", alice.id, bob.id, "editor");
    expect(await getExistingRole(pool, "page-x", bob.id)).toBe("editor");
    expect(await resolveRoleForConnection(pool, "page-x", bob.id)).toBe("editor");
  });

  it("refuses a role grant from a non-owner", async () => {
    const alice = await createUser(pool, "alice@example.com", "pw");
    const bob = await createUser(pool, "bob@example.com", "pw");
    const carol = await createUser(pool, "carol@example.com", "pw");
    await resolveRoleForConnection(pool, "page-x", alice.id);
    await grantRole(pool, "page-x", alice.id, bob.id, "viewer");

    await expect(grantRole(pool, "page-x", bob.id, carol.id, "editor")).rejects.toThrow(NotOwnerError);
  });

  it("lists everyone with access to a page, with email — for @mention autocomplete", async () => {
    const alice = await createUser(pool, "alice@example.com", "pw");
    const bob = await createUser(pool, "bob@example.com", "pw");
    await resolveRoleForConnection(pool, "page-x", alice.id); // alice becomes owner
    await grantRole(pool, "page-x", alice.id, bob.id, "viewer");

    const roles = await listRoles(pool, "page-x");

    expect(roles).toEqual([
      { userId: alice.id, email: "alice@example.com", role: "owner" },
      { userId: bob.id, email: "bob@example.com", role: "viewer" },
    ]);
  });
});

describe("audit log", () => {
  it("records and lists entries for a page, newest first", async () => {
    const alice = await createUser(pool, "alice@example.com", "pw");
    recordAudit(pool, { userId: alice.id, pageId: "page-x", event: "ws_connected", metadata: { role: "owner" } });
    recordAudit(pool, { userId: alice.id, pageId: "page-x", event: "role_granted", metadata: { role: "editor" } });
    await new Promise((resolve) => setTimeout(resolve, 20)); // fire-and-forget writes

    const entries = await listAuditLog(pool, "page-x");
    expect(entries.map((e) => e.event)).toEqual(["role_granted", "ws_connected"]);
    expect(entries[0].metadata).toMatchObject({ role: "editor" });
  });
});

describe("ws-gateway with auth enabled", () => {
  let httpServer: Server;
  let port: number;
  let auth: WsAuthConfig;

  beforeEach(async () => {
    auth = { jwtSecret: JWT_SECRET, pool };
    httpServer = createServer();
    attachWsGateway(httpServer, new RoomRegistry(), auth);
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    port = (httpServer.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  function connect(pageId: string, doc: Y.Doc, token?: string): WebsocketProvider {
    return new WebsocketProvider(`ws://localhost:${port}/ws`, pageId, doc, {
      WebSocketPolyfill: ws as unknown as typeof WebSocket,
      params: token ? { token } : {},
      // y-websocket's default cross-tab BroadcastChannel sync (lib0/broadcastchannel) works
      // across same-room providers within a single process, not just real browser tabs — with
      // it left on, two clients in this test process sync directly in-memory and never touch
      // the server at all, which would silently defeat the whole point of these RBAC tests.
      disableBc: true,
    });
  }

  it("rejects a connection with no token", async () => {
    const doc = new Y.Doc();
    const provider = connect("page-a", doc);
    const closeCode = await new Promise<number>((resolve) => {
      provider.ws?.addEventListener("close", (event: unknown) => resolve((event as { code: number }).code));
    });
    // A real application close code, not a raw pre-handshake socket
    // destroy (which left the client with an indistinguishable 1006 and no
    // way to tell "this will never work, stop retrying" from a transient
    // network blip — see ws-gateway.ts's connection handler).
    expect(closeCode).toBe(4401);
    provider.destroy();
  });

  it("first connection to a page becomes owner and can edit; a viewer connection cannot mutate the doc", async () => {
    const owner = await createUser(pool, "owner@example.com", "pw");
    const viewerUser = await createUser(pool, "viewer@example.com", "pw");
    await resolveRoleForConnection(pool, "page-a", owner.id); // bootstrap owner ahead of connecting
    await grantRole(pool, "page-a", owner.id, viewerUser.id, "viewer");

    const ownerToken = signToken({ sub: owner.id, email: owner.email }, JWT_SECRET);
    const viewerToken = signToken({ sub: viewerUser.id, email: viewerUser.email }, JWT_SECRET);

    const ownerDoc = new Y.Doc();
    const viewerDoc = new Y.Doc();
    const ownerProvider = connect("page-a", ownerDoc, ownerToken);
    const viewerProvider = connect("page-a", viewerDoc, viewerToken);

    await Promise.all([
      new Promise<void>((resolve) => ownerProvider.once("sync", () => resolve())),
      new Promise<void>((resolve) => viewerProvider.once("sync", () => resolve())),
    ]);

    createBlock(ownerDoc, "b1", { type: "paragraph", text: "owner wrote this" });
    await waitFor(() => serializeDocument(viewerDoc).length === 1);
    expect(getBlockText(viewerDoc, "b1")?.toString()).toBe("owner wrote this");

    // The viewer's own local edit is applied locally (nothing stops a client editing its
    // own in-memory doc) but the server must not accept it as a mutating sync message —
    // so it should never reach the owner's doc.
    createBlock(viewerDoc, "b2", { type: "paragraph", text: "viewer should not be able to persist this" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(serializeDocument(ownerDoc).length).toBe(1);

    ownerProvider.destroy();
    viewerProvider.destroy();
  });

  it("auto-enrolls a signed-in user with no prior role on an already-claimed page as an editor", async () => {
    const owner = await createUser(pool, "owner2@example.com", "pw");
    const newcomer = await createUser(pool, "newcomer@example.com", "pw");
    await resolveRoleForConnection(pool, "page-b", owner.id);

    const newcomerToken = signToken({ sub: newcomer.id, email: newcomer.email }, JWT_SECRET);
    const doc = new Y.Doc();
    const provider = connect("page-b", doc, newcomerToken);

    await new Promise<void>((resolve) => provider.once("sync", () => resolve()));
    expect(await getExistingRole(pool, "page-b", newcomer.id)).toBe("editor");

    createBlock(doc, "b1", { type: "paragraph", text: "newcomer can edit too" });
    await waitFor(() => serializeDocument(doc).length === 1);

    provider.destroy();
  });
});

function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (check()) return resolve();
    const interval = setInterval(() => {
      if (check()) {
        clearInterval(interval);
        clearTimeout(timeout);
        resolve();
      }
    }, 10);
    const timeout = setTimeout(() => {
      clearInterval(interval);
      reject(new Error("timed out waiting for condition"));
    }, timeoutMs);
  });
}
