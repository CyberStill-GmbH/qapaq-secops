# Buckets S3. force_destroy solo fuera de prod; el de auditoría nunca (Object Lock).

module "bucket_audit" {
  source = "./modules/secure_bucket"

  name        = "${local.bucket_prefix}-audit"
  kms_key_arn = aws_kms_key.audit.arn
  object_lock = {
    mode = var.audit_lock_mode
    days = var.audit_lock_days
  }
  lifecycle_rules = {
    intelligent_tiering_days   = 30
    glacier_days               = 180
    noncurrent_expiration_days = null
  }
}

module "bucket_wazuh_snapshots" {
  source = "./modules/secure_bucket"

  name          = "${local.bucket_prefix}-wazuh-snapshots"
  kms_key_arn   = aws_kms_key.data.arn
  force_destroy = !local.is_prod
  lifecycle_rules = {
    intelligent_tiering_days   = 0
    glacier_days               = 90
    expiration_days            = 400
    noncurrent_expiration_days = 30
  }
}

module "bucket_artifacts" {
  source = "./modules/secure_bucket"

  name          = "${local.bucket_prefix}-artifacts"
  kms_key_arn   = aws_kms_key.data.arn
  force_destroy = !local.is_prod
  lifecycle_rules = {
    noncurrent_expiration_days = 60
  }
}

# Bucket de logs: CloudTrail (con la CMK de auditoría vía configuración del trail) y salida
# de comandos SSM (asociación de agentes). La política concede a CloudTrail lo mínimo.
data "aws_iam_policy_document" "logs_bucket" {
  statement {
    sid       = "CloudTrailAclCheck"
    actions   = ["s3:GetBucketAcl"]
    resources = ["arn:${local.partition}:s3:::${local.bucket_prefix}-logs"]

    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceArn"
      values   = ["arn:${local.partition}:cloudtrail:${local.region}:${local.account_id}:trail/${local.name}-trail"]
    }
  }

  statement {
    sid       = "CloudTrailWrite"
    actions   = ["s3:PutObject"]
    resources = ["arn:${local.partition}:s3:::${local.bucket_prefix}-logs/cloudtrail/AWSLogs/${local.account_id}/*"]

    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceArn"
      values   = ["arn:${local.partition}:cloudtrail:${local.region}:${local.account_id}:trail/${local.name}-trail"]
    }
  }
}

module "bucket_logs" {
  source = "./modules/secure_bucket"

  name                   = "${local.bucket_prefix}-logs"
  kms_key_arn            = aws_kms_key.data.arn
  force_destroy          = !local.is_prod
  additional_policy_json = data.aws_iam_policy_document.logs_bucket.json
  lifecycle_rules = {
    intelligent_tiering_days   = 30
    glacier_days               = 90
    expiration_days            = 730
    noncurrent_expiration_days = 30
  }
}

# ---------------------------------------------------------------------------
# Réplica opcional del bucket de auditoría a la cuenta log-archive.
# El bucket destino (con Object Lock y versionado) y su política que permita a este rol
# replicar se gestionan en la cuenta log-archive.
# ---------------------------------------------------------------------------
locals {
  audit_replication = var.audit_replica_bucket_arn != ""
}

data "aws_iam_policy_document" "replication_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["s3.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
}

resource "aws_iam_role" "audit_replication" {
  count = local.audit_replication ? 1 : 0

  name               = "${local.name}-audit-replication"
  assume_role_policy = data.aws_iam_policy_document.replication_assume.json
}

resource "aws_iam_role_policy" "audit_replication" {
  count = local.audit_replication ? 1 : 0

  name = "replicate-audit"
  role = aws_iam_role.audit_replication[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["s3:GetReplicationConfiguration", "s3:ListBucket"]
        Resource = module.bucket_audit.arn
      },
      {
        Effect = "Allow"
        Action = [
          "s3:GetObjectVersionForReplication",
          "s3:GetObjectVersionAcl",
          "s3:GetObjectVersionTagging",
          "s3:GetObjectRetention",
          "s3:GetObjectLegalHold",
        ]
        Resource = "${module.bucket_audit.arn}/*"
      },
      {
        Effect   = "Allow"
        Action   = ["s3:ReplicateObject", "s3:ReplicateDelete", "s3:ReplicateTags", "s3:ObjectOwnerOverrideToBucketOwner"]
        Resource = "${var.audit_replica_bucket_arn}/*"
      },
      {
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = aws_kms_key.audit.arn
      },
      {
        Effect   = "Allow"
        Action   = ["kms:Encrypt", "kms:GenerateDataKey"]
        Resource = var.audit_replica_kms_key_arn
      },
    ]
  })
}

resource "aws_s3_bucket_replication_configuration" "audit" {
  count = local.audit_replication ? 1 : 0

  bucket = module.bucket_audit.id
  role   = aws_iam_role.audit_replication[0].arn

  rule {
    id     = "to-log-archive"
    status = "Enabled"

    filter {}

    delete_marker_replication {
      status = "Disabled"
    }

    source_selection_criteria {
      sse_kms_encrypted_objects {
        status = "Enabled"
      }
    }

    destination {
      bucket  = var.audit_replica_bucket_arn
      account = var.audit_replica_account_id

      access_control_translation {
        owner = "Destination"
      }

      encryption_configuration {
        replica_kms_key_id = var.audit_replica_kms_key_arn
      }
    }
  }

  lifecycle {
    precondition {
      condition     = var.audit_replica_kms_key_arn != "" && can(regex("^[0-9]{12}$", var.audit_replica_account_id))
      error_message = "audit_replica_kms_key_arn y audit_replica_account_id son obligatorios cuando se define audit_replica_bucket_arn."
    }
  }
}
