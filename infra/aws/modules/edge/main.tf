locals {
  issue_certificate = var.certificate_arn == "" && var.api_domain_name != "" && var.route53_zone_id != ""
  certificate_arn   = local.issue_certificate ? aws_acm_certificate_validation.api[0].certificate_arn : var.certificate_arn
  https_enabled     = local.certificate_arn != ""
}

resource "aws_security_group" "alb" {
  #checkov:skip=CKV_AWS_260:Port 80 only redirects to HTTPS once a certificate is configured.
  name        = "${var.name}-alb"
  description = "Public entry point"
  vpc_id      = var.vpc_id

  ingress {
    description = "HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "HTTP (redirected to HTTPS when a certificate is configured)"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    description = "To targets inside the VPC only"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = [var.vpc_cidr]
  }
}

resource "aws_lb" "this" {
  #checkov:skip=CKV2_AWS_76:The attached web ACL includes AWSManagedRulesKnownBadInputsRuleSet (Log4j) via a dynamic block.
  #checkov:skip=CKV_AWS_91:Access logs are off by default to avoid a log bucket per environment; WAF logs and CloudWatch metrics cover abuse and errors.
  name                       = "${var.name}-alb"
  load_balancer_type         = "application"
  security_groups            = [aws_security_group.alb.id]
  subnets                    = var.public_subnet_ids
  drop_invalid_header_fields = true
  enable_deletion_protection = var.deletion_protection
  # WebSockets are long-lived; y-websocket traffic (awareness pings) keeps
  # them well inside this window.
  idle_timeout = 300
}

resource "aws_lb_target_group" "gateway" {
  #checkov:skip=CKV_AWS_378:TLS terminates at the ALB; ALB-to-task traffic stays inside private subnets.
  name                 = "${var.name}-gateway"
  port                 = var.container_port
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = var.vpc_id
  deregistration_delay = 30

  health_check {
    path                = "/ready"
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

resource "aws_acm_certificate" "api" {
  count             = local.issue_certificate ? 1 : 0
  domain_name       = var.api_domain_name
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "validation" {
  for_each = local.issue_certificate ? {
    for option in aws_acm_certificate.api[0].domain_validation_options : option.domain_name => option
  } : {}
  zone_id = var.route53_zone_id
  name    = each.value.resource_record_name
  type    = each.value.resource_record_type
  records = [each.value.resource_record_value]
  ttl     = 60
}

resource "aws_acm_certificate_validation" "api" {
  count                   = local.issue_certificate ? 1 : 0
  certificate_arn         = aws_acm_certificate.api[0].arn
  validation_record_fqdns = [for record in aws_route53_record.validation : record.fqdn]
}

resource "aws_route53_record" "api" {
  count   = var.api_domain_name != "" && var.route53_zone_id != "" ? 1 : 0
  zone_id = var.route53_zone_id
  name    = var.api_domain_name
  type    = "A"
  alias {
    name                   = aws_lb.this.dns_name
    zone_id                = aws_lb.this.zone_id
    evaluate_target_health = true
  }
}

resource "aws_lb_listener" "https" {
  count             = local.https_enabled ? 1 : 0
  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = local.certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.gateway.arn
  }
}

# With TLS configured, port 80 only redirects; without it (experiments only)
# it forwards so the stack is still reachable.
resource "aws_lb_listener" "http" {
  #checkov:skip=CKV_AWS_2:Redirects to HTTPS whenever a certificate is configured; forwards only in certificate-less experiments.
  #checkov:skip=CKV_AWS_378:Same as above.
  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = local.https_enabled ? "redirect" : "forward"
    target_group_arn = local.https_enabled ? null : aws_lb_target_group.gateway.arn

    dynamic "redirect" {
      for_each = local.https_enabled ? [1] : []
      content {
        port        = "443"
        protocol    = "HTTPS"
        status_code = "HTTP_301"
      }
    }
  }
}

resource "aws_wafv2_web_acl" "this" {
  #checkov:skip=CKV_AWS_192:AWSManagedRulesKnownBadInputsRuleSet (Log4j) is included via the dynamic rule block below.
  #checkov:skip=CKV2_AWS_76:Same as above.
  count = var.enable_waf ? 1 : 0
  name  = "${var.name}-alb"
  scope = "REGIONAL"

  default_action {
    allow {}
  }

  dynamic "rule" {
    for_each = {
      AWSManagedRulesCommonRuleSet          = 10
      AWSManagedRulesKnownBadInputsRuleSet  = 20
      AWSManagedRulesAmazonIpReputationList = 30
    }
    content {
      name     = rule.key
      priority = rule.value
      override_action {
        none {}
      }
      statement {
        managed_rule_group_statement {
          vendor_name = "AWS"
          name        = rule.key
          # Yjs updates are binary WebSocket frames, but request bodies for
          # the HTTP API stay small; the 8 KB body inspection rule would
          # otherwise block legitimate assistant prompts.
          dynamic "rule_action_override" {
            for_each = rule.key == "AWSManagedRulesCommonRuleSet" ? ["SizeRestrictions_BODY"] : []
            content {
              name = rule_action_override.value
              action_to_use {
                count {}
              }
            }
          }
        }
      }
      visibility_config {
        cloudwatch_metrics_enabled = true
        metric_name                = rule.key
        sampled_requests_enabled   = true
      }
    }
  }

  rule {
    name     = "per-ip-rate-limit"
    priority = 40
    action {
      block {}
    }
    statement {
      rate_based_statement {
        limit              = var.waf_rate_limit_per_5min
        aggregate_key_type = "IP"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "per-ip-rate-limit"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${var.name}-alb"
    sampled_requests_enabled   = true
  }
}

resource "aws_cloudwatch_log_group" "waf" {
  #checkov:skip=CKV_AWS_158:CloudWatch encrypts logs at rest by default.
  #checkov:skip=CKV_AWS_338:Short retention: WAF logs are for incident triage.
  count             = var.enable_waf ? 1 : 0
  name              = "aws-waf-logs-${var.name}" # WAF requires this prefix
  retention_in_days = 14
}

resource "aws_wafv2_web_acl_logging_configuration" "this" {
  count                   = var.enable_waf ? 1 : 0
  resource_arn            = aws_wafv2_web_acl.this[0].arn
  log_destination_configs = [aws_cloudwatch_log_group.waf[0].arn]
}

resource "aws_wafv2_web_acl_association" "alb" {
  count        = var.enable_waf ? 1 : 0
  resource_arn = aws_lb.this.arn
  web_acl_arn  = aws_wafv2_web_acl.this[0].arn
}
