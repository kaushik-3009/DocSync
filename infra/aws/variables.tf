variable "aws_region" {
  description = "AWS region for the short-lived evidence environment."
  type        = string
  default     = "us-east-2"
}

variable "project" {
  description = "Short, lowercase project name used in resource names."
  type        = string
  default     = "docsync"
}

variable "environment" {
  description = "Environment label. This scaffold is intentionally staging-only."
  type        = string
  default     = "staging"
}

variable "owner" {
  description = "Human owner recorded on every tagged resource."
  type        = string
  default     = "kaushik"
}

variable "destroy_after" {
  description = "UTC expiry timestamp recorded in tags. Replace before apply."
  type        = string
  default     = "SET-BEFORE-APPLY"
}

variable "image_uri" {
  description = "Immutable URI for the gateway and worker image (ECR or another reviewed registry)."
  type        = string
  default     = ""
}

variable "allowed_origin" {
  description = "Exact browser origin allowed by ALLOWED_ORIGINS. Set after choosing the client URL."
  type        = string
  default     = ""
}

variable "db_username" {
  description = "RDS application username."
  type        = string
  default     = "collab"
}

variable "db_password" {
  description = "RDS password. Supply through an uncommitted tfvars file or an environment variable; never commit it."
  type        = string
  sensitive   = true
  default     = ""
}

variable "redis_auth_token" {
  description = "ElastiCache Redis AUTH token. Supply through an uncommitted tfvars file or an environment variable; never commit it."
  type        = string
  sensitive   = true
  default     = ""
}

variable "gateway_desired_count" {
  description = "Keep at zero until Secrets Manager is populated. Set to 2 only for the approved run."
  type        = number
  default     = 0

  validation {
    condition     = contains([0, 2], var.gateway_desired_count)
    error_message = "gateway_desired_count must be 0 (safe bootstrap) or 2 (approved benchmark run)."
  }
}

variable "worker_desired_count" {
  description = "Keep at zero for bootstrap; set to one for the approved BullMQ worker evidence run."
  type        = number
  default     = 0

  validation {
    condition     = contains([0, 1], var.worker_desired_count)
    error_message = "worker_desired_count must be 0 (safe bootstrap) or 1 (approved evidence run)."
  }
}

variable "worker_cpu" {
  description = "Fargate CPU units for the single staging BullMQ worker."
  type        = number
  default     = 256
}

variable "worker_memory" {
  description = "Fargate memory in MiB for the single staging BullMQ worker."
  type        = number
  default     = 512
}

variable "ws_connect_rate_limit_points" {
  description = "Per-IP WebSocket connection budget for the staging task. Keep production default at 30; benchmark runs may use a separately documented higher value."
  type        = number
  default     = 30

  validation {
    condition     = var.ws_connect_rate_limit_points >= 1 && var.ws_connect_rate_limit_points <= 1000
    error_message = "ws_connect_rate_limit_points must be between 1 and 1000."
  }
}

variable "gateway_cpu" {
  description = "Fargate CPU units per gateway."
  type        = number
  default     = 512
}

variable "gateway_memory" {
  description = "Fargate memory in MiB per gateway."
  type        = number
  default     = 1024
}

variable "log_retention_days" {
  description = "Short CloudWatch retention for the evidence session."
  type        = number
  default     = 3

  validation {
    condition     = var.log_retention_days >= 1 && var.log_retention_days <= 7
    error_message = "Keep log retention between 1 and 7 days for this cost-limited staging run."
  }
}
