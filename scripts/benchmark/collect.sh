#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/../.." && pwd)"
cd "$repo_root"

run_id="${1:-}"
if [[ -z "$run_id" ]]; then
  echo "usage: $0 <run-id>" >&2
  exit 64
fi

benchmark_project="${BENCHMARK_PROJECT:-collab-benchmark}"
environment_file="${BENCHMARK_ENV_FILE:-.env.benchmark}"
output_dir="artifacts/benchmarks/${run_id}"
mkdir -p "$output_dir"

compose=(docker compose --project-name "$benchmark_project" --env-file "$environment_file" -f docker-compose.yml -f docker-compose.benchmark.yml)

capture_ready() {
  local service="$1"
  local output_file="$2"
  # Preserve HTTP status with the body; a 503 body alone is too easy to
  # mistake for a healthy readiness snapshot during a fault run.
  set +e
  "${compose[@]}" exec -T "$service" node -e '
    fetch("http://127.0.0.1:1234/ready")
      .then(async (response) => {
        const text = await response.text();
        let body;
        try { body = JSON.parse(text); } catch { body = { raw: text }; }
        process.stdout.write(JSON.stringify({ httpStatus: response.status, body }) + "\n");
        process.exit(response.ok ? 0 : 2);
      })
      .catch((error) => {
        process.stdout.write(JSON.stringify({ httpStatus: null, error: String(error) }) + "\n");
        process.exit(3);
      });
  ' > "$output_file"
  local status=$?
  set -e
  return "$status"
}

ready_a_status=0
ready_b_status=0
capture_ready server-a "$output_dir/server-a-ready.json" || ready_a_status=$?
capture_ready server-b "$output_dir/server-b-ready.json" || ready_b_status=$?
"${compose[@]}" exec -T server-a node -e 'fetch("http://127.0.0.1:1234/metrics").then(r => r.text()).then(console.log)' > "$output_dir/server-a.prom"
"${compose[@]}" exec -T server-b node -e 'fetch("http://127.0.0.1:1234/metrics").then(r => r.text()).then(console.log)' > "$output_dir/server-b.prom"
"${compose[@]}" stats --no-stream --format json > "$output_dir/docker-stats.json"
"${compose[@]}" logs --no-color --timestamps server-a server-b > "$output_dir/gateway.log"

node -e '
const fs = require("node:fs");
const [dir, runId, readyAStatus, readyBStatus] = process.argv.slice(1);
function counter(file, metric) {
  const content = fs.readFileSync(`${dir}/${file}`, "utf8");
  const match = content.match(new RegExp(`^${metric} (\\d+(?:\\.\\d+)?)$`, "m"));
  return match ? Number(match[1]) : 0;
}
function readiness(file) {
  try {
    const value = JSON.parse(fs.readFileSync(`${dir}/${file}`, "utf8"));
    return { httpStatus: value.httpStatus ?? null, healthy: value.httpStatus === 200, body: value.body ?? null, error: value.error ?? null };
  } catch (error) {
    return { httpStatus: null, healthy: false, body: null, error: String(error) };
  }
}
const summary = {
  schemaVersion: 1,
  runId,
  collectedAt: new Date().toISOString(),
  readiness: {
    serverA: readiness("server-a-ready.json"),
    serverB: readiness("server-b-ready.json"),
  },
  gateways: {
    serverA: { wsConnections: counter("server-a.prom", "ws_connections_total"), durableUpdates: counter("server-a.prom", "collab_updates_total\\{outcome=\\\"durable\\\"\\}") },
    serverB: { wsConnections: counter("server-b.prom", "ws_connections_total"), durableUpdates: counter("server-b.prom", "collab_updates_total\\{outcome=\\\"durable\\\"\\}") }
  }
};
summary.twoReplicaParticipation = summary.gateways.serverA.wsConnections > 0 && summary.gateways.serverB.wsConnections > 0;
summary.limitations = ["This is a raw collection manifest. Resource and Prometheus time-series summarization is not implemented yet."];
summary.collectionCommandStatus = { serverAReady: Number(readyAStatus), serverBReady: Number(readyBStatus) };
fs.writeFileSync(`${dir}/collection-summary.json`, JSON.stringify(summary, null, 2) + "\n");
if (!summary.twoReplicaParticipation || !summary.readiness.serverA.healthy || !summary.readiness.serverB.healthy) process.exitCode = 2;
' "$output_dir" "$run_id" "$ready_a_status" "$ready_b_status"
