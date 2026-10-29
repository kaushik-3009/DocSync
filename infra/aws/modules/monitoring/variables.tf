variable "name" {
  type = string
}

variable "aws_region" {
  type = string
}

variable "alarm_email" {
  description = "Subscribed to the alarm topic when set (confirm the email AWS sends)."
  type        = string
  default     = ""
}

variable "alb_arn_suffix" {
  type = string
}

variable "target_group_arn_suffix" {
  type = string
}

variable "cluster_name" {
  type = string
}

variable "gateway_service_name" {
  type = string
}

variable "postgres_identifier" {
  type = string
}

variable "redis_replication_group_id" {
  type = string
}
