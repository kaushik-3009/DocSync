/**
 * Deterministic Node/Yjs workload for the real y-websocket-compatible wire
 * protocol. It deliberately talks only to nginx; it never uses /health as a
 * performance signal. A later collector combines this raw client evidence
 * with each replica's Prometheus metrics for durable throughput and resource
 * utilization.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
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
  /** Optional comma-separated gateway URLs; clients are spread round-robin so
   * a run can exercise cross-gateway fanout without a load balancer. */
  wsBaseUrls: string[];
  pageId: string;
  runId: string;
  /** Sharding: the harness itself is CPU-bound past ~50 clients (every client
   * applies every other client's update), so large runs split the clients
   * across processes. Shard k owns global client indices i with i % count = k. */
  shardIndex: number;
  shardCount: number;
  /** Shards share one owner token and a common start instant. */
  token: string | undefined;
  startAtMs: number | undefined;
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
    wsBaseUrls: (process.env.BENCHMARK_WS_BASE_URLS ?? wsBaseUrl)
      .split(",")
      .map((url) => url.trim().replace(/\/$/, ""))
      .filter(Boolean),
    // Filled in by createBenchmarkDocument unless an existing page is supplied:
    // the gateway only admits connections to pages that exist in `documents`.
    pageId: process.env.BENCHMARK_PAGE_ID ?? "",
    runId,
    shardIndex: Number(process.env.BENCHMARK_SHARD_INDEX ?? 0),
    shardCount: positiveInteger("BENCHMARK_SHARD_COUNT", 1),
    token: process.env.BENCHMARK_TOKEN || undefined,
    startAtMs: process.env.BENCHMARK_START_AT_MS ? Number(process.env.BENCHMARK_START_AT_MS) : undefined,
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

async function createBenchmarkDocument(config: RunSettings, token: string): Promise<string> {
  const result = await requestJson<{ document?: { id: string }; error?: string }>(`${config.httpBaseUrl}/documents`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: config.origin, authorization: `Bearer ${token}` },
    body: JSON.stringify({ title: `Benchmark ${config.runId}` }),
  });
  if (result.status !== 201 || !result.body.document) {
    throw new Error(`benchmark document creation failed (${result.status}): ${result.body.error ?? "missing document"}`);
  }
  return result.body.document.id;
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
        settings: { ...config, token: undefined, output: relative(process.cwd(), config.output) },
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
    const token = config.token ?? (await benchmarkToken(config));
    if (!config.pageId) config.pageId = await createBenchmarkDocument(config, token);
    if (process.env.BENCHMARK_SETUP_ONLY === "true") {
      // Orchestrators register once, then hand the token/page to every shard.
      process.stdout.write(`${JSON.stringify({ token, pageId: config.pageId })}\n`);
      return;
    }
    const wsUrlFor = (index: number) =>
      `${config.wsBaseUrls[index % config.wsBaseUrls.length]}/ws/${config.pageId}?token=${encodeURIComponent(token)}`;
    const localIndices = Array.from({ length: config.clients }, (_, index) => index).filter(
      (index) => index % config.shardCount === config.shardIndex
    );
    const clientIndexById = new Map<string, number>();
    for (const index of localIndices) {
      const client = new YjsWireClient(`client-${index}`, wsUrlFor(index), config.origin);
      clientIndexById.set(client.id, index);
      clients.push(client);
    }
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
    if (config.startAtMs !== undefined) {
      if (Date.now() > config.startAtMs) throw new Error("shard connected after the shared start instant; raise the start delay");
      await new Promise((resolve) => setTimeout(resolve, config.startAtMs! - Date.now()));
    }

    // Every shard knows the full deterministic mutation set, so each one can
    // verify convergence of all edits, not just its own.
    const mutationIds = Array.from({ length: config.clients }, (_, clientIndex) =>
      Array.from({ length: config.operationsPerClient }, (_, operation) => `${config.runId}-${clientIndex}-${operation}`)
    ).flat();
    phase = "mutation-propagation";
    const mutationStartedAt = Date.now();
    for (const client of clients) {
      const clientIndex = clientIndexById.get(client.id)!;
      for (let operation = 0; operation < config.operationsPerClient; operation += 1) {
        client.mutate(`${config.runId}-${clientIndex}-${operation}`, Date.now());
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
    // Each local client observes every mutation except its own.
    const expectedPeerObservations = clients.length * (mutationIds.length - config.operationsPerClient);
    const observationsComplete = observations.length === expectedPeerObservations;
    const result = {
      schemaVersion: 1,
      status: "passed",
      startedAt,
      finishedAt: new Date().toISOString(),
      settings: { ...config, token: undefined, output: relative(process.cwd(), config.output) },
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
