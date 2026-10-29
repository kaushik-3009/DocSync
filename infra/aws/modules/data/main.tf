resource "aws_security_group" "postgres" {
  name        = "${var.name}-postgres"
  description = "Postgres from ECS tasks only"
  vpc_id      = var.vpc_id

  ingress {
    description     = "Postgres from tasks"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = var.client_security_group_ids
  }
}

resource "aws_security_group" "redis" {
  name        = "${var.name}-redis"
  description = "Redis from ECS tasks only"
  vpc_id      = var.vpc_id

  ingress {
    description     = "Redis from tasks"
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = var.client_security_group_ids
  }
}

resource "aws_db_subnet_group" "postgres" {
  name       = "${var.name}-postgres"
  subnet_ids = var.subnet_ids
}

# Clients must use TLS; pgvector is created by the app's migrations.
resource "aws_db_parameter_group" "postgres" {
  name   = "${var.name}-postgres16"
  family = "postgres16"

  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }

  parameter {
    name  = "log_min_duration_statement"
    value = "500"
  }
}

data "aws_iam_policy_document" "rds_monitoring_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["monitoring.rds.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "rds_monitoring" {
  name               = "${var.name}-rds-monitoring"
  assume_role_policy = data.aws_iam_policy_document.rds_monitoring_assume.json
}

resource "aws_iam_role_policy_attachment" "rds_monitoring" {
  role       = aws_iam_role.rds_monitoring.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonRDSEnhancedMonitoringRole"
}

resource "aws_db_instance" "postgres" {
  #checkov:skip=CKV_AWS_157:Multi-AZ is the db_multi_az variable; staging defaults to single-AZ for cost.
  #checkov:skip=CKV_AWS_354:Performance Insights uses the AWS-managed key; a CMK adds cost without a different threat model here.
  identifier                          = "${var.name}-postgres"
  engine                              = "postgres"
  engine_version                      = "16"
  instance_class                      = var.db_instance_class
  allocated_storage                   = var.db_allocated_storage
  max_allocated_storage               = var.db_allocated_storage * 5
  storage_type                        = "gp3"
  storage_encrypted                   = true
  db_name                             = "collab"
  username                            = var.db_username
  password                            = var.db_password
  port                                = 5432
  db_subnet_group_name                = aws_db_subnet_group.postgres.name
  parameter_group_name                = aws_db_parameter_group.postgres.name
  vpc_security_group_ids              = [aws_security_group.postgres.id]
  publicly_accessible                 = false
  multi_az                            = var.db_multi_az
  backup_retention_period             = var.db_backup_retention_days
  backup_window                       = "07:00-08:00"
  maintenance_window                  = "sun:08:30-sun:09:30"
  deletion_protection                 = var.db_deletion_protection
  skip_final_snapshot                 = !var.db_deletion_protection
  final_snapshot_identifier           = var.db_deletion_protection ? "${var.name}-postgres-final" : null
  copy_tags_to_snapshot               = true
  auto_minor_version_upgrade          = true
  performance_insights_enabled        = true
  monitoring_interval                 = 60
  monitoring_role_arn                 = aws_iam_role.rds_monitoring.arn
  iam_database_authentication_enabled = true
  enabled_cloudwatch_logs_exports     = ["postgresql"]
}

resource "aws_elasticache_subnet_group" "redis" {
  name       = "${var.name}-redis"
  subnet_ids = var.subnet_ids
}

resource "aws_elasticache_replication_group" "redis" {
  #checkov:skip=CKV_AWS_191:At-rest encryption uses the AWS-managed key; a CMK adds cost without a different threat model here.
  #checkov:skip=CKV2_AWS_50:Failover follows redis_replicas; staging defaults to one node for cost.
  replication_group_id       = var.name
  description                = "DocSync fanout, rate limits and BullMQ"
  engine                     = "redis"
  engine_version             = "7.1"
  node_type                  = var.redis_node_type
  num_cache_clusters         = 1 + var.redis_replicas
  port                       = 6379
  auth_token                 = var.redis_auth_token
  transit_encryption_enabled = true
  at_rest_encryption_enabled = true
  automatic_failover_enabled = var.redis_replicas > 0
  multi_az_enabled           = var.redis_replicas > 0
  snapshot_retention_limit   = 1
  subnet_group_name          = aws_elasticache_subnet_group.redis.name
  security_group_ids         = [aws_security_group.redis.id]
}
