# Función Lambda arm64 con rol IAM propio, log group con retención y KMS, VPC opcional,
# código placeholder inline (zip generado) o desde S3, DLQ y concurrencia reservada opcionales.
#
# managed_by_ci = true → Terraform ignora cambios de código (el CI despliega con
# UpdateFunctionCode y Terraform no lo revierte). ignore_changes no admite condiciones,
# por eso hay dos recursos excluyentes con count.

terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.7"
    }
  }
}

variable "function_name" {
  type = string
}

variable "description" {
  type    = string
  default = ""
}

variable "runtime" {
  type    = string
  default = "nodejs22.x"
}

variable "handler" {
  type    = string
  default = "index.handler"
}

variable "memory_size" {
  type    = number
  default = 512
}

variable "timeout" {
  type    = number
  default = 30
}

variable "inline_source" {
  description = "Código placeholder: nombre de archivo y contenido. Se usa si s3_artifact es null."
  type = object({
    filename = string
    content  = string
  })
  default = null
}

variable "s3_artifact" {
  description = "Paquete del código en S3."
  type = object({
    bucket = string
    key    = string
  })
  default = null
}

variable "managed_by_ci" {
  description = "Si es true, Terraform ignora los cambios de código posteriores a la creación."
  type        = bool
  default     = true
}

variable "environment" {
  type    = map(string)
  default = {}
}

variable "kms_key_arn" {
  description = "CMK para variables de entorno y log group."
  type        = string
}

variable "log_retention_days" {
  type    = number
  default = 30
}

variable "vpc_config" {
  type = object({
    subnet_ids         = list(string)
    security_group_ids = list(string)
  })
  default = null
}

variable "reserved_concurrency" {
  description = "-1 = sin reserva."
  type        = number
  default     = -1
}

variable "dead_letter_target_arn" {
  description = "ARN SQS/SNS para invocaciones asíncronas fallidas."
  type        = string
  default     = null
}

variable "tracing_mode" {
  type    = string
  default = "Active"
}

variable "policy_statements" {
  description = "Statements IAM adicionales para el rol de la función."
  type = list(object({
    sid        = optional(string)
    effect     = optional(string, "Allow")
    actions    = list(string)
    resources  = list(string)
    conditions = optional(list(object({ test = string, variable = string, values = list(string) })), [])
  }))
  default = []
}

variable "tags" {
  type    = map(string)
  default = {}
}

data "aws_partition" "current" {}

locals {
  use_s3 = var.s3_artifact != null
}

data "archive_file" "placeholder" {
  count       = local.use_s3 ? 0 : 1
  type        = "zip"
  output_path = "${path.root}/.build/${var.function_name}.zip"

  source {
    filename = var.inline_source.filename
    content  = var.inline_source.content
  }
}

data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "this" {
  name                 = "${var.function_name}-role"
  assume_role_policy   = data.aws_iam_policy_document.assume.json
  max_session_duration = 3600
  tags                 = var.tags
}

resource "aws_cloudwatch_log_group" "this" {
  name              = "/aws/lambda/${var.function_name}"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.kms_key_arn
  tags              = var.tags
}

data "aws_iam_policy_document" "base" {
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.this.arn}:*"]
  }

  statement {
    sid       = "XRay"
    actions   = ["xray:PutTraceSegments", "xray:PutTelemetryRecords"]
    resources = ["*"]
  }

  statement {
    sid       = "EnvKms"
    actions   = ["kms:Decrypt"]
    resources = [var.kms_key_arn]
  }

  dynamic "statement" {
    for_each = var.vpc_config == null ? [] : [1]
    content {
      sid = "VpcEni"
      actions = [
        "ec2:CreateNetworkInterface",
        "ec2:DescribeNetworkInterfaces",
        "ec2:DeleteNetworkInterface",
        "ec2:AssignPrivateIpAddresses",
        "ec2:UnassignPrivateIpAddresses",
      ]
      resources = ["*"]
    }
  }

  dynamic "statement" {
    for_each = var.dead_letter_target_arn == null ? [] : [var.dead_letter_target_arn]
    content {
      sid       = "DeadLetter"
      actions   = startswith(split(":", statement.value)[2], "sqs") ? ["sqs:SendMessage"] : ["sns:Publish"]
      resources = [statement.value]
    }
  }

  dynamic "statement" {
    for_each = var.policy_statements
    content {
      sid       = statement.value.sid
      effect    = statement.value.effect
      actions   = statement.value.actions
      resources = statement.value.resources

      dynamic "condition" {
        for_each = statement.value.conditions
        content {
          test     = condition.value.test
          variable = condition.value.variable
          values   = condition.value.values
        }
      }
    }
  }
}

resource "aws_iam_role_policy" "this" {
  name   = "${var.function_name}-policy"
  role   = aws_iam_role.this.id
  policy = data.aws_iam_policy_document.base.json
}

locals {
  function_args = {
    filename         = local.use_s3 ? null : data.archive_file.placeholder[0].output_path
    source_code_hash = local.use_s3 ? null : data.archive_file.placeholder[0].output_base64sha256
    s3_bucket        = local.use_s3 ? var.s3_artifact.bucket : null
    s3_key           = local.use_s3 ? var.s3_artifact.key : null
  }
}

resource "aws_lambda_function" "ci" {
  count = var.managed_by_ci ? 1 : 0

  function_name                  = var.function_name
  description                    = var.description
  role                           = aws_iam_role.this.arn
  runtime                        = var.runtime
  handler                        = var.handler
  architectures                  = ["arm64"]
  memory_size                    = var.memory_size
  timeout                        = var.timeout
  filename                       = local.function_args.filename
  source_code_hash               = local.function_args.source_code_hash
  s3_bucket                      = local.function_args.s3_bucket
  s3_key                         = local.function_args.s3_key
  kms_key_arn                    = var.kms_key_arn
  reserved_concurrent_executions = var.reserved_concurrency
  tags                           = var.tags

  environment {
    variables = merge({ NODE_OPTIONS = startswith(var.runtime, "nodejs") ? "--enable-source-maps" : "" }, var.environment)
  }

  logging_config {
    log_format = "JSON"
    log_group  = aws_cloudwatch_log_group.this.name
  }

  tracing_config {
    mode = var.tracing_mode
  }

  dynamic "vpc_config" {
    for_each = var.vpc_config == null ? [] : [var.vpc_config]
    content {
      subnet_ids         = vpc_config.value.subnet_ids
      security_group_ids = vpc_config.value.security_group_ids
    }
  }

  dynamic "dead_letter_config" {
    for_each = var.dead_letter_target_arn == null ? [] : [var.dead_letter_target_arn]
    content {
      target_arn = dead_letter_config.value
    }
  }

  lifecycle {
    ignore_changes = [filename, source_code_hash, s3_bucket, s3_key, s3_object_version]
  }

  depends_on = [aws_iam_role_policy.this, aws_cloudwatch_log_group.this]
}

resource "aws_lambda_function" "managed" {
  count = var.managed_by_ci ? 0 : 1

  function_name                  = var.function_name
  description                    = var.description
  role                           = aws_iam_role.this.arn
  runtime                        = var.runtime
  handler                        = var.handler
  architectures                  = ["arm64"]
  memory_size                    = var.memory_size
  timeout                        = var.timeout
  filename                       = local.function_args.filename
  source_code_hash               = local.function_args.source_code_hash
  s3_bucket                      = local.function_args.s3_bucket
  s3_key                         = local.function_args.s3_key
  kms_key_arn                    = var.kms_key_arn
  reserved_concurrent_executions = var.reserved_concurrency
  tags                           = var.tags

  environment {
    variables = var.environment
  }

  logging_config {
    log_format = "JSON"
    log_group  = aws_cloudwatch_log_group.this.name
  }

  tracing_config {
    mode = var.tracing_mode
  }

  dynamic "vpc_config" {
    for_each = var.vpc_config == null ? [] : [var.vpc_config]
    content {
      subnet_ids         = vpc_config.value.subnet_ids
      security_group_ids = vpc_config.value.security_group_ids
    }
  }

  dynamic "dead_letter_config" {
    for_each = var.dead_letter_target_arn == null ? [] : [var.dead_letter_target_arn]
    content {
      target_arn = dead_letter_config.value
    }
  }

  depends_on = [aws_iam_role_policy.this, aws_cloudwatch_log_group.this]
}

locals {
  fn = var.managed_by_ci ? aws_lambda_function.ci[0] : aws_lambda_function.managed[0]
}

output "function_name" {
  value = local.fn.function_name
}

output "arn" {
  value = local.fn.arn
}

output "invoke_arn" {
  value = local.fn.invoke_arn
}

output "role_arn" {
  value = aws_iam_role.this.arn
}

output "role_name" {
  value = aws_iam_role.this.name
}

output "log_group_name" {
  value = aws_cloudwatch_log_group.this.name
}
