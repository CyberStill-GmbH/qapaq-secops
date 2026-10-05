locals {
  ecr_repositories = {
    api     = "${var.project}-api"
    worker  = "${var.project}-worker"
    krakend = "${var.project}-krakend"
  }

  s3_buckets = {
    raw       = "${var.project}-${var.environment}-raw-${var.account_id}"
    evidence  = "${var.project}-${var.environment}-evidence-${var.account_id}"
    artifacts = "${var.project}-${var.environment}-artifacts-${var.account_id}"
  }

  metadata_secrets = {
    entra_client_secret        = "${var.project}/${var.environment}/entra/client-secret"
    wazuh_indexer_reader_user  = "${var.project}/${var.environment}/wazuh/indexer-reader-username"
    wazuh_indexer_reader_pass  = "${var.project}/${var.environment}/wazuh/indexer-reader-password"
    wazuh_gateway_access_token = "${var.project}/${var.environment}/wazuh/gateway-access-token"
    wazuh_cursor_secret        = "${var.project}/${var.environment}/wazuh/cursor-secret"
    secret_fingerprint_key     = "${var.project}/${var.environment}/secret-fingerprint-key"
  }

  ecr_repository_arns = [
    for repository in aws_ecr_repository.this : repository.arn
  ]
}

data "aws_partition" "current" {}

resource "aws_ecr_repository" "this" {
  for_each = local.ecr_repositories

  name                 = each.value
  image_tag_mutability = "IMMUTABLE"
  force_delete         = false

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }

  tags = {
    Name    = each.value
    Service = each.key
  }
}

resource "aws_ecr_lifecycle_policy" "this" {
  for_each = aws_ecr_repository.this

  repository = each.value.name
  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Expire untagged images after one day."
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 1
        }
        action = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "Keep the newest 20 immutable commit images."
        selection = {
          tagStatus     = "tagged"
          tagPrefixList = ["sha-"]
          countType     = "imageCountMoreThan"
          countNumber   = 20
        }
        action = { type = "expire" }
      }
    ]
  })
}

resource "aws_s3_bucket" "this" {
  for_each = local.s3_buckets

  bucket        = each.value
  force_destroy = false

  tags = {
    Name     = each.value
    DataType = each.key
  }
}

resource "aws_kms_key" "s3" {
  description             = "Customer-managed key for QAPAQ SECOPS demo S3 buckets."
  deletion_window_in_days = 30
  enable_key_rotation     = true

  tags = {
    Name    = "${var.project}-${var.environment}-s3"
    Purpose = "encrypt-demo-storage"
  }
}

resource "aws_s3_bucket_public_access_block" "this" {
  for_each = aws_s3_bucket.this

  bucket                  = each.value.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "this" {
  for_each = aws_s3_bucket.this

  bucket = each.value.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "this" {
  for_each = aws_s3_bucket.this

  bucket = each.value.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.s3.arn
    }

    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_versioning" "evidence" {
  bucket = aws_s3_bucket.this["evidence"].id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "this" {
  for_each = aws_s3_bucket.this

  bucket = each.value.id

  rule {
    id     = "abort-incomplete-multipart-uploads"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

data "aws_iam_policy_document" "bucket_transport" {
  for_each = aws_s3_bucket.this

  statement {
    sid    = "DenyInsecureTransport"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions = ["s3:*"]
    resources = [
      each.value.arn,
      "${each.value.arn}/*"
    ]

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "this" {
  for_each = aws_s3_bucket.this

  bucket = each.value.id
  policy = data.aws_iam_policy_document.bucket_transport[each.key].json
}

resource "aws_secretsmanager_secret" "metadata" {
  for_each = local.metadata_secrets

  name                    = each.value
  description             = "Metadata placeholder only. Secret value is provisioned out-of-band after approval."
  recovery_window_in_days = 30

  tags = {
    Name    = each.value
    Purpose = "secret-metadata-placeholder"
  }
}

data "aws_iam_policy_document" "github_ecr_assume_role" {
  statement {
    sid     = "GitHubActionsMainOnly"
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = ["arn:${data.aws_partition.current.partition}:iam::${var.account_id}:oidc-provider/token.actions.githubusercontent.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repository}:ref:refs/heads/main"]
    }
  }
}

resource "aws_iam_role" "github_ecr_publisher" {
  name                 = "${var.project}-${var.environment}-github-ecr-publisher"
  assume_role_policy   = data.aws_iam_policy_document.github_ecr_assume_role.json
  max_session_duration = 3600

  tags = {
    Name    = "${var.project}-${var.environment}-github-ecr-publisher"
    Purpose = "publish-demo-container-images"
  }
}

data "aws_iam_policy_document" "github_ecr_publish" {
  statement {
    sid       = "GetRegistryAuthorizationToken"
    effect    = "Allow"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid    = "PublishOnlyDemoRepositories"
    effect = "Allow"
    actions = [
      "ecr:BatchGetImage",
      "ecr:BatchCheckLayerAvailability",
      "ecr:CompleteLayerUpload",
      "ecr:InitiateLayerUpload",
      "ecr:PutImage",
      "ecr:UploadLayerPart"
    ]
    resources = local.ecr_repository_arns
  }
}

resource "aws_iam_role_policy" "github_ecr_publish" {
  name   = "publish-demo-ecr-images"
  role   = aws_iam_role.github_ecr_publisher.id
  policy = data.aws_iam_policy_document.github_ecr_publish.json
}
