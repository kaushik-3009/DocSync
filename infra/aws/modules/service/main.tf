locals {
  common_environment = merge({
    NODE_ENV          = "production"
    LOG_LEVEL         = "info"
    ALLOWED_ORIGINS   = join(",", var.allowed_origins)
    EXPORTS_S3_BUCKET = var.files_bucket_name
    UPLOADS_S3_BUCKET = var.files_bucket_name
  }, var.extra_environment)

  secrets = [for key in var.secret_keys : { name = key, valueFrom = "${var.runtime_secret_arn}:${key}::" }]

  log_config = { for component in ["gateway", "worker"] : component => {
    logDriver = "awslogs"
    options = {
      "awslogs-group"         = aws_cloudwatch_log_group.this[component].name
      "awslogs-region"        = var.aws_region
      "awslogs-stream-prefix" = component
    }
  } }

  # The app writes nothing to disk; Node only needs a writable /tmp.
  hardening = {
    readonlyRootFilesystem = true
    linuxParameters        = { initProcessEnabled = true }
    mountPoints            = [{ sourceVolume = "tmp", containerPath = "/tmp", readOnly = false }]
  }
}

resource "aws_cloudwatch_log_group" "this" {
  #checkov:skip=CKV_AWS_158:CloudWatch encrypts logs at rest by default; a CMK adds cost without a different threat model here.
  #checkov:skip=CKV_AWS_338:Retention is the log_retention_days variable.
  for_each          = toset(["gateway", "worker"])
  name              = "/ecs/${var.name}/${each.value}"
  retention_in_days = var.log_retention_days
}

resource "aws_ecs_cluster" "this" {
  name = var.name
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

# Execution role: pull the image, write logs, read the runtime secret.
resource "aws_iam_role" "execution" {
  name               = "${var.name}-ecs-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "execution_secret" {
  name = "read-runtime-secret"
  role = aws_iam_role.execution.id
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = var.runtime_secret_arn }]
  })
}

# Task role: what the application itself may do — only its own S3 prefixes.
resource "aws_iam_role" "task" {
  name               = "${var.name}-ecs-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy" "task_files" {
  name = "files-bucket"
  role = aws_iam_role.task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["s3:PutObject", "s3:GetObject"]
      Resource = ["${var.files_bucket_arn}/exports/*", "${var.files_bucket_arn}/uploads/*"]
    }]
  })
}

resource "aws_ecs_task_definition" "gateway" {
  family                   = "${var.name}-gateway"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = tostring(var.gateway_cpu)
  memory                   = tostring(var.gateway_memory)
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }
  volume {
    name = "tmp"
  }

  container_definitions = jsonencode([merge(local.hardening, {
    name      = "gateway"
    image     = var.image_uri
    essential = true
    portMappings = [{
      containerPort = var.container_port
      protocol      = "tcp"
    }]
    environment = [for key, value in merge(local.common_environment, {
      PORT        = tostring(var.container_port)
      TRUST_PROXY = "1"
      # The worker service owns BullMQ consumers.
      RUN_WORKERS = "false"
    }) : { name = key, value = value }]
    secrets          = local.secrets
    logConfiguration = local.log_config["gateway"]
    # Matches the gateway's own shutdown drain (5 s rooms + 5 s outbox).
    stopTimeout = 30
  })])
}

resource "aws_ecs_task_definition" "worker" {
  family                   = "${var.name}-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = tostring(var.worker_cpu)
  memory                   = tostring(var.worker_memory)
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }
  volume {
    name = "tmp"
  }

  container_definitions = jsonencode([merge(local.hardening, {
    name             = "worker"
    image            = var.image_uri
    essential        = true
    command          = ["node", "--enable-source-maps", "dist/worker.js"]
    environment      = [for key, value in local.common_environment : { name = key, value = value }]
    secrets          = local.secrets
    logConfiguration = local.log_config["worker"]
    stopTimeout      = 30
  })])
}

resource "aws_ecs_service" "gateway" {
  name                               = "${var.name}-gateway"
  cluster                            = aws_ecs_cluster.this.id
  task_definition                    = aws_ecs_task_definition.gateway.arn
  desired_count                      = var.gateway_min_count
  launch_type                        = "FARGATE"
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  health_check_grace_period_seconds  = 30
  enable_ecs_managed_tags            = true
  propagate_tags                     = "SERVICE"

  # A deploy whose tasks never become healthy rolls back on its own.
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [var.task_security_group_id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = var.target_group_arn
    container_name   = "gateway"
    container_port   = var.container_port
  }

  lifecycle {
    # The CD pipeline registers new task definitions; autoscaling owns the count.
    ignore_changes = [task_definition, desired_count]
  }

  depends_on = [aws_iam_role_policy_attachment.execution, aws_iam_role_policy.execution_secret, terraform_data.listeners_ready]
}

resource "terraform_data" "listeners_ready" {
  input = var.listener_arns
}

resource "aws_ecs_service" "worker" {
  name                               = "${var.name}-worker"
  cluster                            = aws_ecs_cluster.this.id
  task_definition                    = aws_ecs_task_definition.worker.arn
  desired_count                      = var.worker_count
  launch_type                        = "FARGATE"
  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 100
  enable_ecs_managed_tags            = true
  propagate_tags                     = "SERVICE"

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [var.task_security_group_id]
    assign_public_ip = false
  }

  lifecycle {
    ignore_changes = [task_definition]
  }

  depends_on = [aws_iam_role_policy_attachment.execution, aws_iam_role_policy.execution_secret]
}

resource "aws_appautoscaling_target" "gateway" {
  service_namespace  = "ecs"
  resource_id        = "service/${aws_ecs_cluster.this.name}/${aws_ecs_service.gateway.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  min_capacity       = var.gateway_min_count
  max_capacity       = var.gateway_max_count
}

resource "aws_appautoscaling_policy" "gateway_cpu" {
  name               = "${var.name}-gateway-cpu"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.gateway.service_namespace
  resource_id        = aws_appautoscaling_target.gateway.resource_id
  scalable_dimension = aws_appautoscaling_target.gateway.scalable_dimension

  target_tracking_scaling_policy_configuration {
    target_value = 60
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
    # Scale in slowly: removing a gateway reconnects its WebSocket clients.
    scale_in_cooldown  = 300
    scale_out_cooldown = 60
  }
}

resource "aws_appautoscaling_policy" "gateway_requests" {
  name               = "${var.name}-gateway-requests"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.gateway.service_namespace
  resource_id        = aws_appautoscaling_target.gateway.resource_id
  scalable_dimension = aws_appautoscaling_target.gateway.scalable_dimension

  target_tracking_scaling_policy_configuration {
    target_value = var.alb_target_requests_per_task
    predefined_metric_specification {
      predefined_metric_type = "ALBRequestCountPerTarget"
      resource_label         = var.alb_resource_label
    }
    scale_in_cooldown  = 300
    scale_out_cooldown = 60
  }
}
