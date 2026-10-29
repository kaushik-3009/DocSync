#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
infra_dir="$repo_root/infra/aws"

if [[ "${ALLOW_AWS_DESTROY:-}" != "I_UNDERSTAND" ]]; then
  echo "Refusing destroy. Set ALLOW_AWS_DESTROY=I_UNDERSTAND after recording artifacts." >&2
  exit 2
fi
if [[ ! -f "$infra_dir/terraform.tfvars" ]]; then
  echo "Missing $infra_dir/terraform.tfvars; destroy must target the reviewed state." >&2
  exit 1
fi

cd "$infra_dir"
terraform init -input=false -backend-config=backend.hcl
terraform destroy -input=false -var-file=terraform.tfvars
echo "Destroy completed. Confirm nothing tagged Project=docsync remains:"
echo "  aws resourcegroupstaggingapi get-resources --tag-filters Key=Project,Values=docsync"
