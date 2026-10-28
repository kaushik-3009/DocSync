/**
 * Bounded authenticated Yjs workload used by scripts/chaos/persistent-run.sh.
 *
 * This is intentionally an evidence generator, not a production client. It
 * keeps a local mutation ledger, reconnects after transport faults, and emits
 * the client-side observations needed to compare against the Postgres ops log.
 * Durable truth is calculated by summarize-chaos.ts from the append-only log;
 * this process never labels a generated edit as durable by itself.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import WebSocket from "ws";
import * as Y from "yjs";
import { WS_PROTOCOL, wsAuthProtocol } from "../src/auth/jwt.js";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as syncProtocol from "y-protocols/sync";

const MESSAGE_SYNC = 0;
const MESSAGE_MUTATION_METADATA = 2;
const REMOTE_ORIGIN = Symbol("persistent-chaos-remote");

interface Settings {
  clients: number;
  operationsPerClient: number;
  operationIntervalMs: number;
  settleMs: number;
  preMutationPauseMs: number;
  propagationTimeoutMs: number;
  httpBaseUrl: string;
  wsBaseUrl: string;
  origin: string;
  pageId: string;
  runId: string;
  output: string;
  readyFile: string;
}

interface MutationRecord {
  mutationId: string;
  clientId: string;
  generatedAt: string;
  sentLive: boolean;
  updateFingerprint?: string;
}

interface ClientResult {
  clientId: string;
  mapKeys: string[];
  mapHash: string;
  reconnects: number;
  socketErrors: number;
  duplicateWireFrames: number;
}

function positive(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function nowId(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function settings(): Settings {
  const runId = process.env.CHAOS_RUN_ID ?? nowId();
  const httpBaseUrl = (process.env.CHAOS_HTTP_URL ?? "http://localhost:8080").replace(/\/$/, "");
  return {
    clients: positive("CHAOS_CLIENTS", 8),
    operationsPerClient: positive("CHAOS_OPERATIONS_PER_CLIENT", 4),
    operationIntervalMs: positive("CHAOS_OPERATION_INTERVAL_MS", 250),
    settleMs: positive("CHAOS_SETTLE_MS", 2_000),
    preMutationPauseMs: Number(process.env.CHAOS_PRE_MUTATION_PAUSE_MS ?? 0),
    propagationTimeoutMs: positive("CHAOS_PROPAGATION_TIMEOUT_MS", 20_000),
    httpBaseUrl,
    wsBaseUrl: (process.env.CHAOS_WS_URL ?? httpBaseUrl.replace(/^http/, "ws")).replace(/\/$/, ""),
    origin: process.env.CHAOS_ORIGIN ?? httpBaseUrl,
    // Created by createChaosDocument unless an existing page is supplied: the
    // gateway only admits connections to pages that exist in `documents`.
    pageId: process.env.CHAOS_PAGE_ID ?? "",
    runId,
    output: resolve(process.env.CHAOS_OUTPUT ?? `artifacts/chaos/${runId}/workload.json`),
    readyFile: resolve(process.env.CHAOS_READY_FILE ?? `artifacts/chaos/${runId}/workload-ready.json`),
  };
}

async function registerToken(config: Settings): Promise<string> {
  const email = `chaos-${config.runId}-${randomUUID()}@invalid.test`;
  const password = `chaos-${randomUUID()}-only`;
  const response = await fetch(`${config.httpBaseUrl}/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: config.origin },
    body: JSON.stringify({ email, password }),
  });
  const body = (await response.json()) as { token?: string; error?: string };
  if (response.status !== 201 || !body.token) throw new Error(`registration failed (${response.status}): ${body.error ?? "missing token"}`);
  return body.token;
}

async function createChaosDocument(config: Settings, token: string): Promise<string> {
  const response = await fetch(`${config.httpBaseUrl}/documents`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: config.origin, authorization: `Bearer ${token}` },
    body: JSON.stringify({ title: `Chaos ${config.runId}` }),
  });
  const body = (await response.json()) as { document?: { id: string }; error?: string };
  if (response.status !== 201 || !body.document) throw new Error(`document creation failed (${response.status}): ${body.error ?? "missing document"}`);
  return body.document.id;
}

function hashMap(doc: Y.Doc): string {
  return createHash("sha256")
    .update(JSON.stringify([...doc.getMap<number>("benchmark-mutations").entries()].sort(([a], [b]) => a.localeCompare(b))))
    .digest("hex");
}

class PersistentClient {
  readonly doc = new Y.Doc();
  private socket: WebSocket | null = null;
  private stopped = false;
  private connected = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingConnect: Promise<void> | null = null;
  private activeMutationId: string | null = null;
  private readonly wireFrames = new Map<string, number>();
  private reconnectCount = 0;
  private errors = 0;
  private readonly mutationById: Map<string, MutationRecord>;

  constructor(readonly id: string, private readonly url: string, private readonly origin: string, private readonly token: string, mutationById: Map<string, MutationRecord>) {
    this.mutationById = mutationById;
    this.doc.on("update", (update, origin) => {
      if (origin === REMOTE_ORIGIN) return;
      const mutationId = this.activeMutationId;
      if (mutationId) {
        const record = this.mutationById.get(mutationId);
        if (record) {
          record.updateFingerprint = createHash("sha256").update(update).digest("hex");
          record.sentLive = this.sendUpdate(update, {
            mutationId: record.mutationId,
            createdAtMs: Date.parse(record.generatedAt),
          });
          return;
        }
      }
      // A reconnect SyncStep2 can contain several locally-created updates. It
      // is intentionally not assigned a synthetic mutation ID; final durable
      // state is reconciled from Postgres rather than this transport frame.
      this.sendUpdate(update);
    });
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    if (!this.pendingConnect) this.pendingConnect = this.connectOnce(false).finally(() => { this.pendingConnect = null; });
    return this.pendingConnect;
  }

  private connectOnce(isReconnect: boolean): Promise<void> {
    return new Promise((resolvePromise, reject) => {
      const socket = new WebSocket(this.url, [WS_PROTOCOL, wsAuthProtocol(this.token)], { origin: this.origin });
      this.socket = socket;
      let settled = false;
      const timeout = setTimeout(() => {
        if (!settled) { settled = true; reject(new Error(`${this.id} sync timeout`)); socket.close(); }
      }, 10_000);
      socket.binaryType = "arraybuffer";
      socket.on("open", () => {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_SYNC);
        syncProtocol.writeSyncStep1(encoder, this.doc);
        socket.send(encoding.toUint8Array(encoder));
      });
      socket.on("message", (data) => {
        try {
          const bytes = new Uint8Array(data as Buffer);
          const frameHash = createHash("sha256").update(bytes).digest("hex");
          this.wireFrames.set(frameHash, (this.wireFrames.get(frameHash) ?? 0) + 1);
          const decoder = decoding.createDecoder(bytes);
          if (decoding.readVarUint(decoder) !== MESSAGE_SYNC) return;
          const encoder = encoding.createEncoder();
          encoding.writeVarUint(encoder, MESSAGE_SYNC);
          syncProtocol.readSyncMessage(decoder, encoder, this.doc, REMOTE_ORIGIN);
          if (encoding.length(encoder) > 1 && socket.readyState === WebSocket.OPEN) socket.send(encoding.toUint8Array(encoder));
          if (!this.connected) {
            this.connected = true;
            if (isReconnect) this.reconnectCount += 1;
            clearTimeout(timeout);
            settled = true;
            resolvePromise();
          }
        } catch (error) {
          clearTimeout(timeout);
          if (!settled) { settled = true; reject(error); }
        }
      });
      socket.on("error", () => {
        this.errors += 1;
        if (!settled) { settled = true; clearTimeout(timeout); reject(new Error(`${this.id} socket error`)); }
      });
      socket.on("close", () => {
        clearTimeout(timeout);
        this.connected = false;
        if (!settled) { settled = true; reject(new Error(`${this.id} closed before sync`)); }
        if (!this.stopped) this.scheduleReconnect();
      });
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.stopped) return;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.stopped || this.connected) return;
      try { await this.connectOnce(true); } catch { this.scheduleReconnect(); }
    }, 250);
  }

  mutate(record: MutationRecord): void {
    this.mutationById.set(record.mutationId, record);
    this.activeMutationId = record.mutationId;
    this.doc.getMap<number>("benchmark-mutations").set(record.mutationId, Date.parse(record.generatedAt));
    this.activeMutationId = null;
  }

  async waitForConvergence(ids: string[], timeoutMs: number): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (ids.every((id) => this.doc.getMap<number>("benchmark-mutations").has(id))) return;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
    throw new Error(`${this.id} did not converge (${this.doc.getMap<number>("benchmark-mutations").size}/${ids.length})`);
  }

  private sendUpdate(update: Uint8Array, metadata?: { mutationId: string; createdAtMs: number }): boolean {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    if (metadata) {
      const metadataEncoder = encoding.createEncoder();
      encoding.writeVarUint(metadataEncoder, MESSAGE_MUTATION_METADATA);
      encoding.writeVarString(metadataEncoder, JSON.stringify(metadata));
      this.socket.send(encoding.toUint8Array(metadataEncoder));
    }
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    this.socket.send(encoding.toUint8Array(encoder));
    return true;
  }

  result(): ClientResult {
    const keys = [...this.doc.getMap<number>("benchmark-mutations").keys()].sort();
    const duplicateWireFrames = [...this.wireFrames.values()].filter((count) => count > 1).reduce((sum, count) => sum + count - 1, 0);
    return { clientId: this.id, mapKeys: keys, mapHash: hashMap(this.doc), reconnects: this.reconnectCount, socketErrors: this.errors, duplicateWireFrames };
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.close(1000, "chaos workload complete");
    this.doc.destroy();
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function main(): Promise<void> {
  const config = settings();
  if (!Number.isInteger(config.preMutationPauseMs) || config.preMutationPauseMs < 0 || config.preMutationPauseMs > 60_000) {
    throw new Error("CHAOS_PRE_MUTATION_PAUSE_MS must be an integer between 0 and 60000");
  }
  const startedAt = new Date().toISOString();
  const mutations = new Map<string, MutationRecord>();
  const clients: PersistentClient[] = [];
  let status = "passed";
  let failure: string | undefined;
  try {
    const token = await registerToken(config);
    if (!config.pageId) config.pageId = await createChaosDocument(config, token);
    const wsUrl = `${config.wsBaseUrl}/ws/${config.pageId}`;
    clients.push(...Array.from({ length: config.clients }, (_, index) => new PersistentClient(`client-${index}`, wsUrl, config.origin, token, mutations)));
    await Promise.all(clients.map((client) => client.connect()));
    await new Promise((resolvePromise) => setTimeout(resolvePromise, config.settleMs));
    await writeJson(config.readyFile, { schemaVersion: 1, runId: config.runId, pageId: config.pageId, readyAt: new Date().toISOString(), clients: clients.length });
    if (config.preMutationPauseMs > 0) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, config.preMutationPauseMs));
    }

    const mutationIds: string[] = [];
    for (let operation = 0; operation < config.operationsPerClient; operation += 1) {
      for (const [clientIndex, client] of clients.entries()) {
        const mutationId = `${config.runId}-${clientIndex}-${operation}`;
        mutationIds.push(mutationId);
        client.mutate({ mutationId, clientId: client.id, generatedAt: new Date().toISOString(), sentLive: false });
        await new Promise((resolvePromise) => setTimeout(resolvePromise, config.operationIntervalMs));
      }
    }
    await Promise.all(clients.map((client) => client.waitForConvergence(mutationIds, config.propagationTimeoutMs)));
    await new Promise((resolvePromise) => setTimeout(resolvePromise, config.settleMs));
    const clientResults = clients.map((client) => client.result());
    const mapHashes = new Set(clientResults.map((client) => client.mapHash));
    const sentLive = [...mutations.values()].filter((mutation) => mutation.sentLive).map((mutation) => mutation.mutationId);
    await writeJson(config.output, {
      schemaVersion: 1,
      status,
      startedAt,
      finishedAt: new Date().toISOString(),
      settings: config,
      pageId: config.pageId,
      mutations: { generated: mutationIds, acceptedByHarness: mutationIds, sentLive, records: [...mutations.values()] },
      clients: clientResults,
      convergence: { clientCount: clients.length, converged: mapHashes.size === 1, canonicalHashes: [...mapHashes] },
      claimBoundary: "acceptedByHarness means a deterministic mutation intent was generated; durable/lost are calculated from the Postgres ops log by summarize-chaos.ts.",
    });
    if (mapHashes.size !== 1) throw new Error("client documents did not converge");
  } catch (error) {
    status = "failed";
    failure = error instanceof Error ? error.message : String(error);
    await writeJson(config.output, { schemaVersion: 1, status, startedAt, finishedAt: new Date().toISOString(), settings: config, pageId: config.pageId, mutations: { generated: [...mutations.keys()], acceptedByHarness: [...mutations.keys()], sentLive: [...mutations.values()].filter((m) => m.sentLive).map((m) => m.mutationId), records: [...mutations.values()] }, clients: clients.map((client) => client.result()), failure, claimBoundary: "durable/lost remain unmeasured until summarize-chaos.ts reconstructs Postgres state." });
    process.exitCode = 1;
  } finally {
    for (const client of clients) client.stop();
  }
}

void main();
