variable "name" {
  type = string
}

variable "github_repository" {
  description = "owner/repo allowed to assume the deploy role."
  type        = string
}

variable "github_environment" {
  description = "Only workflow jobs bound to this GitHub environment (with its protection rules) can deploy."
  type        = string
  default     = "staging"
}

variable "create_oidc_provider" {
  description = "An account has one GitHub OIDC provider; set false if it already exists."
  type        = bool
  default     = true
}

variable "ecr_repository_arn" {
  type = string
}

variable "cluster_name" {
  type = string
}

variable "pass_role_arns" {
  description = "ECS execution and task roles the pipeline registers task definitions with."
  type        = list(string)
}

variable "client_bucket_arn" {
  type    = string
  default = null
}

variable "client_distribution_arn" {
  type    = string
  default = null
}
