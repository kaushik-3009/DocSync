import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import * as Y from "yjs";
import ws from "ws";
import { WebsocketProvider } from "y-websocket";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RoomRegistry } from "../src/room-registry.js";
import { attachWsGateway } from "../src/ws-gateway.js";
import type { WebSocketServer } from "ws";
import { createBlock, getRootOrder, getBlockText, serializeDocument } from "@collab/shared";

/**
 * End-to-end test: real HTTP server + real ws-gateway + real y-websocket
 * client providers (the same library the browser test client uses). This
 * proves wire-protocol compatibility, not just in-memory Yjs merge logic.
 */

let httpServer: Server;
let port: number;
let providers: WebsocketProvider[];
let wss: WebSocketServer;

beforeEach(async () => {
  providers = [];
  httpServer = createServer();
  wss = attachWsGateway(httpServer, new RoomRegistry());
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  port = (httpServer.address() as AddressInfo).port;
});

afterEach(async () => {
  providers.forEach((provider) => provider.destroy());
  wss.clients.forEach((client) => client.terminate());
  // ws waits for every client close event before invoking its close callback.
  // A terminated client can leave that callback pending in Node's test runner,
  // so bound teardown while still giving normal shutdown a chance to finish.
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 500);
    wss.close(() => { clearTimeout(timer); resolve(); });
  });
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 500);
    httpServer.close(() => { clearTimeout(timer); resolve(); });
  });
});

function connectClient(pageId: string, doc: Y.Doc): WebsocketProvider {
  const provider = new WebsocketProvider(`ws://localhost:${port}/ws`, pageId, doc, {
    WebSocketPolyfill: ws as unknown as typeof WebSocket,
    // y-websocket also syncs same-room providers directly via lib0's in-process
    // BroadcastChannel polyfill (meant for real browser tabs) — without disabling it,
    // multiple providers in this one Node process would converge without ever going
    // through the server, silently defeating what this test exists to prove.
    disableBc: true,
  });
  providers.push(provider);
  return provider;
}

function waitForSync(provider: WebsocketProvider): Promise<void> {
  return new Promise((resolve) => {
    if (provider.synced) return resolve();
    provider.once("sync", () => resolve());
  });
}

describe("concurrent edit convergence", () => {
  it("converges two clients editing the same block concurrently", async () => {
    const pageId = `page-${Math.random().toString(36).slice(2)}`;
    const docA = new Y.Doc();
    const docB = new Y.Doc();

    const providerA = connectClient(pageId, docA);
    const providerB = connectClient(pageId, docB);

    await Promise.all([waitForSync(providerA), waitForSync(providerB)]);

    createBlock(docA, "block-1", { type: "paragraph", text: "hello" });

    // wait for B to observe the new block before it edits concurrently
    await new Promise<void>((resolve) => {
      const check = () => (getRootOrder(docB).length > 0 ? resolve() : undefined);
      docB.on("update", check);
      check();
    });

    // Concurrent edits: A appends to the end, B inserts at the start.
    getBlockText(docA, "block-1")?.insert(5, " world");
    getBlockText(docB, "block-1")?.insert(0, ">> ");

    // wait for both docs' text to stabilize at the same length
    const expectedLength = ">> hello world".length;
    await Promise.all([
      new Promise<void>((resolve) => {
        const check = () => ((getBlockText(docA, "block-1")?.length ?? 0) >= expectedLength ? resolve() : undefined);
        docA.on("update", check);
        check();
      }),
      new Promise<void>((resolve) => {
        const check = () => ((getBlockText(docB, "block-1")?.length ?? 0) >= expectedLength ? resolve() : undefined);
        docB.on("update", check);
        check();
      }),
    ]);

    const textA = getBlockText(docA, "block-1")?.toString();
    const textB = getBlockText(docB, "block-1")?.toString();

    expect(textA).toBe(textB);
    expect(textA).toContain("hello");
    expect(textA).toContain("world");
    expect(textA?.startsWith(">> ")).toBe(true);

    expect(serializeDocument(docA)).toEqual(serializeDocument(docB));

    providerA.destroy();
    providerB.destroy();
  });

  it("converges block creation order across three clients", async () => {
    const pageId = `page-${Math.random().toString(36).slice(2)}`;
    const docs = [new Y.Doc(), new Y.Doc(), new Y.Doc()];
    const providers = docs.map((doc) => connectClient(pageId, doc));

    await Promise.all(providers.map(waitForSync));

    createBlock(docs[0], "b1", { type: "paragraph", text: "first" });
    createBlock(docs[1], "b2", { type: "paragraph", text: "second" });
    createBlock(docs[2], "b3", { type: "paragraph", text: "third" });

    await new Promise<void>((resolve) => {
      const check = () => (docs.every((d) => getRootOrder(d).length === 3) ? resolve() : undefined);
      docs.forEach((d) => d.on("update", check));
      check();
    });

    const [s0, s1, s2] = docs.map(serializeDocument);
    expect(s1).toEqual(s0);
    expect(s2).toEqual(s0);
    expect(s0.map((b) => b.text).sort()).toEqual(["first", "second", "third"]);

    providers.forEach((p) => p.destroy());
  });
});
