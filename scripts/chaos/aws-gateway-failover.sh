#!/usr/bin/env bash
set -euo pipefail

# Bounded AWS smoke exercise. It stops one gateway task while the authenticated
# Yjs workload is live, waits for ECS to replace it, and preserves client
# reconnect/convergence evidence. Durable loss/duplication remains measured by
# the local Postgres-backed chaos runner because this short-lived AWS profile
# does not expose the private RDS network to the operator host.
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/../.." && pwd)"
cd "$repo_root"

region="${AWS_REGION:-us-east-2}"
cluster="${AWS_ECS_CLUSTER:-docsync-staging}"
service="${AWS_ECS_GATEWAY_SERVICE:-docsync-staging-gateway}"
http_url="${CHAOS_HTTP_URL:-http://docsync-staging-alb-1021561397.us-east-2.elb.amazonaws.com}"
ws_url="${CHAOS_WS_URL:-${http_url/http/ws}}"
origin="${CHAOS_ORIGIN:-http://localhost:5173}"
run_id="${CHAOS_RUN_ID:-aws-gateway-failover-$(date -u +%Y%m%dT%H%M%SZ)}"
output_dir="$repo_root/artifacts/chaos/$run_id"
tsx_bin="${COLLAB_TSX_BIN:-$repo_root/packages/server/node_modules/.bin/tsx}"

command -v aws >/dev/null || { echo "aws CLI is required" >&2; exit 64; }
command -v curl >/dev/null || { echo "curl is required" >&2; exit 64; }
[[ -x "$tsx_bin" ]] || { echo "missing executable tsx at $tsx_bin" >&2; exit 64; }
mkdir -p "$output_dir"

now_ms() { node -e 'process.stdout.write(String(Date.now()))'; }
record_event() {
  local event="$1" detail="${2:-}"
  printf '{"atMs":%s,"event":%s,"detail":%s}\n' \
    "$(now_ms)" "$(node -p 'JSON.stringify(process.argv[1])' "$event")" \
    "$(node -p 'JSON.stringify(process.argv[1])' "$detail")" >> "$output_dir/timeline.ndjson"
}

: > "$output_dir/timeline.ndjson"
record_event "baseline" "cluster=$cluster service=$service"
aws ecs describe-services --cluster "$cluster" --services "$service" --region "$region" \
  --output json > "$output_dir/ecs-before.json"

workload_pid=""
cleanup() {
  if [[ -n "$workload_pid" ]] && kill -0 "$workload_pid" 2>/dev/null; then
    kill "$workload_pid" 2>/dev/null || true
    wait "$workload_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT

CHAOS_RUN_ID="$run_id" \
CHAOS_HTTP_URL="$http_url" \
CHAOS_WS_URL="$ws_url" \
CHAOS_ORIGIN="$origin" \
CHAOS_OUTPUT="$output_dir/workload.json" \
CHAOS_READY_FILE="$output_dir/workload-ready.json" \
CHAOS_CLIENTS="${CHAOS_CLIENTS:-8}" \
CHAOS_OPERATIONS_PER_CLIENT="${CHAOS_OPERATIONS_PER_CLIENT:-4}" \
CHAOS_OPERATION_INTERVAL_MS="${CHAOS_OPERATION_INTERVAL_MS:-250}" \
CHAOS_SETTLE_MS="${CHAOS_SETTLE_MS:-2000}" \
CHAOS_PROPAGATION_TIMEOUT_MS="${CHAOS_PROPAGATION_TIMEOUT_MS:-30000}" \
CHAOS_PRE_MUTATION_PAUSE_MS="${CHAOS_PRE_MUTATION_PAUSE_MS:-5000}" \
  "$tsx_bin" packages/server/benchmark/persistent-chaos.ts \
  > "$output_dir/workload.stdout.log" 2> "$output_dir/workload.stderr.log" &
workload_pid=$!

ready_deadline=$(( $(now_ms) + ${CHAOS_READY_TIMEOUT_SECONDS:-60} * 1000 ))
while [[ ! -f "$output_dir/workload-ready.json" && "$(now_ms)" -lt "$ready_deadline" ]]; do sleep 0.25; done
if [[ ! -f "$output_dir/workload-ready.json" ]]; then
  echo "workload did not become ready; see $output_dir/workload.stderr.log" >&2
  exit 2
fi
page_id="$(node -e 'const x=require(process.argv[1]); process.stdout.write(x.pageId)' "$output_dir/workload-ready.json")"
record_event "workload_ready" "page=$page_id"

task_arn="$(aws ecs list-tasks --cluster "$cluster" --service-name "$service" --desired-status RUNNING --region "$region" --query 'taskArns[0]' --output text)"
if [[ -z "$task_arn" || "$task_arn" == "None" ]]; then
  echo "no running gateway task available for fault injection" >&2
  exit 2
fi
task_id="${task_arn##*/}"
fault_started_ms="$(now_ms)"
record_event "fault_stop_start" "task=$task_id"
aws ecs stop-task --cluster "$cluster" --task "$task_id" --reason "bounded AWS gateway failover evidence" --region "$region" \
  --output json > "$output_dir/stop-task.json"
record_event "fault_stop_requested" "task=$task_id"

recovery_timeout="${CHAOS_RECOVERY_TIMEOUT_SECONDS:-180}"
recovery_deadline=$(( $(now_ms) + recovery_timeout * 1000 ))
recovered=0
replacement_observed=0
while [[ "$(now_ms)" -lt "$recovery_deadline" ]]; do
  at_ms="$(now_ms)"
  status_code="$(curl --connect-timeout 0.5 --max-time 2 -sS -o "$output_dir/ready-response.json" -w '%{http_code}' "$http_url/ready" || true)"
  service_state="$(aws ecs describe-services --cluster "$cluster" --services "$service" --region "$region" --query 'services[0].[runningCount,pendingCount]' --output text 2>/dev/null || true)"
  running_ids="$(aws ecs list-tasks --cluster "$cluster" --service-name "$service" --desired-status RUNNING --region "$region" --query 'taskArns[]' --output text 2>/dev/null | tr '\t' '\n' | sed 's#.*/##')"
  printf '{"atMs":%s,"httpStatus":"%s","service":"%s"}\n' "$at_ms" "$status_code" "$service_state" >> "$output_dir/recovery-polls.ndjson"
  [[ "$status_code" == "200" ]] && recovered=1
  running_count="$(awk '{print $1}' <<< "$service_state")"
  replacement_count="$(printf '%s\n' "$running_ids" | grep -v -x "$task_id" | grep -v '^$' | grep -v '^None$' | wc -l | tr -d ' ')"
  if [[ "$running_count" == "2" && "$replacement_count" -ge 2 ]]; then
    replacement_observed=1
  fi
  if [[ "$recovered" == "1" && "$replacement_observed" == "1" ]]; then break; fi
  sleep 2
done
recovery_finished_ms="$(now_ms)"
record_event "recovery_observed" "ready=$recovered replacement=$replacement_observed"

workload_status=0
wait "$workload_pid" || workload_status=$?
workload_pid=""
aws ecs describe-services --cluster "$cluster" --services "$service" --region "$region" \
  --output json > "$output_dir/ecs-after.json"
aws ecs describe-tasks --cluster "$cluster" --tasks "$task_id" --region "$region" \
  --output json > "$output_dir/stopped-task.json" || true

node - "$output_dir" "$run_id" "$fault_started_ms" "$recovery_finished_ms" "$recovered" "$replacement_observed" "$workload_status" <<'NODE'
const fs = require("node:fs");
const path = process.argv[2];
const runId = process.argv[3];
const faultStartedMs = Number(process.argv[4]);
const recoveryFinishedMs = Number(process.argv[5]);
const readyRecovered = process.argv[6] === "1";
const replacementObserved = process.argv[7] === "1";
const workloadExitCode = Number(process.argv[8]);
const workload = JSON.parse(fs.readFileSync(`${path}/workload.json`, "utf8"));
const clients = workload.clients ?? [];
const hashes = new Set(clients.map((client) => client.mapHash));
const reconnects = clients.reduce((sum, client) => sum + client.reconnects, 0);
const socketErrors = clients.reduce((sum, client) => sum + client.socketErrors, 0);
const duplicateWireFrames = clients.reduce((sum, client) => sum + client.duplicateWireFrames, 0);
const summary = {
  schemaVersion: 1,
  runId,
  fault: { type: "ecs-gateway-task-stop", faultStartedAt: new Date(faultStartedMs).toISOString(), taskStopTarget: JSON.parse(fs.readFileSync(`${path}/stop-task.json`, "utf8")).task?.taskArn ?? null },
  recovery: {
    readyEndpointRecovered: readyRecovered,
    replacementObserved,
    recoveryObservedAt: new Date(recoveryFinishedMs).toISOString(),
    elapsedFromFaultRequestMs: recoveryFinishedMs - faultStartedMs,
  },
  workload: {
    status: workload.status,
    clients: clients.length,
    mutationCount: workload.mutations?.generated?.length ?? 0,
    converged: hashes.size === 1 && workload.convergence?.converged === true,
    reconnects,
    socketErrors,
    duplicateWireFrames,
    clientExitCode: workloadExitCode,
  },
  claimBoundary: "This AWS smoke measures ALB/ECS replacement, client reconnect, and CRDT state convergence. Durable loss/duplication is not inferred from this private-RDS run; the local Postgres-backed chaos reports are authoritative for those outcomes.",
};
fs.writeFileSync(`${path}/summary.json`, JSON.stringify(summary, null, 2) + "\n");
NODE

echo "$output_dir/summary.json"
if [[ "$recovered" != "1" || "$replacement_observed" != "1" || "$workload_status" != "0" ]]; then exit 2; fi
