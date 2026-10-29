output "cluster_name" {
  value = aws_ecs_cluster.this.name
}

output "gateway_service_name" {
  value = aws_ecs_service.gateway.name
}

output "worker_service_name" {
  value = aws_ecs_service.worker.name
}

output "gateway_task_family" {
  value = aws_ecs_task_definition.gateway.family
}

output "worker_task_family" {
  value = aws_ecs_task_definition.worker.family
}

output "execution_role_arn" {
  value = aws_iam_role.execution.arn
}

output "task_role_arn" {
  value = aws_iam_role.task.arn
}
