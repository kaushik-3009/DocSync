terraform {
  # 1.10+ for S3-native state locking (use_lockfile).
  required_version = ">= 1.10.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  # Partial configuration: `terraform init -backend-config=backend.hcl`
  # (see backend.hcl.example). State is encrypted in S3 and locked with a
  # lockfile object, so two operators can't apply concurrently.
  backend "s3" {}
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = local.tags
  }
}
