#!/usr/bin/env bash
set -euo pipefail

database_url="${DATABASE_URL:-${TARGET_DATABASE_URL:-}}"
psql_command="${PSQL_COMMAND:-psql}"
if [[ -z "$database_url" ]]; then echo "DATABASE_URL or TARGET_DATABASE_URL is required" >&2; exit 64; fi
echo -e "migration_files\t$(find "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../packages/server/src/persistence/migrations" && pwd)" -name '*.sql' | wc -l | tr -d ' ')"
${psql_command} "$database_url" -v ON_ERROR_STOP=1 -At -F $'\t' <<'SQL'
SELECT 'pages', COUNT(*) FROM page_seq;
SELECT 'ops_log', COUNT(*) FROM ops_log;
SELECT 'page_roles', COUNT(*) FROM page_roles;
SQL
