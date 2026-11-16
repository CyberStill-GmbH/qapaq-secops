# Bucket S3 endurecido: sin acceso público, versionado, SSE-KMS con bucket key,
# política TLS-only (mezclable con additional_policy_json), ciclo de vida y Object Lock opcional.

terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

variable "name" {
  description = "Nombre global del bucket."
  type        = string
}

variable "kms_key_arn" {
  description = "ARN de la CMK para SSE-KMS. null = SSE-S3 (AES256), necesario para destinos que no admiten KMS."
  type        = string
  default     = null
}

variable "force_destroy" {
  description = "Permite destruir el bucket con objetos (solo fuera de prod)."
  type        = bool
  default     = false
}

variable "object_lock" {
  description = "Object Lock opcional. mode: GOVERNANCE o COMPLIANCE."
  type = object({
    mode = string
    days = number
  })
  default = null

  validation {
    condition     = var.object_lock == null || contains(["GOVERNANCE", "COMPLIANCE"], try(var.object_lock.mode, ""))
    error_message = "object_lock.mode debe ser GOVERNANCE o COMPLIANCE."
  }
}

variable "lifecycle_rules" {
  description = "Transiciones: días a Intelligent-Tiering / Glacier, expiración y versiones no actuales. null desactiva cada paso."
  type = object({
    intelligent_tiering_days   = optional(number)
    glacier_days               = optional(number)
    expiration_days            = optional(number)
    noncurrent_expiration_days = optional(number, 90)
  })
  default = {}
}

variable "additional_policy_json" {
  description = "Documento de política adicional (JSON) que se mezcla con la denegación TLS-only."
  type        = string
  default     = null
}

variable "tags" {
  type    = map(string)
  default = {}
}

resource "aws_s3_bucket" "this" {
  bucket              = var.name
  force_destroy       = var.object_lock == null ? var.force_destroy : false
  object_lock_enabled = var.object_lock != null
  tags                = var.tags
}

resource "aws_s3_bucket_ownership_controls" "this" {
  bucket = aws_s3_bucket.this.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "this" {
  bucket                  = aws_s3_bucket.this.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "this" {
  bucket = aws_s3_bucket.this.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "this" {
  bucket = aws_s3_bucket.this.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = var.kms_key_arn == null ? "AES256" : "aws:kms"
      kms_master_key_id = var.kms_key_arn
    }
    bucket_key_enabled = var.kms_key_arn != null
  }
}

resource "aws_s3_bucket_object_lock_configuration" "this" {
  count  = var.object_lock == null ? 0 : 1
  bucket = aws_s3_bucket.this.id

  rule {
    default_retention {
      mode = var.object_lock.mode
      days = var.object_lock.days
    }
  }

  depends_on = [aws_s3_bucket_versioning.this]
}

resource "aws_s3_bucket_lifecycle_configuration" "this" {
  bucket = aws_s3_bucket.this.id

  rule {
    id     = "tiering-and-cleanup"
    status = "Enabled"

    filter {}

    dynamic "transition" {
      for_each = var.lifecycle_rules.intelligent_tiering_days == null ? [] : [var.lifecycle_rules.intelligent_tiering_days]
      content {
        days          = transition.value
        storage_class = "INTELLIGENT_TIERING"
      }
    }

    dynamic "transition" {
      for_each = var.lifecycle_rules.glacier_days == null ? [] : [var.lifecycle_rules.glacier_days]
      content {
        days          = transition.value
        storage_class = "GLACIER"
      }
    }

    dynamic "expiration" {
      for_each = var.lifecycle_rules.expiration_days == null ? [] : [var.lifecycle_rules.expiration_days]
      content {
        days = expiration.value
      }
    }

    dynamic "noncurrent_version_expiration" {
      for_each = var.lifecycle_rules.noncurrent_expiration_days == null ? [] : [var.lifecycle_rules.noncurrent_expiration_days]
      content {
        noncurrent_days = noncurrent_version_expiration.value
      }
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  depends_on = [aws_s3_bucket_versioning.this]
}

data "aws_iam_policy_document" "tls_only" {
  source_policy_documents = var.additional_policy_json == null ? [] : [var.additional_policy_json]

  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.this.arn,
      "${aws_s3_bucket.this.arn}/*",
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

  statement {
    sid     = "DenyOldTls"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.this.arn,
      "${aws_s3_bucket.this.arn}/*",
    ]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "NumericLessThan"
      variable = "s3:TlsVersion"
      values   = ["1.2"]
    }
  }
}

resource "aws_s3_bucket_policy" "this" {
  bucket = aws_s3_bucket.this.id
  policy = data.aws_iam_policy_document.tls_only.json

  depends_on = [aws_s3_bucket_public_access_block.this]
}

output "id" {
  value = aws_s3_bucket.this.id
}

output "arn" {
  value = aws_s3_bucket.this.arn
}

output "bucket_regional_domain_name" {
  value = aws_s3_bucket.this.bucket_regional_domain_name
}
