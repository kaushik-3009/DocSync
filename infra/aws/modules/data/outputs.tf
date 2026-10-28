output "postgres_endpoint" {
  value = aws_db_instance.postgres.endpoint
}

output "postgres_identifier" {
  value = aws_db_instance.postgres.identifier
}

output "redis_endpoint" {
  value = aws_elasticache_replication_group.redis.primary_endpoint_address
}

output "redis_replication_group_id" {
  value = aws_elasticache_replication_group.redis.id
}

output "db_username" {
  value = var.db_username
}
