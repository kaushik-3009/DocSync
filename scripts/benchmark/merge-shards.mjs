#!/usr/bin/env node
// Combines sharded collaboration benchmark results into one client-results.json.
// usage: node merge-shards.mjs <output.json> <shard-0.json> [shard-1.json ...]
import { readFileSync, writeFileSync } from "node:fs";

const [output, ...inputs] = process.argv.slice(2);
if (!output || inputs.length === 0) {
  console.error("usage: merge-shards.mjs <output.json> <shard.json>...");
  process.exit(64);
}

const shards = inputs.map((path) => JSON.parse(readFileSync(path, "utf8")));
const failed = shards.filter((shard) => shard.status !== "passed");
const latencies = shards.flatMap((shard) => (shard.mutations?.observations ?? []).map((entry) => entry.latencyMs)).sort((a, b) => a - b);
const percentile = (p) =>
  latencies.length ? latencies[Math.min(latencies.length - 1, Math.ceil((p / 100) * latencies.length) - 1)] : null;
const hashes = new Set(shards.map((shard) => shard.mutations?.canonicalHash));
const first = shards[0];

const merged = {
  schemaVersion: 1,
  status: failed.length === 0 && hashes.size === 1 && shards.every((shard) => shard.mutations?.converged) ? "passed" : "failed",
  startedAt: shards.map((shard) => shard.startedAt).sort()[0],
  finishedAt: shards
    .map((shard) => shard.finishedAt)
    .sort()
    .at(-1),
  settings: { ...first.settings, shardIndex: undefined, startAtMs: undefined, output, shards: shards.length },
  connection: {
    successfulClients: shards.reduce((sum, shard) => sum + (shard.connection?.successfulClients ?? 0), 0),
    errors: shards.reduce((sum, shard) => sum + (shard.connection?.errors ?? 0), 0),
  },
  mutations: {
    sent: first.mutations?.sent,
    convergenceElapsedMs: Math.max(...shards.map((shard) => shard.mutations?.convergenceElapsedMs ?? Infinity)),
    canonicalHash: first.mutations?.canonicalHash,
    converged: hashes.size === 1 && shards.every((shard) => shard.mutations?.converged),
    observations: latencies.length,
    expectedPeerObservations: shards.reduce((sum, shard) => sum + (shard.mutations?.expectedPeerObservations ?? 0), 0),
    propagationLatencyMs: { count: latencies.length, p50: percentile(50), p95: percentile(95), p99: percentile(99) },
  },
  limitations: [
    "Latency is measured from the sending client's clock to each receiving client's clock; all shards share one host clock.",
    ...(first.limitations ?? []),
  ],
};
writeFileSync(output, `${JSON.stringify(merged, null, 2)}\n`);
console.log(JSON.stringify({ output, status: merged.status, sent: merged.mutations.sent, ...merged.mutations.propagationLatencyMs }));
if (merged.status !== "passed") process.exitCode = 1;
