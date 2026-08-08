locals {
  name = "${var.project}-${var.environment}"

  tags = {
    Project      = var.project
    Environment  = var.environment
    Owner        = var.owner
    DestroyAfter = var.destroy_after
    ManagedBy    = "terraform"
  }

  # The default VPC avoids creating a second NAT gateway/VPC while this
  # short-lived scaffold is being reviewed. Tasks receive public IPs, but the
  # gateway port is reachable only through the ALB security group.
  subnet_ids = slice(sort(tolist(data.aws_subnets.default.ids)), 0, 2)
}

data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

resource "aws_ecr_repository" "gateway" {
  name                 = "${local.name}-gateway"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = true

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = local.tags
}

resource "aws_security_group" "alb" {
  name        = "${local.name}-alb"
  description = "Public HTTP entry point for the time-boxed staging ALB"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description = "Temporary HTTP ingress; put TLS/CloudFront in front before any public production use"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "gateway" {
  name        = "${local.name}-gateway"
  description = "Gateway tasks accept traffic only from the ALB"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description     = "ALB to Node gateway"
    from_port       = 1234
    to_port         = 1234
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "postgres" {
  name        = "${local.name}-postgres"
  description = "RDS accepts connections only from gateway tasks"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.gateway.id]
  }
}

resource "aws_security_group" "redis" {
  name        = "${local.name}-redis"
  description = "ElastiCache accepts connections only from gateway tasks"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [aws_security_group.gateway.id]
  }
}

resource "aws_lb" "edge" {
  name               = "${local.name}-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = local.subnet_ids
}

resource "aws_lb_target_group" "gateway" {
  name        = "${local.name}-gateway"
  port        = 1234
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = data.aws_vpc.default.id

  health_check {
    enabled             = true
    path                = "/ready"
    protocol            = "HTTP"
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.edge.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.gateway.arn
  }
}

resource "aws_db_subnet_group" "postgres" {
  name       = "${local.name}-postgres"
  subnet_ids = local.subnet_ids
}

resource "aws_db_instance" "postgres" {
  identifier                 = "${local.name}-postgres"
  engine                     = "postgres"
  instance_class             = "db.t3.micro"
  allocated_storage          = 20
  storage_type               = "gp3"
  db_name                    = "collab"
  username                   = var.db_username
  password                   = var.db_password
  port                       = 5432
  db_subnet_group_name       = aws_db_subnet_group.postgres.name
  vpc_security_group_ids     = [aws_security_group.postgres.id]
  publicly_accessible        = false
  multi_az                   = false
  backup_retention_period    = 1
  deletion_protection        = false
  skip_final_snapshot        = true
  apply_immediately          = true
  auto_minor_version_upgrade = true

  lifecycle {
    precondition {
      condition     = length(var.db_password) >= 16
      error_message = "db_password must contain at least 16 characters before apply."
    }
  }
}

resource "aws_elasticache_subnet_group" "redis" {
  name       = "${local.name}-redis"
  subnet_ids = local.subnet_ids
}

resource "aws_elasticache_replication_group" "redis" {
  replication_group_id       = replace(local.name, "_", "-")
  description                = "Single-node Redis for DocSync fanout, rate limits, and BullMQ"
  engine                     = "redis"
  engine_version             = "7.1"
  node_type                  = "cache.t4g.micro"
  num_cache_clusters         = 1
  port                       = 6379
  auth_token                 = var.redis_auth_token
  transit_encryption_enabled = true
  at_rest_encryption_enabled = true
  automatic_failover_enabled = false
  multi_az_enabled           = false
  apply_immediately          = true
  snapshot_retention_limit   = 1
  subnet_group_name          = aws_elasticache_subnet_group.redis.name
  security_group_ids         = [aws_security_group.redis.id]

  lifecycle {
    precondition {
      condition     = length(var.redis_auth_token) >= 16
      error_message = "redis_auth_token must contain at least 16 characters before apply."
    }
  }
}

resource "aws_secretsmanager_secret" "runtime" {
  name                    = "${local.name}/runtime"
  description             = "Runtime values populated manually after RDS and Redis exist"
  recovery_window_in_days = 0
}

resource "aws_cloudwatch_log_group" "gateway" {
  name              = "/ecs/${local.name}/gateway"
  retention_in_days = var.log_retention_days
}

resource "aws_cloudwatch_log_group" "worker" {
  name              = "/ecs/${local.name}/worker"
  retention_in_days = var.log_retention_days
}

resource "aws_ecs_cluster" "main" {
  name = local.name
}

data "aws_iam_policy_document" "ecs_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "${local.name}-ecs-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume_role.json
}

resource "aws_iam_role_policy_attachment" "execution_managed" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "execution_secrets" {
  name = "read-runtime-secret"
  role = aws_iam_role.execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = aws_secretsmanager_secret.runtime.arn
    }]
  })
}

resource "aws_iam_role" "task" {
  name               = "${local.name}-ecs-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume_role.json
}

resource "aws_ecs_task_definition" "gateway" {
  family                   = "${local.name}-gateway"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = tostring(var.gateway_cpu)
  memory                   = tostring(var.gateway_memory)
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  container_definitions = jsonencode([{
    name      = "gateway"
    image     = var.image_uri
    essential = true

    portMappings = [{
      containerPort = 1234
      hostPort      = 1234
      protocol      = "tcp"
    }]

    environment = [
      { name = "NODE_ENV", value = "production" },
      { name = "PORT", value = "1234" },
      { name = "TRUST_PROXY", value = "1" },
      { name = "LOG_LEVEL", value = "info" },
      { name = "ALLOWED_ORIGINS", value = var.allowed_origin },
      { name = "WS_CONNECT_RATE_LIMIT_POINTS", value = tostring(var.ws_connect_rate_limit_points) },
    ]

    secrets = [
      { name = "DATABASE_URL", valueFrom = "${aws_secretsmanager_secret.runtime.arn}:DATABASE_URL::" },
      { name = "REDIS_URL", valueFrom = "${aws_secretsmanager_secret.runtime.arn}:REDIS_URL::" },
      { name = "JWT_SECRET", valueFrom = "${aws_secretsmanager_secret.runtime.arn}:JWT_SECRET::" },
    ]

    healthCheck = {
      command     = ["CMD-SHELL", "node -e \"fetch('http://127.0.0.1:1234/ready').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))\""]
      interval    = 15
      timeout     = 5
      retries     = 3
      startPeriod = 30
    }

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.gateway.name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "gateway"
      }
    }
  }])

  lifecycle {
    precondition {
      condition     = trimspace(var.image_uri) != ""
      error_message = "image_uri must point to a reviewed, immutable gateway image before apply."
    }
    precondition {
      condition     = trimspace(var.allowed_origin) != "" && var.allowed_origin != "*"
      error_message = "allowed_origin must be one explicit browser origin; wildcard CORS is not permitted."
    }
  }
}

resource "aws_ecs_service" "gateway" {
  name            = "${local.name}-gateway"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.gateway.arn
  desired_count   = var.gateway_desired_count
  launch_type     = "FARGATE"

  deployment_minimum_healthy_percent = 50
  deployment_maximum_percent         = 200
  enable_ecs_managed_tags            = true
  propagate_tags                     = "SERVICE"

  network_configuration {
    subnets          = local.subnet_ids
    security_groups  = [aws_security_group.gateway.id]
    assign_public_ip = true
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.gateway.arn
    container_name   = "gateway"
    container_port   = 1234
  }

  depends_on = [aws_lb_listener.http, aws_iam_role_policy_attachment.execution_managed, aws_iam_role_policy.execution_secrets]
}

resource "aws_ecs_task_definition" "worker" {
  family                   = "${local.name}-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = tostring(var.worker_cpu)
  memory                   = tostring(var.worker_memory)
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  container_definitions = jsonencode([{
    name      = "worker"
    image     = var.image_uri
    essential = true

    command = ["/app/packages/server/node_modules/.bin/tsx", "/app/packages/server/src/worker.ts"]

    environment = [
      { name = "NODE_ENV", value = "production" },
      { name = "PORT", value = "1235" },
      { name = "LOG_LEVEL", value = "info" },
      { name = "RUN_WORKERS", value = "true" },
      { name = "ALLOWED_ORIGINS", value = var.allowed_origin },
    ]

    secrets = [
      { name = "DATABASE_URL", valueFrom = "${aws_secretsmanager_secret.runtime.arn}:DATABASE_URL::" },
      { name = "REDIS_URL", valueFrom = "${aws_secretsmanager_secret.runtime.arn}:REDIS_URL::" },
      { name = "JWT_SECRET", valueFrom = "${aws_secretsmanager_secret.runtime.arn}:JWT_SECRET::" },
    ]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.worker.name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "worker"
      }
    }
  }])

  lifecycle {
    precondition {
      condition     = trimspace(var.image_uri) != ""
      error_message = "image_uri must point to a reviewed, immutable worker image before apply."
    }
    precondition {
      condition     = trimspace(var.allowed_origin) != "" && var.allowed_origin != "*"
      error_message = "allowed_origin must be one explicit browser origin; wildcard CORS is not permitted."
    }
  }
}

resource "aws_ecs_service" "worker" {
  name            = "${local.name}-worker"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.worker.arn
  desired_count   = var.worker_desired_count
  launch_type     = "FARGATE"

  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 100
  enable_ecs_managed_tags            = true
  propagate_tags                     = "SERVICE"

  network_configuration {
    subnets          = local.subnet_ids
    security_groups  = [aws_security_group.gateway.id]
    assign_public_ip = true
  }

  depends_on = [aws_iam_role_policy_attachment.execution_managed, aws_iam_role_policy.execution_secrets]
}
