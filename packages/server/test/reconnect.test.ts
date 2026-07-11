import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import * as Y from "yjs";
import ws from "ws";
import { WebsocketProvider } from "y-websocket";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RoomRegistry } from "../src/room-registry.js";
import { attachWsGateway } from "../src/ws-gateway.js";
import { createBlock, getBlockText, serializeDocument } from "@collab/shared";
import type { PresenceState } from "@collab/shared";

let httpServer: Server;
let port: number;

beforeEach(async () => {
  httpServer = createServer();
  attachWsGateway(httpServer, new RoomRegistry());
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  port = (httpServer.address() as AddressInfo).port;
});

afterEach(async () => {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

function connectClient(pageId: string, doc: Y.Doc): WebsocketProvider {
  return new WebsocketProvider(`ws://localhost:${port}/ws`, pageId, doc, {
    WebSocketPolyfill: ws as unknown as typeof WebSocket,
    // See convergence.test.ts: without this, y-websocket's in-process BroadcastChannel
    // polyfill lets same-room providers sync directly, bypassing the server (and, for
    // the disconnect/reconnect case here, bypassing the very thing being tested).
    disableBc: true,
  });
}

function waitForSync(provider: WebsocketProvider): Promise<void> {
  return new Promise((resolve) => {
    if (provider.synced) return resolve();
    provider.once("sync", () => resolve());
  });
}

function waitForCondition(check: () => boolean, timeoutMs = 2000): Promise<void> {
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

describe("reconnect / resync via version vectors", () => {
  it("catches a disconnected client up on edits it missed once it reconnects", async () => {
    const pageId = `page-${Math.random().toString(36).slice(2)}`;
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const providerA = connectClient(pageId, docA);
    const providerB = connectClient(pageId, docB);

    await Promise.all([waitForSync(providerA), waitForSync(providerB)]);

    createBlock(docA, "b1", { type: "paragraph", text: "seed" });
    await waitForCondition(() => serializeDocument(docB).length === 1);

    // B goes offline — this is exactly what a dropped WebSocket looks like
    // to the provider (it does not destroy the Y.Doc, just the connection).
    providerB.disconnect();

    // A keeps editing while B is offline.
    getBlockText(docA, "b1")?.insert(4, " + missed edit");
    createBlock(docA, "b2", { type: "paragraph", text: "second block while offline" });
    await waitForCondition(() => serializeDocument(docA).length === 2);

    // B was never sent these updates (no connection to receive them on).
    expect(serializeDocument(docB).length).toBe(1);
    expect(getBlockText(docB, "b1")?.toString()).toBe("seed");

    // Reconnect: the sync handshake (step1 = state vector, step2 = diff)
    // is what brings B up to date — not a resend of the whole history.
    providerB.connect();
    await waitForSync(providerB);
    await waitForCondition(() => serializeDocument(docB).length === 2);

    expect(serializeDocument(docB)).toEqual(serializeDocument(docA));
    expect(getBlockText(docB, "b1")?.toString()).toBe("seed + missed edit");

    providerA.destroy();
    providerB.destroy();
  });

  it("propagates presence/awareness state between clients and clears it on disconnect", async () => {
    const pageId = `page-${Math.random().toString(36).slice(2)}`;
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const providerA = connectClient(pageId, docA);
    const providerB = connectClient(pageId, docB);

    await Promise.all([waitForSync(providerA), waitForSync(providerB)]);

    const presenceA: PresenceState = { user: { id: "a", name: "Alice", color: "#111" }, cursor: null };
    providerA.awareness.setLocalStateField("presence", presenceA);

    await waitForCondition(() => {
      const states = Array.from(providerB.awareness.getStates().values());
      return states.some((s) => (s.presence as PresenceState | undefined)?.user.id === "a");
    });

    const seenByB = Array.from(providerB.awareness.getStates().values()).find(
      (s) => (s.presence as PresenceState | undefined)?.user.id === "a"
    )?.presence as PresenceState;
    expect(seenByB.user.name).toBe("Alice");

    providerA.destroy();

    await waitForCondition(() => {
      const states = Array.from(providerB.awareness.getStates().values());
      return !states.some((s) => (s.presence as PresenceState | undefined)?.user.id === "a");
    });

    providerB.destroy();
  });
});
