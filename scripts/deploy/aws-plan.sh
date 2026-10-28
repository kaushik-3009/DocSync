#!/usr/bin/env bash
set -euo pipefail

# Review-only: writes a saved plan; never applies.
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
infra_dir="$repo_root/infra/aws"
plan_path="${AWS_PLAN_PATH:-$infra_dir/staging.tfplan}"

command -v terraform >/dev/null 2>&1 || { echo "terraform 1.10+ is required" >&2; exit 1; }
for file in terraform.tfvars backend.hcl; do
  [[ -f "$infra_dir/$file" ]] || { echo "Missing $infra_dir/$file; copy $file.example and fill it in." >&2; exit 1; }
done

cd "$infra_dir"
terraform init -input=false -backend-config=backend.hcl
terraform fmt -check -recursive
terraform validate
terraform plan -input=false -var-file=terraform.tfvars -out="$plan_path"
echo "Saved review plan to $plan_path. No AWS resources were changed."
