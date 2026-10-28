locals {
  name = "${var.project}-${var.environment}"

  tags = {
    Project      = var.project
    Environment  = var.environment
    Owner        = var.owner
    DestroyAfter = var.destroy_after
    ManagedBy    = "terraform"
  }

  allowed_origins = distinct(concat(var.allowed_origins, module.storage.client_url == null ? [] : [module.storage.client_url]))

  # Built from the data tier's endpoints so nobody pastes connection strings
  # by hand. TLS is mandatory for both (RDS force_ssl, ElastiCache transit
  # encryption); the image trusts the RDS CA bundle.
  runtime_secret = merge(
    {
      DATABASE_URL = "postgres://${urlencode(module.data.db_username)}:${urlencode(var.db_password)}@${module.data.postgres_endpoint}/collab?sslmode=verify-full"
      REDIS_URL    = "rediss://:${urlencode(var.redis_auth_token)}@${module.data.redis_endpoint}:6379"
      JWT_SECRET   = var.jwt_secret
    },
    var.gemini_api_key == "" ? {} : { GEMINI_API_KEY = var.gemini_api_key },
    var.resend_api_key == "" ? {} : { RESEND_API_KEY = var.resend_api_key, EMAIL_FROM = var.email_from },
  )
}

module "network" {
  source             = "./modules/network"
  name               = local.name
  enable_nat_gateway = var.enable_nat_gateway
}

module "edge" {
  source              = "./modules/edge"
  name                = local.name
  vpc_id              = module.network.vpc_id
  public_subnet_ids   = module.network.public_subnet_ids
  vpc_cidr            = module.network.vpc_cidr
  deletion_protection = var.db_deletion_protection
  certificate_arn     = var.certificate_arn
  api_domain_name     = var.api_domain_name
  route53_zone_id     = var.route53_zone_id
  enable_waf          = var.enable_waf
}

# Gateways and workers: reachable only from the ALB.
resource "aws_security_group" "tasks" {
  #checkov:skip=CKV2_AWS_5:Attached to the ECS services and data-tier ingress rules inside modules.
  #checkov:skip=CKV_AWS_382:Tasks call third-party APIs (Gemini, Resend) through the optional NAT gateway; there is no ingress beyond the ALB.
  name        = "${local.name}-tasks"
  description = "ECS tasks; ingress only from the ALB"
  vpc_id      = module.network.vpc_id

  ingress {
    description     = "ALB to gateway"
    from_port       = 1234
    to_port         = 1234
    protocol        = "tcp"
    security_groups = [module.edge.alb_security_group_id]
  }

  egress {
    description = "Data tier, VPC endpoints, and (with NAT) third-party APIs"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

module "data" {
  source                    = "./modules/data"
  name                      = local.name
  vpc_id                    = module.network.vpc_id
  subnet_ids                = module.network.private_subnet_ids
  client_security_group_ids = [aws_security_group.tasks.id]
  db_password               = var.db_password
  db_multi_az               = var.db_multi_az
  db_deletion_protection    = var.db_deletion_protection
  redis_auth_token          = var.redis_auth_token
  redis_replicas            = var.redis_replicas
}

module "storage" {
  source            = "./modules/storage"
  name              = local.name
  allowed_origins   = var.allowed_origins
  enable_client_cdn = var.enable_client_cdn
  force_destroy     = !var.db_deletion_protection
}

resource "aws_ecr_repository" "server" {
  name                 = "${local.name}-server"
  image_tag_mutability = "IMMUTABLE"

  encryption_configuration {
    encryption_type = "KMS"
  }

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "server" {
  repository = aws_ecr_repository.server.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the 30 most recent images"
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 30 }
      action       = { type = "expire" }
    }]
  })
}

resource "aws_secretsmanager_secret" "runtime" {
  #checkov:skip=CKV_AWS_149:Encrypted with the AWS-managed key; only the ECS execution role can read it.
  #checkov:skip=CKV2_AWS_57:Values are rotated by re-applying with new variables, which also restarts tasks.
  name                    = "${local.name}/runtime"
  description             = "Runtime configuration injected into ECS tasks"
  recovery_window_in_days = var.db_deletion_protection ? 7 : 0
}

resource "aws_secretsmanager_secret_version" "runtime" {
  secret_id     = aws_secretsmanager_secret.runtime.id
  secret_string = jsonencode(local.runtime_secret)
}

module "service" {
  source                 = "./modules/service"
  name                   = local.name
  aws_region             = var.aws_region
  image_uri              = var.image_uri
  private_subnet_ids     = module.network.private_subnet_ids
  task_security_group_id = aws_security_group.tasks.id
  target_group_arn       = module.edge.target_group_arn
  listener_arns          = module.edge.listener_arns
  alb_resource_label     = "${module.edge.alb_arn_suffix}/${module.edge.target_group_arn_suffix}"
  runtime_secret_arn     = aws_secretsmanager_secret.runtime.arn
  secret_keys            = keys(local.runtime_secret)
  allowed_origins        = local.allowed_origins
  files_bucket_name      = module.storage.files_bucket_name
  files_bucket_arn       = module.storage.files_bucket_arn
  gateway_min_count      = var.gateway_min_count
  gateway_max_count      = var.gateway_max_count
  worker_count           = var.worker_count
  log_retention_days     = var.log_retention_days
  extra_environment      = var.resend_api_key == "" ? {} : { APP_BASE_URL = coalesce(module.storage.client_url, "http://localhost:5173") }

  depends_on = [aws_secretsmanager_secret_version.runtime]
}

module "monitoring" {
  source                     = "./modules/monitoring"
  name                       = local.name
  aws_region                 = var.aws_region
  alarm_email                = var.alarm_email
  alb_arn_suffix             = module.edge.alb_arn_suffix
  target_group_arn_suffix    = module.edge.target_group_arn_suffix
  cluster_name               = module.service.cluster_name
  gateway_service_name       = module.service.gateway_service_name
  postgres_identifier        = module.data.postgres_identifier
  redis_replication_group_id = module.data.redis_replication_group_id
}

module "ci_access" {
  count                   = var.github_repository == "" ? 0 : 1
  source                  = "./modules/ci_access"
  name                    = local.name
  github_repository       = var.github_repository
  create_oidc_provider    = var.create_github_oidc_provider
  ecr_repository_arn      = aws_ecr_repository.server.arn
  cluster_name            = module.service.cluster_name
  pass_role_arns          = [module.service.execution_role_arn, module.service.task_role_arn]
  client_bucket_arn       = module.storage.client_bucket_arn
  client_distribution_arn = module.storage.client_distribution_arn
}
