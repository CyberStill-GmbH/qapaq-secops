# Trail propio de la cuenta para que EventBridge reciba «AWS API Call via CloudTrail».
#
# El trail de la organización (qapaq-security-events-org) vive en la cuenta de gestión y no entrega
# esos eventos al bus por defecto de esta cuenta: sin un trail activo aquí, las reglas de
# aws-monitoring.tf solo ven eventos de servicio (GuardDuty, Security Hub, consola).
# Sin IAM: CloudTrail escribe en S3 con la política del bucket (sin CloudWatch Logs, que pediría rol).
# Costo: segunda copia de eventos de gestión de escritura (~2 USD por 100 000 eventos); sin lecturas
# ni eventos de datos.

data "aws_caller_identity" "trail" {}

resource "aws_s3_bucket" "trail" {
  bucket        = "${var.name}-cloudtrail-${data.aws_caller_identity.trail.account_id}"
  force_destroy = false
  tags          = { Name = "${var.name}-cloudtrail" }
}

resource "aws_s3_bucket_public_access_block" "trail" {
  bucket                  = aws_s3_bucket.trail.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "trail" {
  bucket = aws_s3_bucket.trail.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "trail" {
  bucket = aws_s3_bucket.trail.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "trail" {
  bucket = aws_s3_bucket.trail.id
  rule {
    id     = "expire-90d"
    status = "Enabled"
    filter {}
    expiration {
      days = 90
    }
  }
}

data "aws_iam_policy_document" "trail_bucket" {
  statement {
    sid       = "CloudTrailAclCheck"
    actions   = ["s3:GetBucketAcl"]
    resources = [aws_s3_bucket.trail.arn]
    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceArn"
      values   = ["arn:aws:cloudtrail:${var.aws_region}:${data.aws_caller_identity.trail.account_id}:trail/${var.name}-eventbridge"]
    }
  }
  statement {
    sid       = "CloudTrailWrite"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.trail.arn}/AWSLogs/${data.aws_caller_identity.trail.account_id}/*"]
    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceArn"
      values   = ["arn:aws:cloudtrail:${var.aws_region}:${data.aws_caller_identity.trail.account_id}:trail/${var.name}-eventbridge"]
    }
  }
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.trail.arn, "${aws_s3_bucket.trail.arn}/*"]
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

resource "aws_s3_bucket_policy" "trail" {
  bucket     = aws_s3_bucket.trail.id
  policy     = data.aws_iam_policy_document.trail_bucket.json
  depends_on = [aws_s3_bucket_public_access_block.trail]
}

resource "aws_cloudtrail" "eventbridge" {
  name                          = "${var.name}-eventbridge"
  s3_bucket_name                = aws_s3_bucket.trail.id
  is_multi_region_trail         = true
  include_global_service_events = true
  enable_log_file_validation    = true
  enable_logging                = true

  # Solo escrituras de gestión: es lo que vigilan las reglas de EventBridge y abarata la copia.
  event_selector {
    read_write_type           = "WriteOnly"
    include_management_events = true
  }

  tags       = { Name = "${var.name}-eventbridge" }
  depends_on = [aws_s3_bucket_policy.trail]
}
