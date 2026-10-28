variable "name" {
  type = string
}

variable "allowed_origins" {
  description = "Browser origins allowed to PUT uploads via presigned URLs."
  type        = list(string)
}

variable "export_retention_days" {
  description = "Generated PDFs are re-creatable, so they expire."
  type        = number
  default     = 7
}

variable "enable_client_cdn" {
  description = "Host the static client on S3 behind CloudFront."
  type        = bool
  default     = true
}

variable "force_destroy" {
  description = "Allow terraform destroy to delete non-empty buckets (staging only)."
  type        = bool
  default     = false
}
