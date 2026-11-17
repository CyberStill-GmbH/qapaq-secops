# Ankay: Step Functions STANDARD con aprobación humana.
#
# Validar → SolicitarAprobacion (waitForTaskToken, 24 h) → DecisionAprobacion
#   → aprobado: EjecutarAccion (idempotente) → Auditar → Notificar → Completado
#   → rechazo / timeout / error: Marcar* → AuditarCierre → NotificarCierre → Rechazado | Fallido
#
# La Lambda respond recibe {"step": "...", ...}. La API cierra la espera con
# SendTaskSuccess({"decision": "approved"|"rejected", ...}) o SendTaskFailure(error="Rejected").
# Idempotencia: nombrar la ejecución con el id de la solicitud (StartExecution name) y usar ese
# id como clave en EjecutarAccion.

resource "aws_sns_topic" "approvals" {
  name              = "${local.name}-respond-approvals"
  kms_master_key_id = aws_kms_key.data.arn
}

resource "aws_sns_topic_subscription" "approvals_email" {
  count = var.alert_email == "" ? 0 : 1

  topic_arn = aws_sns_topic.approvals.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

resource "aws_cloudwatch_log_group" "respond" {
  name              = "/aws/vendedlogs/states/${local.name}-respond"
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.data.arn
}

data "aws_iam_policy_document" "sfn_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["states.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
}

resource "aws_iam_role" "respond_sfn" {
  name               = "${local.name}-respond-sfn"
  assume_role_policy = data.aws_iam_policy_document.sfn_assume.json
}

data "aws_iam_policy_document" "respond_sfn" {
  statement {
    sid       = "InvokeRespond"
    actions   = ["lambda:InvokeFunction"]
    resources = [module.lambda_respond.arn, "${module.lambda_respond.arn}:*"]
  }

  statement {
    sid       = "Notify"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.approvals.arn, aws_sns_topic.alerts.arn]
  }

  statement {
    sid       = "Kms"
    actions   = ["kms:GenerateDataKey", "kms:Decrypt"]
    resources = [aws_kms_key.data.arn]
  }

  # Entrega de logs y X-Ray: estas acciones no admiten restricción por recurso.
  statement {
    sid = "LogsDelivery"
    actions = [
      "logs:CreateLogDelivery",
      "logs:GetLogDelivery",
      "logs:UpdateLogDelivery",
      "logs:DeleteLogDelivery",
      "logs:ListLogDeliveries",
      "logs:PutResourcePolicy",
      "logs:DescribeResourcePolicies",
      "logs:DescribeLogGroups",
      "xray:PutTraceSegments",
      "xray:PutTelemetryRecords",
      "xray:GetSamplingRules",
      "xray:GetSamplingTargets",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "respond_sfn" {
  name   = "respond-sfn"
  role   = aws_iam_role.respond_sfn.id
  policy = data.aws_iam_policy_document.respond_sfn.json
}

locals {
  lambda_retry = [{
    ErrorEquals     = ["Lambda.ServiceException", "Lambda.AWSLambdaException", "Lambda.SdkClientException", "Lambda.TooManyRequestsException"]
    IntervalSeconds = 2
    MaxAttempts     = 3
    BackoffRate     = 2
  }]

  catch_error = [{ ErrorEquals = ["States.ALL"], ResultPath = "$.error", Next = "MarcarError" }]

  respond_definition = {
    Comment = "Ankay: acción de respuesta con aprobación humana"
    StartAt = "Validar"
    States = {
      Validar = {
        Type           = "Task"
        Resource       = "arn:${local.partition}:states:::lambda:invoke"
        Parameters     = { FunctionName = module.lambda_respond.arn, Payload = { step = "validate", "request.$" = "$", "executionId.$" = "$$.Execution.Id" } }
        ResultSelector = { "validation.$" = "$.Payload" }
        ResultPath     = "$.validation"
        Retry          = local.lambda_retry
        Catch          = local.catch_error
        Next           = "SolicitarAprobacion"
      }
      SolicitarAprobacion = {
        Type           = "Task"
        Resource       = "arn:${local.partition}:states:::lambda:invoke.waitForTaskToken"
        TimeoutSeconds = 86400
        Parameters = {
          FunctionName = module.lambda_respond.arn
          Payload = {
            step             = "request_approval"
            "taskToken.$"    = "$$.Task.Token"
            "request.$"      = "$"
            "executionId.$"  = "$$.Execution.Id"
            approvalTopicArn = aws_sns_topic.approvals.arn
          }
        }
        ResultPath = "$.approval"
        Retry      = local.lambda_retry
        Catch = [
          { ErrorEquals = ["Rejected"], ResultPath = "$.error", Next = "MarcarRechazo" },
          { ErrorEquals = ["States.Timeout"], ResultPath = "$.error", Next = "MarcarTimeout" },
          { ErrorEquals = ["States.ALL"], ResultPath = "$.error", Next = "MarcarError" },
        ]
        Next = "DecisionAprobacion"
      }
      DecisionAprobacion = {
        Type    = "Choice"
        Choices = [{ Variable = "$.approval.decision", StringEquals = "approved", Next = "EjecutarAccion" }]
        Default = "MarcarRechazo"
      }
      EjecutarAccion = {
        Type           = "Task"
        Resource       = "arn:${local.partition}:states:::lambda:invoke"
        TimeoutSeconds = 300
        Parameters = {
          FunctionName = module.lambda_respond.arn
          Payload = {
            step               = "execute"
            "request.$"        = "$"
            "idempotencyKey.$" = "$$.Execution.Name"
          }
        }
        ResultSelector = { "result.$" = "$.Payload" }
        ResultPath     = "$.execution"
        Retry          = local.lambda_retry
        Catch          = local.catch_error
        Next           = "Auditar"
      }
      Auditar = {
        Type       = "Task"
        Resource   = "arn:${local.partition}:states:::lambda:invoke"
        Parameters = { FunctionName = module.lambda_respond.arn, Payload = { step = "audit", outcome = "executed", "request.$" = "$", "executionId.$" = "$$.Execution.Id" } }
        ResultPath = null
        Retry      = local.lambda_retry
        Catch      = local.catch_error
        Next       = "Notificar"
      }
      Notificar = {
        Type       = "Task"
        Resource   = "arn:${local.partition}:states:::sns:publish"
        Parameters = { TopicArn = aws_sns_topic.approvals.arn, Subject = "Ankay: acción ejecutada", "Message.$" = "States.JsonToString($)" }
        ResultPath = null
        Next       = "Completado"
      }
      Completado = { Type = "Succeed" }

      MarcarRechazo = { Type = "Pass", Result = "rejected", ResultPath = "$.outcome", Next = "AuditarCierre" }
      MarcarTimeout = { Type = "Pass", Result = "timeout", ResultPath = "$.outcome", Next = "AuditarCierre" }
      MarcarError   = { Type = "Pass", Result = "error", ResultPath = "$.outcome", Next = "AuditarCierre" }

      AuditarCierre = {
        Type       = "Task"
        Resource   = "arn:${local.partition}:states:::lambda:invoke"
        Parameters = { FunctionName = module.lambda_respond.arn, Payload = { step = "audit", "outcome.$" = "$.outcome", "request.$" = "$", "executionId.$" = "$$.Execution.Id" } }
        ResultPath = null
        Retry      = local.lambda_retry
        # Si la auditoría falla igual se notifica (y la ejecución termina en Fallido).
        Catch = [{ ErrorEquals = ["States.ALL"], ResultPath = "$.auditError", Next = "NotificarCierre" }]
        Next  = "NotificarCierre"
      }
      NotificarCierre = {
        Type       = "Task"
        Resource   = "arn:${local.partition}:states:::sns:publish"
        Parameters = { TopicArn = aws_sns_topic.alerts.arn, Subject = "Ankay: solicitud no ejecutada", "Message.$" = "States.JsonToString($)" }
        ResultPath = null
        Next       = "ResultadoCierre"
      }
      ResultadoCierre = {
        Type    = "Choice"
        Choices = [{ And = [{ Variable = "$.outcome", StringEquals = "rejected" }, { Variable = "$.auditError", IsPresent = false }], Next = "Rechazado" }]
        Default = "Fallido"
      }
      Rechazado = { Type = "Succeed" }
      Fallido   = { Type = "Fail", Error = "RespondNotExecuted", Cause = "Timeout, error o auditoría fallida; ver historial y auditoría" }
    }
  }
}

resource "aws_sfn_state_machine" "respond" {
  name       = "${local.name}-respond"
  type       = "STANDARD"
  role_arn   = aws_iam_role.respond_sfn.arn
  definition = jsonencode(local.respond_definition)

  logging_configuration {
    log_destination        = "${aws_cloudwatch_log_group.respond.arn}:*"
    include_execution_data = false
    level                  = "ERROR"
  }

  tracing_configuration {
    enabled = true
  }

  encryption_configuration {
    type                              = "CUSTOMER_MANAGED_KMS_KEY"
    kms_key_id                        = aws_kms_key.data.arn
    kms_data_key_reuse_period_seconds = 300
  }

  depends_on = [aws_iam_role_policy.respond_sfn]
}
