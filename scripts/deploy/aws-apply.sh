#!/usr/bin/env bash
set -euo pipefail

# Deliberately difficult to invoke. The user must approve the saved plan and
# provide a short expiry; this script does not create credentials or secrets.
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
infra_dir="$repo_root/infra/aws"
plan_path="${AWS_PLAN_PATH:-$infra_dir/staging.tfplan}"

if [[ "${ALLOW_AWS_APPLY:-}" != "I_UNDERSTAND" ]]; then
  echo "Refusing apply. Set ALLOW_AWS_APPLY=I_UNDERSTAND after explicit approval." >&2
  exit 2
fi
if [[ -z "${AWS_APPLY_EXPIRY_UTC:-}" ]]; then
  echo "Refusing apply. Set AWS_APPLY_EXPIRY_UTC to the agreed destroy deadline." >&2
  exit 2
fi
if [[ ! -f "$plan_path" ]]; then
  echo "Missing saved plan $plan_path; run aws-plan.sh and review it first." >&2
  exit 1
fi

echo "Applying only the reviewed plan; expiry is ${AWS_APPLY_EXPIRY_UTC} UTC."
cd "$infra_dir"
terraform init -input=false -backend-config=backend.hcl >/dev/null
terraform apply -input=false "$plan_path"
