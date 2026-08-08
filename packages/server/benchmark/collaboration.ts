/**
 * Deterministic Node/Yjs workload for the real y-websocket-compatible wire
 * protocol. It deliberately talks only to nginx; it never uses /health as a
 * performance signal. A later collector combines this raw client evidence
 * with each replica's Prometheus metrics for durable throughput and resource
 * utilization.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import WebSocket from "ws";
import * as Y from "yjs";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as syncProtocol from "y-protocols/sync";

const MESSAGE_SYNC = 0;
const MESSAGE_MUTATION_METADATA = 2;
const REMOTE_ORIGIN = Symbol("benchmark-remote");

interface BenchmarkClient {
  readonly id: string;
  readonly doc: Y.Doc;
  readonly remoteLatencies: Array<{ mutationId: string; latencyMs: number }>;
  connect(): Promise<void>;
  mutate(mutationId: string, sentAtMs: number): void;
  close(): void;
  hasAll(mutationIds: string[]): boolean;
  errorCount(): number;
}

interface RunSettings {
  clients: number;
  operationsPerClient: number;
  propagationTimeoutMs: number;
  origin: string;
  httpBaseUrl: string;
  wsBaseUrl: string;
  pageId: string;
  runId: string;
  output: string;
}

function positiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function percentile(values: number[], percentileValue: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((percentileValue / 100) * sorted.length) - 1)];
}

function nowId(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function settingsFromEnvironment(): RunSettings {
  const runId = process.env.BENCHMARK_RUN_ID ?? nowId();
  const httpBaseUrl = (process.env.BENCHMARK_HTTP_BASE_URL ?? "http://localhost:8080").replace(/\/$/, "");
  const wsBaseUrl = (process.env.BENCHMARK_WS_BASE_URL ?? httpBaseUrl.replace(/^http/, "ws")).replace(/\/$/, "");
  return {
    clients: positiveInteger("BENCHMARK_CLIENTS", 25),
    operationsPerClient: positiveInteger("BENCHMARK_OPERATIONS_PER_CLIENT", 3),
    propagationTimeoutMs: positiveInteger("BENCHMARK_PROPAGATION_TIMEOUT_MS", 15_000),
    origin: process.env.BENCHMARK_ORIGIN ?? "http://localhost:8080",
    httpBaseUrl,
    wsBaseUrl,
    pageId: process.env.BENCHMARK_PAGE_ID ?? `bench-${runId}`.replace(/[^A-Za-z0-9_-]/g, "-"),
    runId,
    output: resolve(process.env.BENCHMARK_OUTPUT ?? `artifacts/benchmarks/${runId}/client-results.json`),
  };
}

async function requestJson<T>(url: string, init: RequestInit): Promise<{ status: number; body: T }> {
  const response = await fetch(url, init);
  const body = (await response.json()) as T;
  return { status: response.status, body };
}

async function benchmarkToken(config: RunSettings): Promise<string> {
  const email = `benchmark-${config.runId}-${randomUUID()}@invalid.test`;
  const password = `benchmark-${randomUUID()}-only`;
  const result = await requestJson<{ token?: string; error?: string }>(`${config.httpBaseUrl}/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: config.origin },
    body: JSON.stringify({ email, password }),
  });
  if (result.status !== 201 || !result.body.token) {
    throw new Error(`benchmark registration failed (${result.status}): ${result.body.error ?? "missing token"}`);
  }
  return result.body.token;
}

async function writeFailureArtifact(config: RunSettings, startedAt: string, phase: string, error: unknown): Promise<void> {
  await mkdir(dirname(config.output), { recursive: true });
  const details = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { message: String(error) };
  await writeFile(
    config.output,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        status: "failed",
        startedAt,
        finishedAt: new Date().toISOString(),
        settings: config,
        failure: { phase, ...details },
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const started = Date.now();
  return new Promise((resolvePromise, reject) => {
    const tick = () => {
      if (predicate()) return resolvePromise();
      if (Date.now() - started >= timeoutMs) return reject(new Error(`timed out waiting for ${label}`));
      setTimeout(tick, 10);
    };
    tick();
  });
}

class YjsWireClient implements BenchmarkClient {
  readonly doc = new Y.Doc();
  readonly remoteLatencies: Array<{ mutationId: string; latencyMs: number }> = [];
  private socket: WebSocket | null = null;
  private connected = false;
  private closedByHarness = false;
  private errors = 0;
  private pendingMutationMetadata: { mutationId: string; createdAtMs: number } | null = null;

  constructor(
    readonly id: string,
    private readonly url: string,
    private readonly origin: string
  ) {
    const mutations = this.doc.getMap<number>("benchmark-mutations");
    mutations.observe((event, transaction) => {
      if (transaction.origin !== REMOTE_ORIGIN) return;
      for (const mutationId of event.keys.keys()) {
        const sentAtMs = mutations.get(mutationId);
        if (typeof sentAtMs === "number") {
          this.remoteLatencies.push({ mutationId, latencyMs: Date.now() - sentAtMs });
        }
      }
    });
    this.doc.on("update", (update, origin) => {
      if (origin !== REMOTE_ORIGIN) {
        const metadata = this.pendingMutationMetadata;
        this.pendingMutationMetadata = null;
        this.sendUpdate(update, metadata ?? undefined);
      }
    });
  }

  connect(): Promise<void> {
    return new Promise((resolvePromise, reject) => {
      const socket = new WebSocket(this.url, { origin: this.origin });
      this.socket = socket;
      const timeout = setTimeout(() => reject(new Error(`client ${this.id} did not complete sync`)), 10_000);
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
          const decoder = decoding.createDecoder(bytes);
          if (decoding.readVarUint(decoder) !== MESSAGE_SYNC) return;
          const encoder = encoding.createEncoder();
          encoding.writeVarUint(encoder, MESSAGE_SYNC);
          syncProtocol.readSyncMessage(decoder, encoder, this.doc, REMOTE_ORIGIN);
          if (encoding.length(encoder) > 1 && socket.readyState === WebSocket.OPEN) socket.send(encoding.toUint8Array(encoder));
          if (!this.connected) {
            this.connected = true;
            clearTimeout(timeout);
            resolvePromise();
          }
        } catch (err) {
          clearTimeout(timeout);
          reject(err);
        }
      });
      socket.on("error", (err) => {
        this.errors += 1;
        if (!this.connected) {
          clearTimeout(timeout);
          reject(err);
        }
      });
      socket.on("close", () => {
        if (!this.closedByHarness) this.errors += 1;
      });
    });
  }

  mutate(mutationId: string, sentAtMs: number): void {
    this.pendingMutationMetadata = { mutationId, createdAtMs: sentAtMs };
    this.doc.getMap<number>("benchmark-mutations").set(mutationId, sentAtMs);
  }

  hasAll(mutationIds: string[]): boolean {
    const mutations = this.doc.getMap<number>("benchmark-mutations");
    return mutationIds.every((id) => mutations.has(id));
  }

  errorCount(): number {
    return this.errors;
  }

  close(): void {
    this.closedByHarness = true;
    this.socket?.close(1000, "benchmark complete");
    this.doc.destroy();
  }

  private sendUpdate(update: Uint8Array, metadata?: { mutationId: string; createdAtMs: number }): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
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
  }
}

async function main(): Promise<void> {
  const config = settingsFromEnvironment();
  const runStartedAt = new Date().toISOString();
  const clients: YjsWireClient[] = [];
  let phase = "registration";
  try {
    const token = await benchmarkToken(config);
    const wsUrl = `${config.wsBaseUrl}/ws/${config.pageId}?token=${encodeURIComponent(token)}`;
    clients.push(...Array.from({ length: config.clients }, (_, index) => new YjsWireClient(`client-${index}`, wsUrl, config.origin)));
    const startedAt = runStartedAt;
    phase = "connection";
    const connectionStartedAt = Date.now();
    await Promise.all(clients.map((client) => client.connect()));
    const connectionElapsedMs = Date.now() - connectionStartedAt;
    // `connect()` resolves after the first server SyncStep1. Give every
    // client a bounded settle window to send its SyncStep2 and let the
    // gateway finish registering all sockets before concurrent edits begin.
    // This keeps handshake traffic out of the mutation-propagation phase.
    await new Promise((resolve) => setTimeout(resolve, 250));

    const mutationIds: string[] = [];
    phase = "mutation-propagation";
    const mutationStartedAt = Date.now();
    for (const [clientIndex, client] of clients.entries()) {
      for (let operation = 0; operation < config.operationsPerClient; operation += 1) {
        const mutationId = `${config.runId}-${clientIndex}-${operation}`;
        mutationIds.push(mutationId);
        client.mutate(mutationId, Date.now());
      }
    }
    try {
      await waitFor(
        () => clients.every((client) => client.hasAll(mutationIds)),
        config.propagationTimeoutMs,
        "all clients to converge"
      );
    } catch (err) {
      const partial = clients.map((client) => ({
        clientId: client.id,
        mapSize: client.doc.getMap<number>("benchmark-mutations").size,
        keys: [...client.doc.getMap<number>("benchmark-mutations").keys()].sort(),
        remoteObservations: client.remoteLatencies.length,
        errors: client.errorCount(),
      }));
      throw new Error(`${err instanceof Error ? err.message : String(err)}; partial=${JSON.stringify(partial)}`);
    }
    const convergenceElapsedMs = Date.now() - mutationStartedAt;

    const observations = clients.flatMap((client) => client.remoteLatencies.map((entry) => ({ clientId: client.id, ...entry })));
    const latencies = observations.map((entry) => entry.latencyMs);
    const canonicalHashes = clients.map((client) =>
      createHash("sha256")
        .update(JSON.stringify([...client.doc.getMap<number>("benchmark-mutations").entries()].sort(([a], [b]) => a.localeCompare(b))))
      .digest("hex")
    );
    const expectedPeerObservations = mutationIds.length * Math.max(0, clients.length - 1);
    const observationsComplete = observations.length === expectedPeerObservations;
    const result = {
      schemaVersion: 1,
      status: "passed",
      startedAt,
      finishedAt: new Date().toISOString(),
      settings: config,
      connection: { successfulClients: clients.length, elapsedMs: connectionElapsedMs, errors: clients.reduce((sum, client) => sum + client.errorCount(), 0) },
      mutations: {
        sent: mutationIds.length,
        clientAcceptedUpdatesPerSecond: (mutationIds.length / Math.max(1, convergenceElapsedMs)) * 1000,
        convergenceElapsedMs,
        canonicalHash: canonicalHashes[0],
        converged: new Set(canonicalHashes).size === 1 && observationsComplete,
        observationsComplete,
        observations,
        expectedPeerObservations,
        propagationLatencyMs: { count: latencies.length, p50: percentile(latencies, 50), p95: percentile(latencies, 95), p99: percentile(latencies, 99) },
      },
      limitations: [
        "clientAcceptedUpdatesPerSecond measures updates generated and converged by the clients, not Postgres durable throughput.",
        "scripts/benchmark/collect.sh must be run for per-gateway durable counters and platform utilization before reporting a benchmark result.",
      ],
    };
    await mkdir(dirname(config.output), { recursive: true });
    await writeFile(config.output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    if (!result.mutations.converged) throw new Error(`convergence failed; raw result: ${config.output}`);
    process.stdout.write(`${JSON.stringify({ output: config.output, sent: mutationIds.length, p95Ms: result.mutations.propagationLatencyMs.p95 })}\n`);
  } catch (err) {
    await writeFailureArtifact(config, runStartedAt, phase, err).catch((artifactErr) => {
      process.stderr.write(`failed to write benchmark failure artifact: ${artifactErr instanceof Error ? artifactErr.message : String(artifactErr)}\n`);
    });
    throw err;
  } finally {
    for (const client of clients) client.close();
  }
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exitCode = 1;
});
