#!/usr/bin/env node

/**
 * Bounded resource sampler for the named Docker benchmark topology.
 *
 * This intentionally uses only point-in-time Docker stats and the application's
 * existing /metrics endpoint. It is an evidence collector, not a capacity
 * oracle: the resulting summary must be interpreted with the limitations it
 * writes next to every run.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const argv = process.argv.slice(2);
function option(name, fallback) {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
}

const summarizeFile = option("--summarize-file", "");
const runId = option("--run-id", "");
const durationSeconds = Number(option("--duration-seconds", "60"));
const intervalSeconds = Number(option("--interval-seconds", "5"));
const project = process.env.BENCHMARK_PROJECT || "collab-benchmark";
const envFile = process.env.BENCHMARK_ENV_FILE || ".env.benchmark";
const outputDir = path.resolve(option("--output-dir", runId ? `artifacts/benchmarks/${runId}` : ""));

if (summarizeFile) {
  writeSummary(path.resolve(summarizeFile));
  process.exit(0);
}

if (
  !runId ||
  !Number.isFinite(durationSeconds) ||
  durationSeconds <= 0 ||
  durationSeconds > 3600 ||
  !Number.isFinite(intervalSeconds) ||
  intervalSeconds <= 0 ||
  intervalSeconds > 60
) {
  console.error(
    "usage: resource-sampler.mjs --run-id <id> [--duration-seconds 60] [--interval-seconds 5] [--output-dir artifacts/benchmarks/<id>]"
  );
  process.exit(64);
}

fs.mkdirSync(outputDir, { recursive: true });
const samplesFile = path.join(outputDir, "resource-samples.jsonl");
fs.writeFileSync(samplesFile, "");
const compose = [
  "compose",
  "--project-name",
  project,
  "--env-file",
  envFile,
  "-f",
  "docker-compose.yml",
  "-f",
  "docker-compose.benchmark.yml",
];
const envValues = readEnvFile(envFile);
const startedAt = new Date().toISOString();
const startedMs = Date.now();
let sampleCount = 0;

console.log(JSON.stringify({ event: "resource_sampler_started", runId, durationSeconds, intervalSeconds, samplesFile }));
while (Date.now() - startedMs < durationSeconds * 1000) {
  const sample = collectSample();
  sample.index = sampleCount++;
  fs.appendFileSync(samplesFile, JSON.stringify(sample) + "\n");
  const remaining = Math.min(intervalSeconds * 1000, Math.max(0, durationSeconds * 1000 - (Date.now() - startedMs)));
  if (remaining > 0) await sleep(remaining);
}

const summaryPath = path.join(outputDir, "resource-summary.json");
writeSummary(samplesFile, {
  runId,
  startedAt,
  endedAt: new Date().toISOString(),
  durationSeconds,
  intervalSeconds,
  samplesFile: path.relative(process.cwd(), samplesFile),
  summaryPath: path.relative(process.cwd(), summaryPath),
});
console.log(JSON.stringify({ event: "resource_sampler_finished", runId, sampleCount, summaryPath }));

function readEnvFile(file) {
  try {
    return Object.fromEntries(
      fs
        .readFileSync(file, "utf8")
        .split(/\r?\n/)
        .flatMap((line) => {
          const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
          if (!match) return [];
          return [[match[1], match[2].replace(/^(['"])(.*)\1$/, "$2")]];
        })
    );
  } catch {
    return {};
  }
}

function docker(args, timeout = 5000) {
  return execFileSync("docker", [...compose, ...args], { encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function safeDocker(args, timeout = 5000) {
  try {
    return { value: docker(args, timeout), error: null };
  } catch (error) {
    return { value: "", error: error instanceof Error ? error.message : String(error) };
  }
}

function collectSample() {
  const sample = { timestamp: new Date().toISOString(), dockerStats: [], gateways: {}, postgres: null, redis: null, errors: [] };

  const stats = safeDocker(["stats", "--no-stream", "--format", "json"]);
  if (stats.error) sample.errors.push({ source: "docker-stats", error: stats.error });
  sample.dockerStats = stats.value
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });

  for (const service of ["server-a", "server-b"]) {
    const metrics = safeDocker(
      ["exec", "-T", service, "node", "-e", "fetch('http://127.0.0.1:1234/metrics').then(r => r.text()).then(console.log)"],
      3000
    );
    if (metrics.error) sample.errors.push({ source: `${service}-metrics`, error: metrics.error });
    sample.gateways[service] = parsePrometheus(metrics.value);
  }

  const pgUser = envValues.POSTGRES_USER || "collab";
  const pgDb = envValues.POSTGRES_DB || "collab";
  const pgPassword = envValues.POSTGRES_PASSWORD || "";
  const pgQuery =
    "SELECT datname,numbackends,xact_commit,xact_rollback,blks_read,blks_hit,tup_inserted,tup_updated,tup_deleted FROM pg_stat_database WHERE datname=current_database();";
  const postgres = safeDocker(
    ["exec", "-T", "-e", `PGPASSWORD=${pgPassword}`, "postgres", "psql", "-U", pgUser, "-d", pgDb, "-At", "-F", "|", "-c", pgQuery],
    3000
  );
  if (postgres.error) sample.errors.push({ source: "postgres", error: postgres.error });
  sample.postgres = parsePostgres(postgres.value);

  const redisPassword = envValues.REDIS_PASSWORD || "";
  const redis = safeDocker(
    ["exec", "-T", "-e", `REDISCLI_AUTH=${redisPassword}`, "redis", "redis-cli", "INFO", "memory", "INFO", "stats", "INFO", "clients"],
    3000
  );
  if (redis.error) sample.errors.push({ source: "redis", error: redis.error });
  sample.redis = parseRedis(redis.value);
  return sample;
}

function parsePrometheus(text) {
  const wanted =
    /^(ws_connections_active|ws_connections_total|collab_updates_pending|collab_fanout_outbox_pending|process_resident_memory_bytes|process_cpu_user_seconds_total|process_cpu_system_seconds_total|collab_updates_total|collab_fanout_outbox_total)\b/;
  const result = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([^ ]+)\s+([-+0-9.eE]+)$/);
    if (!match || !wanted.test(match[1])) continue;
    result[match[1]] = Number(match[2]);
  }
  return result;
}

function parsePostgres(text) {
  const row = text.split(/\r?\n/).find(Boolean);
  if (!row) return null;
  const fields = row.split("|");
  const names = [
    "datname",
    "numbackends",
    "xact_commit",
    "xact_rollback",
    "blks_read",
    "blks_hit",
    "tup_inserted",
    "tup_updated",
    "tup_deleted",
  ];
  return Object.fromEntries(names.map((name, index) => [name, index === 0 ? fields[index] : Number(fields[index] || 0)]));
}

function parseRedis(text) {
  const result = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_]+):(.+)$/);
    if (!match) continue;
    const value = Number(match[2]);
    result[match[1]] = Number.isFinite(value) ? value : match[2];
  }
  return result;
}

function parseCpu(value) {
  const match = String(value || "").match(/([0-9.]+)%/);
  return match ? Number(match[1]) : null;
}

function parseMemoryMiB(value) {
  const match = String(value || "").match(/^\s*([0-9.]+)\s*([KMG]i?B|B)/i);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const divisor = unit === "b" ? 1024 * 1024 : unit.startsWith("k") ? 1024 : unit.startsWith("g") ? 1 / 1024 : 1;
  return amount / divisor;
}

function serviceName(record) {
  const name = String(record.Name || record.name || "");
  for (const service of ["server-a", "server-b", "postgres", "redis", "worker", "lb"])
    if (name.includes(`-${service}-`) || name.includes(`_${service}_`)) return service;
  return name || "unknown";
}

function quantile(values, q) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const index = (sorted.length - 1) * q;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  return lower === upper ? sorted[lower] : sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function stats(values, unit) {
  const valid = values.filter(Number.isFinite);
  return {
    unit,
    count: valid.length,
    p50: quantile(valid, 0.5),
    p95: quantile(valid, 0.95),
    max: valid.length ? Math.max(...valid) : null,
  };
}

function writeSummary(file, metadata = {}) {
  const lines = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean) : [];
  const samples = lines.flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
  const services = {};
  const errors = [];
  const gateways = {};
  const postgres = [];
  const redis = [];
  for (const sample of samples) {
    errors.push(...(sample.errors || []));
    for (const record of sample.dockerStats || []) {
      const service = serviceName(record);
      (services[service] ||= { cpuPercent: [], memoryMiB: [] }).cpuPercent.push(parseCpu(record.CPUPerc || record.cpu_percent));
      services[service].memoryMiB.push(parseMemoryMiB(record.MemUsage || record.mem_usage));
    }
    for (const [service, metrics] of Object.entries(sample.gateways || {})) (gateways[service] ||= []).push(metrics);
    if (sample.postgres) postgres.push(sample.postgres);
    if (sample.redis) redis.push(sample.redis);
  }
  const resources = Object.fromEntries(
    Object.entries(services).map(([service, values]) => [
      service,
      { cpuPercent: stats(values.cpuPercent, "%"), memoryMiB: stats(values.memoryMiB, "MiB") },
    ])
  );
  const summary = {
    schemaVersion: 1,
    ...metadata,
    sampleCount: samples.length,
    errorCount: errors.length,
    resources,
    gatewayMetricSamples: Object.fromEntries(
      Object.entries(gateways).map(([service, values]) => [
        service,
        { sampleCount: values.length, first: values[0] || null, last: values.at(-1) || null },
      ])
    ),
    postgres: { sampleCount: postgres.length, first: postgres[0] || null, last: postgres.at(-1) || null },
    redis: { sampleCount: redis.length, first: redis[0] || null, last: redis.at(-1) || null },
    limitations: [
      "CPU and memory are Docker point-in-time samples on the local host, summarized only for observed containers; they are not sustained capacity limits or cloud-service utilization.",
      "PostgreSQL pg_stat_database and Redis INFO values are cumulative/point-in-time counters. Rates require comparing first and last samples and are not inferred here.",
      "Gateway /metrics captures selected counters and gauges only; histograms are not aggregated and no request-level trace latency is derived.",
      "A run with zero samples, missing services, or collection errors is incomplete evidence. This artifact does not prove uptime, cost, failover behavior, or production SLOs.",
    ],
  };
  if (file.endsWith("resource-samples.jsonl")) {
    const target = path.join(path.dirname(file), "resource-summary.json");
    fs.writeFileSync(target, JSON.stringify(summary, null, 2) + "\n");
  } else {
    fs.writeFileSync(file, JSON.stringify(summary, null, 2) + "\n");
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
