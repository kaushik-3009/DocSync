#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/../.." && pwd)"
cd "$repo_root"

benchmark_project="${BENCHMARK_PROJECT:-collab-benchmark}"
environment_file="${BENCHMARK_ENV_FILE:-.env.benchmark}"

# This targets only the named benchmark project. It does not remove images or
# any non-benchmark Docker resources. The caller must explicitly invoke it
# after evidence collection.
docker compose --project-name "$benchmark_project" --env-file "$environment_file" \
  -f docker-compose.yml -f docker-compose.benchmark.yml down --volumes --remove-orphans
