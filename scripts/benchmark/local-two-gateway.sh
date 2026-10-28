#!/usr/bin/env bash
# Runs two gateways against native Postgres/Redis (optionally behind the
# latency proxy) and drives the collaboration benchmark across both. Useful
# where Docker is unavailable; the compose topology remains the reference.
#
# env: DATABASE_URL (admin URL of an empty database), REDIS_URL,
#      DB_RTT_MS (default 2), CLIENTS (default 100), OPS (default 3),
#      SHARDS (harness processes, default 4),
#      GATEWAY_ROOT (checkout whose gateway code to run; default this repo —
#      point it at a worktree of another commit for before/after runs)
set -euo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/../.." && pwd)"
cd "$repo_root"

db_url="${DATABASE_URL:?set DATABASE_URL}"
redis_url="${REDIS_URL:-redis://localhost:6379}"
rtt="${DB_RTT_MS:-2}"
clients="${CLIENTS:-100}"
ops="${OPS:-3}"
shards="${SHARDS:-4}"
run_id="${BENCHMARK_RUN_ID:-local-$(date -u +%Y%m%dT%H%M%SZ)-${clients}c}"
tsx_bin="$repo_root/packages/server/node_modules/.bin/tsx"
gateway_root="${GATEWAY_ROOT:-$repo_root}"

db_host_port="$(node -e 'const u=new URL(process.argv[1]);console.log(`${u.hostname}:${u.port||5432}`)' "$db_url")"
proxied_db_url="$(node -e 'const u=new URL(process.argv[1]);u.hostname="127.0.0.1";u.port="15432";console.log(u.toString())' "$db_url")"

pids=()
cleanup() { for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done; }
trap cleanup EXIT

node "$script_dir/latency-proxy.mjs" 15432 "$db_host_port" "$rtt" >/dev/null &
pids+=($!)
sleep 0.5

for port in 1234 1235; do
  NODE_OPTIONS="${GATEWAY_NODE_OPTIONS:-}" PORT=$port GATEWAY_ID="bench-$port" DATABASE_URL="$proxied_db_url" REDIS_URL="$redis_url" \
    JWT_SECRET="local-benchmark-secret-$(whoami)-0123456789" ALLOWED_ORIGINS="http://localhost:1234" \
    WS_CONNECT_RATE_LIMIT_POINTS=5000 HTTP_RATE_LIMIT_POINTS=5000 LOG_LEVEL=warn RUN_WORKERS=false "$gateway_root/packages/server/node_modules/.bin/tsx" "$gateway_root/packages/server/src/index.ts" >"/tmp/docsync-gw-$port.log" 2>&1 &
  pids+=($!)
done
for port in 1234 1235; do
  for _ in $(seq 1 100); do curl -fsS "http://localhost:$port/ready" >/dev/null 2>&1 && break; sleep 0.2; done
done

out_dir="artifacts/benchmarks/$run_id"
mkdir -p "$out_dir"
common_env=(
  BENCHMARK_RUN_ID="$run_id" BENCHMARK_CLIENTS="$clients" BENCHMARK_OPERATIONS_PER_CLIENT="$ops"
  BENCHMARK_HTTP_BASE_URL="http://localhost:1234" BENCHMARK_ORIGIN="http://localhost:1234"
  BENCHMARK_WS_BASE_URLS="ws://localhost:1234,ws://localhost:1235"
)
setup="$(env "${common_env[@]}" BENCHMARK_SETUP_ONLY=true "$tsx_bin" packages/server/benchmark/collaboration.ts)"
token="$(node -e 'console.log(JSON.parse(process.argv[1]).token)' "$setup")"
page_id="$(node -e 'console.log(JSON.parse(process.argv[1]).pageId)' "$setup")"

# Shards connect first, then all start editing at the same instant.
start_at=$(( $(date +%s%3N) + 5000 ))
shard_pids=()
shard_files=()
for shard in $(seq 0 $((shards - 1))); do
  file="$out_dir/shard-$shard.json"
  shard_files+=("$file")
  env "${common_env[@]}" BENCHMARK_TOKEN="$token" BENCHMARK_PAGE_ID="$page_id" \
    BENCHMARK_SHARD_INDEX="$shard" BENCHMARK_SHARD_COUNT="$shards" BENCHMARK_START_AT_MS="$start_at" \
    BENCHMARK_OUTPUT="$file" "$tsx_bin" packages/server/benchmark/collaboration.ts >/dev/null &
  shard_pids+=($!)
done
status=0
for pid in "${shard_pids[@]}"; do wait "$pid" || status=1; done
node "$script_dir/merge-shards.mjs" "$out_dir/client-results.json" "${shard_files[@]}" || status=1
exit $status
