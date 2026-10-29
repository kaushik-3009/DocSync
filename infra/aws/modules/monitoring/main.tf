resource "aws_sns_topic" "alarms" {
  name              = "${var.name}-alarms"
  kms_master_key_id = "alias/aws/sns"
}

resource "aws_sns_topic_subscription" "email" {
  count     = var.alarm_email != "" ? 1 : 0
  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

locals {
  alb = { LoadBalancer = var.alb_arn_suffix }
  alarms = {
    alb-5xx = {
      description = "Gateway is returning server errors"
      namespace   = "AWS/ApplicationELB"
      metric      = "HTTPCode_Target_5XX_Count"
      statistic   = "Sum"
      threshold   = 10
      dimensions  = local.alb
    }
    unhealthy-targets = {
      description = "A gateway task is failing /ready"
      namespace   = "AWS/ApplicationELB"
      metric      = "UnHealthyHostCount"
      statistic   = "Maximum"
      threshold   = 0
      dimensions  = { LoadBalancer = var.alb_arn_suffix, TargetGroup = var.target_group_arn_suffix }
    }
    gateway-cpu = {
      description = "Gateways are saturated beyond what autoscaling absorbed"
      namespace   = "AWS/ECS"
      metric      = "CPUUtilization"
      statistic   = "Average"
      threshold   = 85
      dimensions  = { ClusterName = var.cluster_name, ServiceName = var.gateway_service_name }
    }
    postgres-cpu = {
      description = "Postgres CPU is high"
      namespace   = "AWS/RDS"
      metric      = "CPUUtilization"
      statistic   = "Average"
      threshold   = 80
      dimensions  = { DBInstanceIdentifier = var.postgres_identifier }
    }
    redis-memory = {
      description = "Redis memory is nearly full (fanout and BullMQ would start failing)"
      namespace   = "AWS/ElastiCache"
      metric      = "DatabaseMemoryUsagePercentage"
      statistic   = "Maximum"
      threshold   = 80
      dimensions  = { ReplicationGroupId = var.redis_replication_group_id }
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "this" {
  for_each            = local.alarms
  alarm_name          = "${var.name}-${each.key}"
  alarm_description   = each.value.description
  namespace           = each.value.namespace
  metric_name         = each.value.metric
  statistic           = each.value.statistic
  dimensions          = each.value.dimensions
  period              = 60
  evaluation_periods  = 5
  datapoints_to_alarm = 3
  threshold           = each.value.threshold
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
}

resource "aws_cloudwatch_metric_alarm" "latency_p95" {
  alarm_name          = "${var.name}-alb-latency-p95"
  alarm_description   = "HTTP p95 above 1 s"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "TargetResponseTime"
  extended_statistic  = "p95"
  dimensions          = local.alb
  period              = 60
  evaluation_periods  = 5
  datapoints_to_alarm = 3
  threshold           = 1
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
}

resource "aws_cloudwatch_metric_alarm" "postgres_storage" {
  alarm_name          = "${var.name}-postgres-free-storage"
  alarm_description   = "Postgres has under 2 GiB free"
  namespace           = "AWS/RDS"
  metric_name         = "FreeStorageSpace"
  statistic           = "Minimum"
  dimensions          = { DBInstanceIdentifier = var.postgres_identifier }
  period              = 300
  evaluation_periods  = 1
  threshold           = 2 * 1024 * 1024 * 1024
  comparison_operator = "LessThanThreshold"
  alarm_actions       = [aws_sns_topic.alarms.arn]
}

resource "aws_cloudwatch_dashboard" "this" {
  dashboard_name = var.name
  dashboard_body = jsonencode({
    widgets = [
      for index, widget in [
        { title = "Requests and 5xx", metrics = [["AWS/ApplicationELB", "RequestCount", "LoadBalancer", var.alb_arn_suffix], [".", "HTTPCode_Target_5XX_Count", ".", "."]], stat = "Sum" },
        { title = "Latency p95 (s)", metrics = [["AWS/ApplicationELB", "TargetResponseTime", "LoadBalancer", var.alb_arn_suffix]], stat = "p95" },
        { title = "Gateway CPU / memory (%)", metrics = [["AWS/ECS", "CPUUtilization", "ClusterName", var.cluster_name, "ServiceName", var.gateway_service_name], [".", "MemoryUtilization", ".", ".", ".", "."]], stat = "Average" },
        { title = "Postgres CPU (%)", metrics = [["AWS/RDS", "CPUUtilization", "DBInstanceIdentifier", var.postgres_identifier]], stat = "Average" },
        { title = "Redis memory (%)", metrics = [["AWS/ElastiCache", "DatabaseMemoryUsagePercentage", "ReplicationGroupId", var.redis_replication_group_id]], stat = "Maximum" },
        { title = "Active connections", metrics = [["AWS/ApplicationELB", "ActiveConnectionCount", "LoadBalancer", var.alb_arn_suffix]], stat = "Sum" },
        ] : {
        type   = "metric"
        x      = (index % 3) * 8
        y      = floor(index / 3) * 6
        width  = 8
        height = 6
        properties = {
          title   = widget.title
          metrics = widget.metrics
          stat    = widget.stat
          period  = 60
          region  = var.aws_region
          view    = "timeSeries"
        }
      }
    ]
  })
}
