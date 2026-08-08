#!/usr/bin/env bash
set -euo pipefail

# Runs a small authenticated Yjs workload while stopping exactly one named
# service. This is deliberately local/Compose-only and bounded. It emits
# client observations plus a Postgres reconstruction; it does not claim that a
# readiness recovery alone proves zero loss.
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/../.." && pwd)"
cd "$repo_root"

scenario="${1:-}"
if [[ ! "$scenario" =~ ^(gateway-a|redis|postgres|worker)$ ]]; then
  echo "usage: $0 <gateway-a|redis|postgres|worker> [run-id]" >&2
  exit 64
fi

project="${CHAOS_PROJECT:-collab-benchmark}"
environment_file="${CHAOS_ENV_FILE:-.env.benchmark}"
http_port="${BENCHMARK_HTTP_PORT:-8080}"
run_id="${2:-${CHAOS_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)-persistent-${scenario}}}"
output_dir="$repo_root/artifacts/chaos/$run_id"
mkdir -p "$output_dir"
rm -f "$output_dir/workload-ready.json" "$output_dir/workload.json" "$output_dir/db-ops.tsv" "$output_dir/summary.json" \
  "$output_dir/job-accounting-before-restart.json" "$output_dir/job-accounting-after-restart.json"

if [[ ! -f "$environment_file" ]]; then
  echo "missing $environment_file" >&2
  exit 64
fi

compose=(docker compose --project-name "$project" --env-file "$environment_file" -f docker-compose.yml -f docker-compose.benchmark.yml)
tsx_bin="${COLLAB_TSX_BIN:-$repo_root/packages/server/node_modules/.bin/tsx}"
if [[ ! -x "$tsx_bin" ]]; then
  echo "missing executable tsx at $tsx_bin; install workspace dependencies first" >&2
  exit 64
fi
db_user="${POSTGRES_USER:-$(sed -n 's/^POSTGRES_USER=//p' "$environment_file" | head -1)}"
db_name="${POSTGRES_DB:-$(sed -n 's/^POSTGRES_DB=//p' "$environment_file" | head -1)}"
db_user="${db_user:-collab}"
db_name="${db_name:-collab}"
if ! "${compose[@]}" ps --status running --services | grep -qx 'lb'; then
  echo "benchmark project '$project' is not running; start with BENCHMARK_HTTP_PORT=$http_port scripts/benchmark/up.sh 25" >&2
  exit 64
fi

now_ms() { node -e 'process.stdout.write(String(Date.now()))'; }
record_event() {
  local event="$1" service="$2" detail="${3:-}"
  printf '{"atMs":%s,"event":%s,"service":%s,"detail":%s}\n' \
    "$(now_ms)" "$(node -p 'JSON.stringify(process.argv[1])' "$event")" \
    "$(node -p 'JSON.stringify(process.argv[1])' "$service")" \
    "$(node -p 'JSON.stringify(process.argv[1])' "$detail")" >> "$output_dir/timeline.ndjson"
}

: > "$output_dir/timeline.ndjson"
record_event "baseline" "$scenario"
"${compose[@]}" stats --no-stream --format json > "$output_dir/baseline-docker-stats.json"

workload_pid=""
cleanup() {
  if [[ -n "$workload_pid" ]] && kill -0 "$workload_pid" 2>/dev/null; then
    kill "$workload_pid" 2>/dev/null || true
    wait "$workload_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT

CHAOS_RUN_ID="$run_id" \
CHAOS_SCENARIO="$scenario" \
CHAOS_HTTP_URL="${CHAOS_HTTP_URL:-http://localhost:$http_port}" \
CHAOS_WS_URL="${CHAOS_WS_URL:-ws://localhost:$http_port}" \
CHAOS_ORIGIN="${CHAOS_ORIGIN:-http://localhost:$http_port}" \
CHAOS_OUTPUT="$output_dir/workload.json" \
CHAOS_READY_FILE="$output_dir/workload-ready.json" \
CHAOS_CLIENTS="${CHAOS_CLIENTS:-8}" \
CHAOS_OPERATIONS_PER_CLIENT="${CHAOS_OPERATIONS_PER_CLIENT:-4}" \
CHAOS_OPERATION_INTERVAL_MS="${CHAOS_OPERATION_INTERVAL_MS:-250}" \
CHAOS_SETTLE_MS="${CHAOS_SETTLE_MS:-2000}" \
CHAOS_PROPAGATION_TIMEOUT_MS="${CHAOS_PROPAGATION_TIMEOUT_MS:-20000}" \
CHAOS_PRE_MUTATION_PAUSE_MS="${CHAOS_PRE_MUTATION_PAUSE_MS:-$([[ "$scenario" == "worker" ]] && echo 5000 || echo 0)}" \
"$tsx_bin" packages/server/benchmark/persistent-chaos.ts > "$output_dir/workload.stdout.log" 2> "$output_dir/workload.stderr.log" &
workload_pid=$!

ready_deadline=$(( $(now_ms) + ${CHAOS_READY_TIMEOUT_SECONDS:-45} * 1000 ))
while [[ ! -f "$output_dir/workload-ready.json" && "$(now_ms)" -lt "$ready_deadline" ]]; do sleep 0.25; done
if [[ ! -f "$output_dir/workload-ready.json" ]]; then
  echo "workload did not become ready; see $output_dir/workload.stderr.log" >&2
  wait "$workload_pid" || true
  exit 2
fi
page_id="$(node -e 'const x=require(process.argv[1]); process.stdout.write(x.pageId)' "$output_dir/workload-ready.json")"
record_event "workload_ready" "$scenario" "page=$page_id"

fault_seconds="${CHAOS_FAULT_DURATION_SECONDS:-5}"
if ! [[ "$fault_seconds" =~ ^[1-9][0-9]*$ ]]; then echo "CHAOS_FAULT_DURATION_SECONDS must be a positive integer" >&2; exit 64; fi
fault_started_ms="$(now_ms)"
record_event "fault_stop_start" "$scenario"
target_service="server-a"
[[ "$scenario" == "redis" ]] && target_service="redis"
[[ "$scenario" == "postgres" ]] && target_service="postgres"
[[ "$scenario" == "worker" ]] && target_service="worker"
accounting_service="server-a"
[[ "$target_service" == "server-a" ]] && accounting_service="server-b"
"${compose[@]}" stop "$target_service" > "$output_dir/fault-stop.log" 2>&1
record_event "fault_stopped" "$target_service"
sleep "$fault_seconds"
# Search/preview jobs are enqueued after each durable mutation. During the
# worker fault they should remain in BullMQ; capture that state before restart
# so the report proves queueing, not merely that an output row exists later.
job_accounting_status=0
set +e
"${compose[@]}" exec -T "$accounting_service" /app/packages/server/node_modules/.bin/tsx /app/packages/server/benchmark/account-jobs.ts "$page_id" before-restart 0 \
  > "$output_dir/job-accounting-before-restart.json" 2> "$output_dir/job-accounting-before-restart.error"
before_job_accounting_status=$?
set -e
if [[ "$before_job_accounting_status" != "0" ]]; then
  record_event "job_accounting_before_restart_nonterminal" "$target_service" "exit=$before_job_accounting_status"
fi
record_event "fault_restart_start" "$target_service"
"${compose[@]}" start "$target_service" > "$output_dir/fault-start.log" 2>&1
record_event "fault_restart_requested" "$target_service"

recovery_started_ms="$(now_ms)"
recovery_timeout="${CHAOS_RECOVERY_TIMEOUT_SECONDS:-60}"
recovery_deadline=$((recovery_started_ms + recovery_timeout * 1000))
recovered=0
attempt=0
while [[ "$(now_ms)" -lt "$recovery_deadline" ]]; do
  attempt=$((attempt + 1))
  status_code="$(curl --connect-timeout 0.5 --max-time 1 -sS -o "$output_dir/ready-response-$attempt.json" -w '%{http_code}' "${CHAOS_HTTP_URL:-http://localhost:$http_port}/ready" || true)"
  printf '{"atMs":%s,"attempt":%s,"httpStatus":"%s"}\n' "$(now_ms)" "$attempt" "$status_code" >> "$output_dir/recovery-polls.ndjson"
  if [[ "$status_code" == "200" ]]; then recovered=1; break; fi
  sleep 0.25
done
recovery_finished_ms="$(now_ms)"
record_event "recovery_observed" "$target_service" "http_status_200=$recovered"

# Allow the workload's post-reconnect convergence window to finish. The
# workload itself is bounded by its finite operation set and timeout.
workload_status=0
wait "$workload_pid" || workload_status=$?
workload_pid=""

# Capture the append-only durable log while Postgres is healthy again. The
# page id is generated by this script's workload and restricted to safe chars.
if [[ "$page_id" =~ ^[A-Za-z0-9_-]+$ ]]; then
  "${compose[@]}" exec -T postgres psql -U "$db_user" -d "$db_name" -At -F $'\t' \
    -c "SELECT seq, COALESCE(update_fingerprint,''), update FROM ops_log WHERE page_id = '$page_id' ORDER BY seq" \
    > "$output_dir/db-ops.tsv" 2> "$output_dir/db-ops.error" || true
fi

summary_status=0
CHAOS_RUN_ID="$run_id" CHAOS_SCENARIO="$scenario" \
CHAOS_WORKLOAD_OUTPUT="$output_dir/workload.json" \
CHAOS_DB_DUMP="$output_dir/db-ops.tsv" \
CHAOS_SUMMARY_OUTPUT="$output_dir/summary.json" \
"$tsx_bin" packages/server/benchmark/summarize-chaos.ts || summary_status=$?

# Completed search/preview jobs remove themselves from Redis, so the helper
# also checks their Postgres materializations. It polls after restart until all
# expected jobs are terminal or the bounded timeout expires.
set +e
"${compose[@]}" exec -T "$accounting_service" /app/packages/server/node_modules/.bin/tsx /app/packages/server/benchmark/account-jobs.ts "$page_id" after-restart "${CHAOS_JOB_RECOVERY_TIMEOUT_MS:-30000}" \
  > "$output_dir/job-accounting-after-restart.json" 2> "$output_dir/job-accounting-after-restart.error"
after_job_accounting_status=$?
set -e
if [[ "$after_job_accounting_status" != "0" ]]; then
  job_accounting_status=$after_job_accounting_status
fi

"${compose[@]}" stats --no-stream --format json > "$output_dir/final-docker-stats.json"
"${compose[@]}" logs --no-color --timestamps server-a server-b worker redis postgres > "$output_dir/services.log" 2>&1 || true

node -e '
const fs=require("node:fs"); const file=process.argv[1]; const x=JSON.parse(fs.readFileSync(file,"utf8"));
function readJson(path) { try { return JSON.parse(fs.readFileSync(path,"utf8")); } catch (error) { return { status:"unavailable", error:String(error) }; } }
x.jobs={beforeRestart:readJson(process.argv[8]),afterRestart:readJson(process.argv[9]),claimBoundary:"Expected is one coalesced search-index and one preview job for this page. Completed requires the processor output row; failed requires BullMQ failed state; remaining is a live waiting/active/delayed/paused job. Missing job and output is unaccounted."};
x.schemaVersion=2; x.faultStartedAt=new Date(Number(process.argv[2])).toISOString(); x.recoveryObservedAt=new Date(Number(process.argv[3])).toISOString();
x.injectedFaultDurationMs=Number(process.argv[3])-Number(process.argv[2]); x.recoveryProbeElapsedMs=Number(process.argv[3])-Number(process.argv[4]);
x.recoveredReadyEndpoint=process.argv[5]==="1"; x.workloadExitCode=Number(process.argv[6]); x.summaryExitCode=Number(process.argv[7]);
x.limitations=["Readiness recovery is measured through the load balancer.","acceptedByHarness is a generated authenticated workload intent, not a server-side acknowledgement counter.","durable/lost are reconstructed from Postgres ops_log; semantic business duplicate edits are outside this report."];
fs.writeFileSync(file,JSON.stringify(x,null,2)+"\n");
' "$output_dir/summary.json" "$fault_started_ms" "$recovery_finished_ms" "$recovery_started_ms" "$recovered" "$workload_status" "$summary_status" "$output_dir/job-accounting-before-restart.json" "$output_dir/job-accounting-after-restart.json"

echo "$output_dir/summary.json"
if [[ "$recovered" != "1" || "$workload_status" != "0" || "$summary_status" != "0" || "$job_accounting_status" != "0" ]]; then exit 2; fi
