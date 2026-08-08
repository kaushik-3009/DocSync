output "alb_url" {
  description = "HTTP endpoint for the staging gateway. Use HTTPS/CloudFront before any public use."
  value       = "http://${aws_lb.edge.dns_name}"
}

output "cluster_name" {
  value = aws_ecs_cluster.main.name
}

output "gateway_service_name" {
  value = aws_ecs_service.gateway.name
}

output "worker_service_name" {
  value = aws_ecs_service.worker.name
}

output "ecr_repository_url" {
  description = "Push the reviewed gateway/worker image here, then use its immutable digest in image_uri."
  value       = aws_ecr_repository.gateway.repository_url
}

output "postgres_endpoint" {
  description = "Populate DATABASE_URL in Secrets Manager after apply."
  value       = aws_db_instance.postgres.endpoint
}

output "redis_primary_endpoint" {
  description = "Populate REDIS_URL in Secrets Manager after apply."
  value       = aws_elasticache_replication_group.redis.primary_endpoint_address
}

output "runtime_secret_arn" {
  description = "Secret must be populated manually before desired_count is raised to 2."
  value       = aws_secretsmanager_secret.runtime.arn
}
