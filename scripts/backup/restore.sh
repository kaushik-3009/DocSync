#!/usr/bin/env bash
set -euo pipefail

# Restore only into an explicitly isolated database. Decryption is supplied by
# the operator so secrets and key material never enter the repository.
if [[ "${ALLOW_BACKUP_RESTORE:-}" != "I_UNDERSTAND" ]]; then
  echo "set ALLOW_BACKUP_RESTORE=I_UNDERSTAND before restoring into an isolated database" >&2
  exit 64
fi
dump="${1:-}"
target_database_url="${TARGET_DATABASE_URL:-}"
pg_restore_command="${PG_RESTORE_COMMAND:-pg_restore}"
if [[ -z "$dump" || -z "$target_database_url" || -z "${BACKUP_DECRYPTION_COMMAND:-}" ]]; then
  echo "usage: ALLOW_BACKUP_RESTORE=I_UNDERSTAND TARGET_DATABASE_URL=... BACKUP_DECRYPTION_COMMAND='...' $0 <encrypted-dump>" >&2
  exit 64
fi
tmp="$(mktemp -t collab-restore.XXXXXX.dump)"
trap 'rm -f "$tmp"' EXIT
${BACKUP_DECRYPTION_COMMAND} < "$dump" > "$tmp"
${pg_restore_command} --no-owner --exit-on-error --clean --if-exists --dbname "$target_database_url" "$tmp"
echo "restored into the explicitly supplied isolated target; run scripts/backup/verify.sh next"
