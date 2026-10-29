variable "name" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "subnet_ids" {
  description = "Private subnets for RDS and ElastiCache."
  type        = list(string)
}

variable "client_security_group_ids" {
  description = "Security groups (ECS tasks) allowed to reach Postgres and Redis."
  type        = list(string)
}

variable "db_username" {
  type    = string
  default = "collab"
}

variable "db_password" {
  type      = string
  sensitive = true

  validation {
    condition     = length(var.db_password) >= 16
    error_message = "db_password must contain at least 16 characters."
  }
}

variable "db_instance_class" {
  type    = string
  default = "db.t4g.micro"
}

variable "db_allocated_storage" {
  type    = number
  default = 20
}

variable "db_multi_az" {
  description = "Synchronous standby in a second AZ (automatic failover, roughly doubles RDS cost)."
  type        = bool
  default     = false
}

variable "db_backup_retention_days" {
  type    = number
  default = 7
}

variable "db_deletion_protection" {
  description = "Keep true for anything holding real data; staging may turn it off to allow teardown."
  type        = bool
  default     = true
}

variable "redis_auth_token" {
  type      = string
  sensitive = true

  validation {
    condition     = length(var.redis_auth_token) >= 16
    error_message = "redis_auth_token must contain at least 16 characters."
  }
}

variable "redis_node_type" {
  type    = string
  default = "cache.t4g.micro"
}

variable "redis_replicas" {
  description = "Read replicas; one or more enables automatic failover across AZs."
  type        = number
  default     = 0
}
