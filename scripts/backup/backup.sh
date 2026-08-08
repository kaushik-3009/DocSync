#!/usr/bin/env bash
set -euo pipefail

# Operator-managed logical backup. The dump is encrypted only when the caller
# supplies BACKUP_ENCRYPTION_COMMAND; plaintext dumps are refused by default.
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
output_dir="${1:-$repo_root/artifacts/backups/$(date -u +%Y%m%dT%H%M%SZ)}"
database_url="${DATABASE_URL:-}"
pg_dump_command="${PG_DUMP_COMMAND:-pg_dump}"
psql_command="${PSQL_COMMAND:-psql}"
if [[ -z "$database_url" ]]; then echo "DATABASE_URL is required" >&2; exit 64; fi
if [[ -z "${BACKUP_ENCRYPTION_COMMAND:-}" ]]; then
  echo "BACKUP_ENCRYPTION_COMMAND is required; provide an operator-managed encryption pipeline" >&2
  exit 64
fi
mkdir -p "$output_dir"
plain="$output_dir/collab.dump"
encrypted="$output_dir/collab.dump.enc"
${pg_dump_command} --format=custom --no-owner "$database_url" > "$plain"
${BACKUP_ENCRYPTION_COMMAND} < "$plain" > "$encrypted"
shasum -a 256 "$encrypted" > "$encrypted.sha256"
rm -f "$plain"
${psql_command} "$database_url" -At -F $'\t' -c "SELECT current_setting('server_version'), (SELECT COUNT(*) FROM page_seq), (SELECT COUNT(*) FROM ops_log), (SELECT COUNT(*) FROM page_roles);" > "$output_dir/database-inventory.tsv"
cat > "$output_dir/manifest.json" <<EOF
{"schemaVersion":1,"createdAt":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","encryptedDump":"$(basename "$encrypted")","checksum":"$(basename "$encrypted.sha256")","migrationSource":"packages/server/src/persistence/migrations","redisRecovery":"Redis/BullMQ are reconstructed from Postgres state; volatile queues are not treated as durable document history."}
EOF
echo "$output_dir/manifest.json"
