# Ingesta cloud-native: EventBridge → SQS (+DLQ) → Lambda worker.
# - Bus propio <name>-security para eventos qapaq.wazuh (los publica el nodo Wazuh / overlay).
# - GuardDuty y Security Hub publican en el bus por defecto; las reglas los enrutan a la cola.
# - EventBridge Scheduler dispara la reconciliación cada 5 minutos.

resource "aws_cloudwatch_event_bus" "security" {
  name = "${local.name}-security"
}

resource "aws_sqs_queue" "ingest_dlq" {
  name                      = "${local.name}-ingest-dlq"
  sqs_managed_sse_enabled   = true
  message_retention_seconds = 1209600
}

resource "aws_sqs_queue" "ingest" {
  name                       = "${local.name}-ingest"
  sqs_managed_sse_enabled    = true
  message_retention_seconds  = 1209600
  visibility_timeout_seconds = local.lambda_timeout.worker * 6
  receive_wait_time_seconds  = 20

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.ingest_dlq.arn
    maxReceiveCount     = 5
  })
}

resource "aws_sqs_queue_redrive_allow_policy" "ingest_dlq" {
  queue_url = aws_sqs_queue.ingest_dlq.id

  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.ingest.arn]
  })
}

locals {
  ingest_rules = {
    guardduty = {
      bus     = "default"
      pattern = { source = ["aws.guardduty"], "detail-type" = ["GuardDuty Finding"] }
    }
    securityhub = {
      bus = "default"
      pattern = {
        source        = ["aws.securityhub"]
        "detail-type" = ["Security Hub Findings - Imported"]
        detail        = { findings = { Severity = { Label = ["HIGH", "CRITICAL"] } } }
      }
    }
    wazuh = {
      bus     = aws_cloudwatch_event_bus.security.name
      pattern = { source = ["qapaq.wazuh"] }
    }
  }
}

resource "aws_cloudwatch_event_rule" "ingest" {
  for_each = local.ingest_rules

  name           = "${local.name}-ingest-${each.key}"
  description    = "Enruta ${each.key} a la cola de ingesta"
  event_bus_name = each.value.bus
  event_pattern  = jsonencode(each.value.pattern)
}

resource "aws_cloudwatch_event_target" "ingest" {
  for_each = local.ingest_rules

  rule           = aws_cloudwatch_event_rule.ingest[each.key].name
  event_bus_name = each.value.bus
  arn            = aws_sqs_queue.ingest.arn

  retry_policy {
    maximum_event_age_in_seconds = 86400
    maximum_retry_attempts       = 185
  }
}

data "aws_iam_policy_document" "ingest_queue" {
  statement {
    sid       = "EventBridgeSend"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.ingest.arn]

    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }

    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [for r in aws_cloudwatch_event_rule.ingest : r.arn]
    }
  }

  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["sqs:*"]
    resources = [aws_sqs_queue.ingest.arn]

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

resource "aws_sqs_queue_policy" "ingest" {
  queue_url = aws_sqs_queue.ingest.id
  policy    = data.aws_iam_policy_document.ingest_queue.json
}

resource "aws_lambda_event_source_mapping" "worker" {
  event_source_arn                   = aws_sqs_queue.ingest.arn
  function_name                      = module.lambda_worker.arn
  batch_size                         = 10
  maximum_batching_window_in_seconds = 5
  function_response_types            = ["ReportBatchItemFailures"]

  scaling_config {
    maximum_concurrency = var.worker_max_concurrency
  }
}

# ---------------------------------------------------------------------------
# EventBridge Scheduler: reconciliación cada 5 minutos
# ---------------------------------------------------------------------------
data "aws_iam_policy_document" "scheduler_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
}

resource "aws_iam_role" "scheduler" {
  name               = "${local.name}-scheduler"
  assume_role_policy = data.aws_iam_policy_document.scheduler_assume.json
}

resource "aws_iam_role_policy" "scheduler" {
  name = "invoke-scheduled-lambdas"
  role = aws_iam_role.scheduler.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "lambda:InvokeFunction"
      Resource = [module.lambda_worker.arn, module.lambda_agent_onboarding.arn]
    }]
  })
}

resource "aws_scheduler_schedule_group" "main" {
  name = local.name
}

resource "aws_scheduler_schedule" "reconcile" {
  name                         = "${local.name}-reconcile"
  group_name                   = aws_scheduler_schedule_group.main.name
  schedule_expression          = "rate(5 minutes)"
  schedule_expression_timezone = "UTC"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = module.lambda_worker.arn
    role_arn = aws_iam_role.scheduler.arn
    input    = jsonencode({ source = "qapaq.scheduler", task = "reconcile" })

    retry_policy {
      maximum_retry_attempts       = 2
      maximum_event_age_in_seconds = 600
    }
  }
}
