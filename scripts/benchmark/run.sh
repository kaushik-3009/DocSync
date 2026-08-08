#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/../.." && pwd)"
cd "$repo_root"

stage="${1:-}"
if [[ ! "$stage" =~ ^(25|50|100)$ ]]; then
  echo "usage: $0 <25|50|100>" >&2
  exit 64
fi

run_id="${BENCHMARK_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)-${stage}c}"
output_dir="$repo_root/artifacts/benchmarks/${run_id}"
mkdir -p "$output_dir"
benchmark_port="${BENCHMARK_HTTP_PORT:-8080}"
tsx_bin="${COLLAB_TSX_BIN:-$repo_root/packages/server/node_modules/.bin/tsx}"
if [[ ! -x "$tsx_bin" ]]; then
  echo "missing executable tsx at $tsx_bin; install workspace dependencies first" >&2
  exit 64
fi

BENCHMARK_RUN_ID="$run_id" \
BENCHMARK_CLIENTS="$stage" \
BENCHMARK_OPERATIONS_PER_CLIENT="${BENCHMARK_OPERATIONS_PER_CLIENT:-3}" \
BENCHMARK_HTTP_BASE_URL="${BENCHMARK_HTTP_BASE_URL:-http://localhost:${benchmark_port}}" \
BENCHMARK_WS_BASE_URL="${BENCHMARK_WS_BASE_URL:-ws://localhost:${benchmark_port}}" \
BENCHMARK_ORIGIN="${BENCHMARK_ORIGIN:-http://localhost:${benchmark_port}}" \
BENCHMARK_OUTPUT="$output_dir/client-results.json" \
"$tsx_bin" packages/server/benchmark/collaboration.ts

echo "$run_id"
