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

benchmark_project="${BENCHMARK_PROJECT:-collab-benchmark}"
environment_file="${BENCHMARK_ENV_FILE:-.env.benchmark}"
if [[ ! -f "$environment_file" ]]; then
  echo "missing $environment_file; copy .env.benchmark.example and replace its placeholders" >&2
  exit 64
fi

mkdir -p "artifacts/benchmarks"
run_id="${BENCHMARK_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)-${stage}c}"
manifest="artifacts/benchmarks/${run_id}/manifest.json"
mkdir -p "$(dirname "$manifest")"

docker compose --project-name "$benchmark_project" --env-file "$environment_file" \
  -f docker-compose.yml -f docker-compose.benchmark.yml up --build --wait

node -e '
const fs = require("node:fs");
const [file, runId, stage, project, envFile] = process.argv.slice(1);
fs.writeFileSync(file, JSON.stringify({
  schemaVersion: 1,
  runId,
  stage: Number(stage),
  project,
  environmentFile: envFile,
  startedAt: new Date().toISOString(),
  command: "scripts/benchmark/up.sh " + stage,
  state: "topology_ready"
}, null, 2) + "\n");
' "$manifest" "$run_id" "$stage" "$benchmark_project" "$environment_file"

echo "$run_id"
