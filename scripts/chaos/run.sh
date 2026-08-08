#!/usr/bin/env bash
set -euo pipefail

# Bounded, Compose-level recovery smoke test. This script deliberately targets
# only the uniquely named benchmark project supplied by CHAOS_PROJECT. It does
# not remove volumes, images, networks, or any host process.

scenario="${1:-}"
if [[ ! "$scenario" =~ ^(gateway-a|redis|postgres|worker)$ ]]; then
  echo "usage: $0 <gateway-a|redis|postgres|worker> [run-id]" >&2
  exit 64
fi

benchmark_project="${CHAOS_PROJECT:-collab-benchmark}"
environment_file="${CHAOS_ENV_FILE:-.env.benchmark}"
run_id="${2:-${CHAOS_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)-${scenario}}}"
output_dir="artifacts/chaos/${run_id}"
http_url="${CHAOS_HTTP_URL:-http://localhost:8080}"
mkdir -p "$output_dir"

if [[ ! -f "$environment_file" ]]; then
  echo "missing $environment_file; copy .env.benchmark.example first" >&2
  exit 64
fi

compose=(docker compose --project-name "$benchmark_project" --env-file "$environment_file" -f docker-compose.yml -f docker-compose.benchmark.yml)

now_ms() {
  node -e 'process.stdout.write(String(Date.now()))'
}

record_event() {
  local event="$1"
  local service="$2"
  local detail="${3:-}"
  printf '{"atMs":%s,"event":%s,"service":%s,"detail":%s}\n' \
    "$(now_ms)" \
    "$(node -p 'JSON.stringify(process.argv[1])' "$event")" \
    "$(node -p 'JSON.stringify(process.argv[1])' "$service")" \
    "$(node -p 'JSON.stringify(process.argv[1])' "$detail")" >> "$output_dir/timeline.ndjson"
}

if ! "${compose[@]}" ps --status running --services | grep -qx 'lb'; then
  echo "benchmark project '$benchmark_project' is not running" >&2
  echo "start it first with: scripts/benchmark/up.sh 25" >&2
  exit 64
fi

capture_ready() {
  local label="$1"
  "${compose[@]}" exec -T server-a node -e 'fetch("http://127.0.0.1:1234/ready").then(async r => { process.stdout.write(await r.text()); process.exit(r.ok ? 0 : 1); }).catch(err => { process.stderr.write(String(err)); process.exit(1); })' \
    > "$output_dir/${label}-server-a-ready.json" 2> "$output_dir/${label}-server-a-ready.error" || true
  "${compose[@]}" exec -T server-b node -e 'fetch("http://127.0.0.1:1234/ready").then(async r => { process.stdout.write(await r.text()); process.exit(r.ok ? 0 : 1); }).catch(err => { process.stderr.write(String(err)); process.exit(1); })' \
    > "$output_dir/${label}-server-b-ready.json" 2> "$output_dir/${label}-server-b-ready.error" || true
}

case "$scenario" in
  gateway-a) target_service="server-a" ;;
  redis) target_service="redis" ;;
  postgres) target_service="postgres" ;;
  worker) target_service="worker" ;;
esac

fault_seconds="${CHAOS_FAULT_DURATION_SECONDS:-5}"
if ! [[ "$fault_seconds" =~ ^[1-9][0-9]*$ ]]; then
  echo "CHAOS_FAULT_DURATION_SECONDS must be a positive integer" >&2
  exit 64
fi

: > "$output_dir/timeline.ndjson"
record_event "baseline_start" "$target_service"
capture_ready baseline
"${compose[@]}" stats --no-stream --format json > "$output_dir/baseline-docker-stats.json"

fault_started_ms="$(now_ms)"
record_event "fault_stop_start" "$target_service"
"${compose[@]}" stop "$target_service" > "$output_dir/fault-stop.log" 2>&1
record_event "fault_stopped" "$target_service"
sleep "$fault_seconds"
record_event "fault_restart_start" "$target_service"
"${compose[@]}" start "$target_service" > "$output_dir/fault-start.log" 2>&1
record_event "fault_restart_requested" "$target_service"

recovery_timeout_seconds="${CHAOS_RECOVERY_TIMEOUT_SECONDS:-60}"
recovery_started_ms="$(now_ms)"
recovered=0
recovery_deadline_ms=$((recovery_started_ms + recovery_timeout_seconds * 1000))
attempt=0
while [[ "$(now_ms)" -lt "$recovery_deadline_ms" ]]; do
  attempt=$((attempt + 1))
  poll_at_ms="$(now_ms)"
  status_code="$(curl --connect-timeout 0.5 --max-time 1 -sS -o "$output_dir/ready-response-${attempt}.json" -w '%{http_code}' "$http_url/ready" || true)"
  printf '{"atMs":%s,"attempt":%s,"httpStatus":"%s"}\n' "$poll_at_ms" "$attempt" "$status_code" >> "$output_dir/recovery-polls.ndjson"
  if [[ "$status_code" == "200" ]]; then
    recovered=1
    break
  fi
  sleep 0.25
done

recovery_finished_ms="$(now_ms)"
record_event "recovery_observed" "$target_service" "http_status_200=${recovered}"
capture_ready final
"${compose[@]}" stats --no-stream --format json > "$output_dir/final-docker-stats.json"
"${compose[@]}" logs --no-color --timestamps server-a server-b worker redis postgres > "$output_dir/services.log" 2>&1 || true

node -e '
const fs = require("node:fs");
const [file, runId, scenario, target, httpUrl, faultStartedMs, recoveryStartedMs, recoveryFinishedMs, recovered] = process.argv.slice(1);
const summary = {
  schemaVersion: 1,
  runId,
  scenario,
  targetService: target,
  httpUrl,
  status: recovered === "1" ? "recovered" : "recovery_timeout",
  faultStartedAt: new Date(Number(faultStartedMs)).toISOString(),
  recoveryProbeStartedAt: new Date(Number(recoveryStartedMs)).toISOString(),
  recoveryObservedAt: new Date(Number(recoveryFinishedMs)).toISOString(),
  injectedFaultDurationMs: Number(recoveryStartedMs) - Number(faultStartedMs),
  recoveryProbeElapsedMs: Number(recoveryFinishedMs) - Number(recoveryStartedMs),
  recoveredReadyEndpoint: recovered === "1",
  dataLoss: "not_measured",
  duplicateDelivery: "not_measured",
  convergence: "not_measured",
  limitations: [
    "This runner measures dependency/gateway readiness recovery only.",
    "Run a persistent authenticated Yjs workload concurrently before making data-loss, duplication, or convergence claims.",
    "This smoke runner measures readiness recovery only; use persistent-run.sh for job and document accounting."
  ]
};
fs.writeFileSync(file, JSON.stringify(summary, null, 2) + "\n");
if (!summary.recoveredReadyEndpoint) process.exitCode = 2;
' "$output_dir/summary.json" "$run_id" "$scenario" "$target_service" "$http_url" "$fault_started_ms" "$recovery_started_ms" "$recovery_finished_ms" "$recovered"

echo "$output_dir/summary.json"
