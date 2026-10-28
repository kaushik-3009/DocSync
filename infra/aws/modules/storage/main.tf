data "aws_caller_identity" "current" {}

# --- Application files: exports/ (expiring) and uploads/ (kept) ---------------

resource "aws_s3_bucket" "files" {
  #checkov:skip=CKV_AWS_18:Server access logs are off by default; object access goes through presigned URLs issued after app-level authorization, which the audit log records.
  #checkov:skip=CKV_AWS_144:Single-region deployment; uploads are recoverable through versioning.
  #checkov:skip=CKV_AWS_145:SSE-S3 is used; SSE-KMS adds per-request cost without a different threat model here.
  #checkov:skip=CKV2_AWS_62:No consumers for S3 event notifications.
  bucket        = "${var.name}-files-${data.aws_caller_identity.current.account_id}"
  force_destroy = var.force_destroy
}

resource "aws_s3_bucket_public_access_block" "files" {
  bucket                  = aws_s3_bucket.files.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "files" {
  bucket = aws_s3_bucket.files.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

# Versioning protects user uploads from accidental overwrite or deletion;
# old versions expire below.
resource "aws_s3_bucket_versioning" "files" {
  bucket = aws_s3_bucket.files.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "files" {
  bucket = aws_s3_bucket.files.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "files" {
  bucket = aws_s3_bucket.files.id

  rule {
    id     = "expire-exports"
    status = "Enabled"
    filter {
      prefix = "exports/"
    }
    expiration {
      days = var.export_retention_days
    }
  }

  rule {
    id     = "expire-old-versions"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration {
      noncurrent_days = 30
    }
  }

  rule {
    id     = "abort-incomplete-uploads"
    status = "Enabled"
    filter {}
    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

resource "aws_s3_bucket_cors_configuration" "files" {
  bucket = aws_s3_bucket.files.id
  cors_rule {
    allowed_methods = ["PUT", "GET"]
    allowed_origins = concat(var.allowed_origins, var.enable_client_cdn ? ["https://${aws_cloudfront_distribution.client[0].domain_name}"] : [])
    allowed_headers = ["content-type", "content-length"]
    max_age_seconds = 3000
  }
}

data "aws_iam_policy_document" "files_tls_only" {
  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.files.arn,
      "${aws_s3_bucket.files.arn}/*",
    ]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "files" {
  bucket     = aws_s3_bucket.files.id
  policy     = data.aws_iam_policy_document.files_tls_only.json
  depends_on = [aws_s3_bucket_public_access_block.files]
}

# --- Static client: S3 origin, reachable only through CloudFront -------------

resource "aws_s3_bucket" "client" {
  #checkov:skip=CKV_AWS_18:Holds only public build output served through CloudFront.
  #checkov:skip=CKV_AWS_21:Build output is reproducible from git; versioning adds nothing.
  #checkov:skip=CKV_AWS_144:Reproducible build output.
  #checkov:skip=CKV_AWS_145:Public build output; SSE-S3 default encryption applies.
  #checkov:skip=CKV2_AWS_61:Deploys overwrite the whole site; nothing accumulates.
  #checkov:skip=CKV2_AWS_62:No consumers for S3 event notifications.
  count         = var.enable_client_cdn ? 1 : 0
  bucket        = "${var.name}-client-${data.aws_caller_identity.current.account_id}"
  force_destroy = true # build output, always reproducible
}

resource "aws_s3_bucket_public_access_block" "client" {
  count                   = var.enable_client_cdn ? 1 : 0
  bucket                  = aws_s3_bucket.client[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_cloudfront_origin_access_control" "client" {
  count                             = var.enable_client_cdn ? 1 : 0
  name                              = "${var.name}-client"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_response_headers_policy" "client" {
  count = var.enable_client_cdn ? 1 : 0
  name  = "${var.name}-client-security"

  security_headers_config {
    strict_transport_security {
      access_control_max_age_sec = 31536000
      include_subdomains         = true
      preload                    = true
      override                   = true
    }
    content_type_options {
      override = true
    }
    frame_options {
      frame_option = "DENY"
      override     = true
    }
    referrer_policy {
      referrer_policy = "strict-origin-when-cross-origin"
      override        = true
    }
  }
}

resource "aws_cloudfront_distribution" "client" {
  #checkov:skip=CKV_AWS_68:A CloudFront WAF must live in us-east-1; the static client has no dynamic surface and the API is behind the regional WAF.
  #checkov:skip=CKV_AWS_86:Access logs off by default for the static client.
  #checkov:skip=CKV_AWS_174:The default *.cloudfront.net certificate cannot set a minimum TLS version; configure a custom domain to enforce TLS 1.2+.
  #checkov:skip=CKV2_AWS_42:Same as above.
  #checkov:skip=CKV_AWS_310:Single S3 origin; S3 is the durability layer.
  #checkov:skip=CKV_AWS_374:The product has no geographic restrictions.
  #checkov:skip=CKV2_AWS_47:See CKV_AWS_68.
  count               = var.enable_client_cdn ? 1 : 0
  enabled             = true
  default_root_object = "index.html"
  price_class         = "PriceClass_100"
  comment             = "${var.name} client"

  origin {
    origin_id                = "client"
    domain_name              = aws_s3_bucket.client[0].bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.client[0].id
  }

  default_cache_behavior {
    target_origin_id           = "client"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = "658327ea-f89d-4fab-a63d-7e88639e58f6" # Managed-CachingOptimized
    response_headers_policy_id = aws_cloudfront_response_headers_policy.client[0].id
  }

  # Single-page app: unknown paths serve index.html.
  custom_error_response {
    error_code         = 403
    response_code      = 200
    response_page_path = "/index.html"
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }
}

data "aws_iam_policy_document" "client_bucket" {
  count = var.enable_client_cdn ? 1 : 0
  statement {
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.client[0].arn}/*"]
    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.client[0].arn]
    }
  }
}

resource "aws_s3_bucket_policy" "client" {
  count      = var.enable_client_cdn ? 1 : 0
  bucket     = aws_s3_bucket.client[0].id
  policy     = data.aws_iam_policy_document.client_bucket[0].json
  depends_on = [aws_s3_bucket_public_access_block.client]
}
