output "files_bucket_name" {
  value = aws_s3_bucket.files.bucket
}

output "files_bucket_arn" {
  value = aws_s3_bucket.files.arn
}

output "client_bucket_name" {
  value = var.enable_client_cdn ? aws_s3_bucket.client[0].bucket : null
}

output "client_bucket_arn" {
  value = var.enable_client_cdn ? aws_s3_bucket.client[0].arn : null
}

output "client_distribution_id" {
  value = var.enable_client_cdn ? aws_cloudfront_distribution.client[0].id : null
}

output "client_distribution_arn" {
  value = var.enable_client_cdn ? aws_cloudfront_distribution.client[0].arn : null
}

output "client_url" {
  value = var.enable_client_cdn ? "https://${aws_cloudfront_distribution.client[0].domain_name}" : null
}
