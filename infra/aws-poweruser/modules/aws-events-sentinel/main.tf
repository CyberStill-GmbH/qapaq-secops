# Centinela regional (regiones SIN uso de QAPAQ): cualquier llamada de escritura a la API o inicio de
# sesión de consola registrado por CloudTrail en esta región → SNS regional → webhook QAPAQ.
# Las reglas de EventBridge son regionales y reenviar a un bus central exige un rol IAM (no
# disponible con SOC-PowerUser), por eso cada región tiene su propio tema.
# Sin SSE: EventBridge no puede publicar en temas cifrados con la clave administrada alias/aws/sns
# y una CMK por región costaría 1 USD/mes cada una; el tráfico va por TLS y el tema no persiste mensajes.

terraform {
  required_providers {
    aws = {
      source = "hashicorp/aws"
    }
  }
}

data "aws_region" "this" {}

resource "aws_sns_topic" "this" {
  name              = var.topic_name
  signature_version = 2
}

resource "aws_cloudwatch_event_rule" "activity" {
  name        = "${var.topic_name}-region-activity"
  description = "QAPAQ SecOps: actividad (API de escritura o login de consola) en region no habitual"
  event_pattern = jsonencode({
    "detail-type" = [
      "AWS API Call via CloudTrail",
      "AWS Console Sign In via CloudTrail",
      "AWS Console Signin via CloudTrail",
    ]
  })
}

resource "aws_cloudwatch_event_target" "activity" {
  rule = aws_cloudwatch_event_rule.activity.name
  arn  = aws_sns_topic.this.arn
}

data "aws_iam_policy_document" "topic" {
  statement {
    sid       = "EventBridgePublish"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.this.arn]
    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }
    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [aws_cloudwatch_event_rule.activity.arn]
    }
  }
  statement {
    sid       = "OwnerManage"
    actions   = ["sns:GetTopicAttributes", "sns:SetTopicAttributes", "sns:Subscribe", "sns:ListSubscriptionsByTopic", "sns:DeleteTopic", "sns:TagResource", "sns:UntagResource"]
    resources = [aws_sns_topic.this.arn]
    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${var.account_id}:root"]
    }
  }
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["sns:Publish", "sns:Subscribe"]
    resources = [aws_sns_topic.this.arn]
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

resource "aws_sns_topic_policy" "this" {
  arn    = aws_sns_topic.this.arn
  policy = data.aws_iam_policy_document.topic.json
}

resource "aws_sns_topic_subscription" "webhook" {
  topic_arn                       = aws_sns_topic.this.arn
  protocol                        = "https"
  endpoint                        = var.webhook_url
  endpoint_auto_confirms          = true
  confirmation_timeout_in_minutes = 5
  delivery_policy                 = var.delivery_policy
}
