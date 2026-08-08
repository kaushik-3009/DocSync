#!/usr/bin/env bash
set -euo pipefail

# Review-only workflow. This script never calls terraform apply.
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
infra_dir="$repo_root/infra/aws"
plan_path="${AWS_PLAN_PATH:-$infra_dir/staging.tfplan}"

command -v terraform >/dev/null 2>&1 || {
  echo "terraform is required (1.6+); install it before running this review." >&2
  exit 1
}

if [[ ! -f "$infra_dir/terraform.tfvars" ]]; then
  echo "Missing $infra_dir/terraform.tfvars; copy terraform.tfvars.example and replace placeholders." >&2
  exit 1
fi

cd "$infra_dir"
terraform init -backend=false
terraform fmt -check -recursive
terraform validate
terraform plan -input=false -var-file=terraform.tfvars -out="$plan_path"
echo "Saved review plan to $plan_path"
echo "No AWS resources were created by this script."
