output "api_base_url" {
  description = "Set the client's VITE_WS_URL to this with the scheme switched to ws(s) and /ws appended."
  value       = module.edge.api_base_url
}

output "https_enabled" {
  value = module.edge.https_enabled
}

output "client_url" {
  value = module.storage.client_url
}

output "ecr_repository_url" {
  value = aws_ecr_repository.server.repository_url
}

output "cluster_name" {
  value = module.service.cluster_name
}

output "gateway_service_name" {
  value = module.service.gateway_service_name
}

output "worker_service_name" {
  value = module.service.worker_service_name
}

output "client_bucket_name" {
  value = module.storage.client_bucket_name
}

output "client_distribution_id" {
  value = module.storage.client_distribution_id
}

output "github_deploy_role_arn" {
  description = "Set as AWS_DEPLOY_ROLE_ARN on the GitHub \"staging\" environment."
  value       = var.github_repository == "" ? null : module.ci_access[0].deploy_role_arn
}

output "alarm_topic_arn" {
  value = module.monitoring.alarm_topic_arn
}

output "dashboard_name" {
  value = module.monitoring.dashboard_name
}
