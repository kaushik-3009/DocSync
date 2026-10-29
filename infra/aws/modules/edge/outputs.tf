output "alb_arn_suffix" {
  value = aws_lb.this.arn_suffix
}

output "alb_dns_name" {
  value = aws_lb.this.dns_name
}

output "alb_security_group_id" {
  value = aws_security_group.alb.id
}

output "target_group_arn" {
  value = aws_lb_target_group.gateway.arn
}

output "target_group_arn_suffix" {
  value = aws_lb_target_group.gateway.arn_suffix
}

output "https_enabled" {
  value = local.https_enabled
}

output "api_base_url" {
  value = var.api_domain_name != "" ? "https://${var.api_domain_name}" : "${local.https_enabled ? "https" : "http"}://${aws_lb.this.dns_name}"
}

# Listeners must exist before the ECS service registers targets.
output "listener_arns" {
  value = concat([aws_lb_listener.http.arn], aws_lb_listener.https[*].arn)
}
