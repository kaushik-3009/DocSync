variable "name" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "vpc_cidr" {
  type = string
}

variable "deletion_protection" {
  type    = bool
  default = true
}

variable "public_subnet_ids" {
  type = list(string)
}

variable "container_port" {
  type    = number
  default = 1234
}

variable "certificate_arn" {
  description = "Existing ACM certificate for the API hostname. Leave empty to issue one from api_domain_name + route53_zone_id, or to run HTTP-only (local experiments only)."
  type        = string
  default     = ""
}

variable "api_domain_name" {
  description = "Public API hostname (e.g. api.docsync.example.com). Requires route53_zone_id to issue a certificate and alias record."
  type        = string
  default     = ""
}

variable "route53_zone_id" {
  type    = string
  default = ""
}

variable "enable_waf" {
  description = "AWS managed rule groups plus a per-IP rate rule in front of the ALB."
  type        = bool
  default     = true
}

variable "waf_rate_limit_per_5min" {
  type    = number
  default = 2000
}
