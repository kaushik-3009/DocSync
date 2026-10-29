variable "name" {
  type = string
}

variable "aws_region" {
  type = string
}

variable "image_uri" {
  description = "Immutable image reference (prefer a digest). The CD pipeline replaces it on deploy."
  type        = string
}

variable "private_subnet_ids" {
  type = list(string)
}

variable "task_security_group_id" {
  type = string
}

variable "target_group_arn" {
  type = string
}

variable "listener_arns" {
  description = "Only used to order creation after the load balancer listeners."
  type        = list(string)
}

variable "runtime_secret_arn" {
  type = string
}

variable "secret_keys" {
  description = "Keys of the runtime secret JSON to inject as environment variables."
  type        = list(string)
}

variable "allowed_origins" {
  type = list(string)
}

variable "files_bucket_name" {
  type = string
}

variable "files_bucket_arn" {
  type = string
}

variable "log_retention_days" {
  type    = number
  default = 14
}

variable "container_port" {
  type    = number
  default = 1234
}

variable "gateway_cpu" {
  type    = number
  default = 512
}

variable "gateway_memory" {
  type    = number
  default = 1024
}

variable "gateway_min_count" {
  type    = number
  default = 2
}

variable "gateway_max_count" {
  type    = number
  default = 6
}

variable "worker_cpu" {
  type    = number
  default = 256
}

variable "worker_memory" {
  type    = number
  default = 512
}

variable "worker_count" {
  type    = number
  default = 1
}

variable "alb_target_requests_per_task" {
  description = "Scale out when ALB requests per target exceed this per minute."
  type        = number
  default     = 1000
}

variable "alb_resource_label" {
  description = "<alb arn suffix>/<target group arn suffix>, for the ALBRequestCountPerTarget metric."
  type        = string
}

variable "extra_environment" {
  type    = map(string)
  default = {}
}
