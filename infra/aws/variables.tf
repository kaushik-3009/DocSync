variable "aws_region" {
  type    = string
  default = "us-east-2"
}

variable "project" {
  description = "Short, lowercase project name used in resource names."
  type        = string
  default     = "docsync"
}

variable "environment" {
  type    = string
  default = "staging"
}

variable "owner" {
  description = "Human owner recorded on every tagged resource."
  type        = string
}

variable "destroy_after" {
  description = "UTC expiry recorded in tags for short-lived environments, or \"never\"."
  type        = string
  default     = "never"
}

# --- Application -------------------------------------------------------------

variable "image_uri" {
  description = "Initial gateway/worker image (prefer a digest). Later deploys come from the CD workflow."
  type        = string

  validation {
    condition     = trimspace(var.image_uri) != ""
    error_message = "image_uri must reference a pushed image."
  }
}

variable "allowed_origins" {
  description = "Exact browser origins for CORS/WebSocket checks. The CloudFront client URL is added automatically."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for origin in var.allowed_origins : origin != "*" && can(regex("^https?://", origin))])
    error_message = "allowed_origins must be explicit http(s) origins; wildcards are not permitted."
  }
}

variable "jwt_secret" {
  type      = string
  sensitive = true

  validation {
    condition     = length(var.jwt_secret) >= 32
    error_message = "jwt_secret must contain at least 32 characters."
  }
}

variable "gemini_api_key" {
  description = "Optional. Requires enable_nat_gateway so tasks can reach the Gemini API."
  type        = string
  sensitive   = true
  default     = ""
}

variable "resend_api_key" {
  description = "Optional invitation email delivery. Requires enable_nat_gateway."
  type        = string
  sensitive   = true
  default     = ""
}

variable "email_from" {
  type    = string
  default = ""
}

# --- Network and edge ----------------------------------------------------------

variable "enable_nat_gateway" {
  type    = bool
  default = false
}

variable "api_domain_name" {
  description = "Public API hostname; with route53_zone_id, an ACM certificate and alias record are created."
  type        = string
  default     = ""
}

variable "route53_zone_id" {
  type    = string
  default = ""
}

variable "certificate_arn" {
  description = "Existing ACM certificate instead of issuing one."
  type        = string
  default     = ""
}

variable "enable_waf" {
  type    = bool
  default = true
}

variable "enable_client_cdn" {
  type    = bool
  default = true
}

# --- Data --------------------------------------------------------------------

variable "db_password" {
  type      = string
  sensitive = true
}

variable "redis_auth_token" {
  type      = string
  sensitive = true
}

variable "db_multi_az" {
  type    = bool
  default = false
}

variable "db_deletion_protection" {
  type    = bool
  default = true
}

variable "redis_replicas" {
  type    = number
  default = 0
}

# --- Compute -----------------------------------------------------------------

variable "gateway_min_count" {
  description = "Zero parks the service (e.g. between benchmark sessions)."
  type        = number
  default     = 2
}

variable "gateway_max_count" {
  type    = number
  default = 6
}

variable "worker_count" {
  type    = number
  default = 1
}

variable "log_retention_days" {
  type    = number
  default = 14
}

# --- Operations ----------------------------------------------------------------

variable "alarm_email" {
  type    = string
  default = ""
}

variable "github_repository" {
  description = "owner/repo for the OIDC deploy role; empty skips creating it."
  type        = string
  default     = ""
}

variable "create_github_oidc_provider" {
  type    = bool
  default = true
}
