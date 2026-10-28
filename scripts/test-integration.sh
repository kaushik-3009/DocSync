#!/usr/bin/env bash
set -euo pipefail

# Real-service integration gate. This deliberately reuses the same isolated
# benchmark topology and Yjs wire client used for performance evidence, then
# emits one manifest tying the three stages to the exact commands and artifacts.
# It never substitutes the fast pg-mem/ioredis-mock unit suite.
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"
cd "$repo_root"

if [[ ! -f "${BENCHMARK_ENV_FILE:-.env.benchmark}" ]]; then
  echo "missing ${BENCHMARK_ENV_FILE:-.env.benchmark}; copy .env.benchmark.example first" >&2
  exit 64
fi

run_id="${INTEGRATION_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)-real-services}"
output_dir="artifacts/integration/$run_id"
mkdir -p "$output_dir"
started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
stages=()
cleanup() {
  if [[ "${KEEP_INTEGRATION_STACK:-0}" != "1" ]]; then
    scripts/benchmark/down.sh >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

scripts/benchmark/up.sh 25 >/dev/null
for stage in 25 50 100; do
  stage_run="${run_id}-${stage}c"
  BENCHMARK_RUN_ID="$stage_run" scripts/benchmark/run.sh "$stage"
  BENCHMARK_RUN_ID="$stage_run" scripts/benchmark/collect.sh "$stage_run"
  stages+=("$stage_run")
done

node -e '
const fs=require("node:fs");
const [file,runId,started,stages]=process.argv.slice(1);
const reports=JSON.parse(stages).map((id)=>({runId:id,clientResults:`artifacts/benchmarks/${id}/client-results.json`,collection:`artifacts/benchmarks/${id}/collection-summary.json`}));
const result={schemaVersion:1,runId,startedAt:started,finishedAt:new Date().toISOString(),topology:"nginx + two gateways + Postgres + Redis + dedicated BullMQ worker",stages:reports,claims:["real authenticated Yjs wire protocol exercised through nginx","both gateway participation required for a passing stage","durable/recovery claims require the separate chaos and backup gates"],unitSuite:"pnpm --filter @docsync/server test"};
fs.writeFileSync(file,JSON.stringify(result,null,2)+"\n");
' "$output_dir/manifest.json" "$run_id" "$started_at" "$(printf '%s\n' "${stages[@]}" | node -e 'const fs=require("node:fs"); process.stdout.write(JSON.stringify(fs.readFileSync(0,"utf8").trim().split(/\n+/).filter(Boolean)))')"

echo "$output_dir/manifest.json"
