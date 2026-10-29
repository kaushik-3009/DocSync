variable "name" {
  description = "Prefix for resource names."
  type        = string
}

variable "cidr_block" {
  description = "VPC CIDR. Split into /20 subnets: public (ALB) and private (tasks, data) per AZ."
  type        = string
  default     = "10.40.0.0/16"
}

variable "az_count" {
  description = "Availability zones to span. Two is the minimum for an ALB and Multi-AZ RDS."
  type        = number
  default     = 2

  validation {
    condition     = var.az_count >= 2 && var.az_count <= 3
    error_message = "az_count must be 2 or 3."
  }
}

variable "enable_nat_gateway" {
  description = "One NAT gateway for tasks that must reach the public internet (Gemini, Resend). AWS services are reached through VPC endpoints either way."
  type        = bool
  default     = false
}

variable "flow_log_retention_days" {
  description = "VPC flow logs (accepted and rejected traffic) retention in CloudWatch."
  type        = number
  default     = 14
}

variable "interface_endpoints" {
  description = "AWS services reached privately from the task subnets."
  type        = list(string)
  default     = ["ecr.api", "ecr.dkr", "logs", "secretsmanager"]
}
