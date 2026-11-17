# Monitoreo de la propia cuenta AWS por el SOC QAPAQ, SIN IAM (SOC-PowerUser no puede crear roles
# ni hacer iam:PassRole, así que el módulo AWS de Wazuh — que necesita credenciales — no se usa).
#
#   CloudTrail (trail de organización, ya existente) → EventBridge (bus default, reglas regionales)
#     → SNS (política de recurso del tema: events.amazonaws.com + aws:SourceArn; sin rol)
#     → HTTPS https://<dominio>/hooks/aws-sns (ALB + WAF → edge nginx)
#     → receptor aws-events (verifica firma SNS v2, TopicArn, dedupe) → JSONL en logs del manager
#     → Wazuh reglas 101600-101699 (wazuh/aws-events).
#
# us-east-1 (región de trabajo; aquí llegan también IAM/Organizations/sign-in) tiene reglas por
# categoría. El resto de regiones habilitadas tienen un centinela (modules/aws-events-sentinel)
# que reenvía toda actividad de escritura: en una región sin uso, cualquier actividad es anómala.
#
# EventBridge solo entrega eventos de escritura (las lecturas exigen el estado
# ENABLED_WITH_ALL_CLOUDTRAIL_MANAGEMENT_EVENTS y no se piden aquí). Los eventos de servicios AWS
# en el bus default no tienen costo; SNS HTTPS cuesta 0,60 USD/millón; la CMK 1 USD/mes.

locals {
  aws_events_topic   = "${var.name}-aws-events"
  aws_events_webhook = "https://${var.domain_name}/hooks/aws-sns"
  aws_events_tags = {
    project     = "qapaq"
    environment = var.environment
    managed-by  = "terraform"
    stack       = "aws-poweruser"
  }
  # Reintentos HTTPS de SNS acotados a < 1 h en total (límite de SNS): cubren reinicios del nodo.
  aws_events_delivery_policy = jsonencode({
    healthyRetryPolicy = {
      minDelayTarget     = 20
      maxDelayTarget     = 600
      numRetries         = 12
      numNoDelayRetries  = 0
      numMinDelayRetries = 2
      numMaxDelayRetries = 3
      backoffFunction    = "exponential"
    }
    throttlePolicy = {
      maxReceivesPerSecond = 10
    }
  })

  # Patrones us-east-1. Todas las reglas apuntan al mismo tema.
  ct_api = ["AWS API Call via CloudTrail"]
  aws_events_patterns = {
    # Inicios de sesión de consola (éxito/fallo, MFA): IAM, root y federados.
    console-signin = {
      "detail-type" = ["AWS Console Sign In via CloudTrail", "AWS Console Signin via CloudTrail"]
    }
    # Cualquier llamada de escritura hecha por la cuenta root.
    root-activity = {
      "detail-type" = local.ct_api
      detail        = { userIdentity = { type = ["Root"] } }
    }
    # IAM, Identity Center, Organizations y Access Analyzer: toda escritura.
    identity = {
      "detail-type" = local.ct_api
      detail = {
        eventSource = [
          "iam.amazonaws.com", "sso.amazonaws.com", "sso-directory.amazonaws.com",
          "identitystore.amazonaws.com", "organizations.amazonaws.com", "access-analyzer.amazonaws.com",
        ]
      }
    }
    # Red (SG, NACL, rutas, gateways, flow logs) y EC2 sensible (lanzamientos, compartir snapshots/AMI).
    network-ec2 = {
      "detail-type" = local.ct_api
      detail = {
        eventSource = ["ec2.amazonaws.com"]
        eventName = [
          "AuthorizeSecurityGroupIngress", "AuthorizeSecurityGroupEgress", "RevokeSecurityGroupIngress",
          "RevokeSecurityGroupEgress", "CreateSecurityGroup", "DeleteSecurityGroup", "ModifySecurityGroupRules",
          "CreateNetworkAcl", "CreateNetworkAclEntry", "DeleteNetworkAcl", "DeleteNetworkAclEntry",
          "ReplaceNetworkAclEntry", "ReplaceNetworkAclAssociation",
          "CreateRoute", "DeleteRoute", "ReplaceRoute", "CreateRouteTable", "DeleteRouteTable",
          "AssociateRouteTable", "DisassociateRouteTable", "ReplaceRouteTableAssociation",
          "CreateInternetGateway", "AttachInternetGateway", "DetachInternetGateway", "DeleteInternetGateway",
          "CreateNatGateway", "DeleteNatGateway", "CreateVpcPeeringConnection", "AcceptVpcPeeringConnection",
          "CreateTransitGatewayVpcAttachment", "CreateVpnConnection", "CreateCustomerGateway",
          "CreateFlowLogs", "DeleteFlowLogs",
          "RunInstances", "ImportKeyPair", "CreateKeyPair", "ModifySnapshotAttribute", "ModifyImageAttribute",
        ]
      }
    }
    # S3: políticas, ACL, bloqueo de acceso público, cifrado, logging y replicación.
    s3-access = {
      "detail-type" = local.ct_api
      detail = {
        eventSource = ["s3.amazonaws.com"]
        eventName = [
          "PutBucketPolicy", "DeleteBucketPolicy", "PutBucketAcl", "PutBucketPublicAccessBlock",
          "DeleteBucketPublicAccessBlock", "PutAccountPublicAccessBlock", "DeleteAccountPublicAccessBlock",
          "PutBucketOwnershipControls", "DeleteBucketOwnershipControls", "PutBucketEncryption",
          "DeleteBucketEncryption", "PutBucketLogging", "PutBucketReplication", "DeleteBucketReplication",
          "PutBucketWebsite",
        ]
      }
    }
    # KMS: deshabilitar, borrar, cambiar política o rotación.
    kms = {
      "detail-type" = local.ct_api
      detail = {
        eventSource = ["kms.amazonaws.com"]
        eventName = [
          "DisableKey", "ScheduleKeyDeletion", "PutKeyPolicy", "DisableKeyRotation", "DeleteImportedKeyMaterial",
        ]
      }
    }
    # CloudTrail, GuardDuty, Security Hub y Config: toda escritura salvo la ingesta rutinaria de hallazgos.
    defense = {
      "detail-type" = local.ct_api
      detail = {
        eventSource = [
          "cloudtrail.amazonaws.com", "guardduty.amazonaws.com", "securityhub.amazonaws.com", "config.amazonaws.com",
        ]
        eventName = [{
          "anything-but" = [
            "BatchImportFindings", "BatchUpdateFindings", "BatchUpdateFindingsV2", "PutEvaluations",
            "PutAggregationAuthorization", "PutResourceConfig", "DeleteResourceConfig",
          ]
        }]
      }
    }
    # Antimanipulación del propio pipeline (EventBridge y SNS), sin publicaciones.
    pipeline = {
      "detail-type" = local.ct_api
      detail = {
        eventSource = ["events.amazonaws.com", "sns.amazonaws.com"]
        eventName   = [{ "anything-but" = ["Publish", "PublishBatch", "PutEvents"] }]
      }
    }
    # Hallazgos (se activan solos si se habilitan GuardDuty / Security Hub; hoy ambos apagados).
    guardduty-findings = {
      source        = ["aws.guardduty"]
      "detail-type" = ["GuardDuty Finding"]
    }
    securityhub-findings = {
      source        = ["aws.securityhub"]
      "detail-type" = ["Security Hub Findings - Imported"]
      detail = {
        findings = {
          Severity    = { Label = ["MEDIUM", "HIGH", "CRITICAL"] }
          RecordState = ["ACTIVE"]
          Workflow    = { Status = ["NEW", "NOTIFIED"] }
        }
      }
    }
  }
}

# --- CMK del tema (EventBridge no puede publicar en temas cifrados con alias/aws/sns) ----------
# Política según la guía de SNS: events.amazonaws.com con GenerateDataKey*/Decrypt. SNS no admite
# condiciones aws:SourceAccount/SourceArn en la clave para EventBridge → temas cifrados.

data "aws_iam_policy_document" "aws_events_kms" {
  statement {
    sid       = "AccountAdministration"
    actions   = ["kms:*"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"]
    }
  }
  statement {
    sid       = "EventBridgeToEncryptedTopic"
    actions   = ["kms:GenerateDataKey*", "kms:Decrypt"]
    resources = ["*"]
    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }
  }
}

resource "aws_kms_key" "aws_events" {
  description             = "${var.name} SNS aws-events (EventBridge -> SNS)"
  enable_key_rotation     = true
  deletion_window_in_days = 7
  policy                  = data.aws_iam_policy_document.aws_events_kms.json
}

resource "aws_kms_alias" "aws_events" {
  name          = "alias/${var.name}-aws-events"
  target_key_id = aws_kms_key.aws_events.key_id
}

# --- Tema principal us-east-1 -----------------------------------------------------------------

resource "aws_sns_topic" "aws_events" {
  name              = local.aws_events_topic
  kms_master_key_id = aws_kms_alias.aws_events.arn
  signature_version = 2
}

resource "aws_cloudwatch_event_rule" "aws_events" {
  for_each      = local.aws_events_patterns
  name          = "${var.name}-aws-${each.key}"
  description   = "QAPAQ SecOps: ${each.key} -> SNS ${local.aws_events_topic}"
  event_pattern = jsonencode(each.value)
}

resource "aws_cloudwatch_event_target" "aws_events" {
  for_each = local.aws_events_patterns
  rule     = aws_cloudwatch_event_rule.aws_events[each.key].name
  arn      = aws_sns_topic.aws_events.arn
}

data "aws_iam_policy_document" "aws_events_topic" {
  statement {
    sid       = "EventBridgePublish"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.aws_events.arn]
    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }
    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [for r in aws_cloudwatch_event_rule.aws_events : r.arn]
    }
  }
  statement {
    sid       = "OwnerManage"
    actions   = ["sns:GetTopicAttributes", "sns:SetTopicAttributes", "sns:Subscribe", "sns:ListSubscriptionsByTopic", "sns:DeleteTopic", "sns:TagResource", "sns:UntagResource"]
    resources = [aws_sns_topic.aws_events.arn]
    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"]
    }
  }
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["sns:Publish", "sns:Subscribe"]
    resources = [aws_sns_topic.aws_events.arn]
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

resource "aws_sns_topic_policy" "aws_events" {
  arn    = aws_sns_topic.aws_events.arn
  policy = data.aws_iam_policy_document.aws_events_topic.json
}

# El receptor confirma solo (GET SubscribeURL verificado); Terraform espera la confirmación.
resource "aws_sns_topic_subscription" "aws_events" {
  topic_arn                       = aws_sns_topic.aws_events.arn
  protocol                        = "https"
  endpoint                        = local.aws_events_webhook
  endpoint_auto_confirms          = true
  confirmation_timeout_in_minutes = 5
  delivery_policy                 = local.aws_events_delivery_policy
}

# --- Centinelas en las demás regiones habilitadas (sin uso de QAPAQ) ------------------------------

provider "aws" {
  alias  = "use2"
  region = "us-east-2"
  default_tags {
    tags = local.aws_events_tags
  }
}

module "aws_events_use2" {
  source          = "./modules/aws-events-sentinel"
  providers       = { aws = aws.use2 }
  topic_name      = local.aws_events_topic
  account_id      = data.aws_caller_identity.current.account_id
  webhook_url     = local.aws_events_webhook
  delivery_policy = local.aws_events_delivery_policy
}

provider "aws" {
  alias  = "usw1"
  region = "us-west-1"
  default_tags {
    tags = local.aws_events_tags
  }
}

module "aws_events_usw1" {
  source          = "./modules/aws-events-sentinel"
  providers       = { aws = aws.usw1 }
  topic_name      = local.aws_events_topic
  account_id      = data.aws_caller_identity.current.account_id
  webhook_url     = local.aws_events_webhook
  delivery_policy = local.aws_events_delivery_policy
}

provider "aws" {
  alias  = "usw2"
  region = "us-west-2"
  default_tags {
    tags = local.aws_events_tags
  }
}

module "aws_events_usw2" {
  source          = "./modules/aws-events-sentinel"
  providers       = { aws = aws.usw2 }
  topic_name      = local.aws_events_topic
  account_id      = data.aws_caller_identity.current.account_id
  webhook_url     = local.aws_events_webhook
  delivery_policy = local.aws_events_delivery_policy
}

provider "aws" {
  alias  = "cac1"
  region = "ca-central-1"
  default_tags {
    tags = local.aws_events_tags
  }
}

module "aws_events_cac1" {
  source          = "./modules/aws-events-sentinel"
  providers       = { aws = aws.cac1 }
  topic_name      = local.aws_events_topic
  account_id      = data.aws_caller_identity.current.account_id
  webhook_url     = local.aws_events_webhook
  delivery_policy = local.aws_events_delivery_policy
}

provider "aws" {
  alias  = "sae1"
  region = "sa-east-1"
  default_tags {
    tags = local.aws_events_tags
  }
}

module "aws_events_sae1" {
  source          = "./modules/aws-events-sentinel"
  providers       = { aws = aws.sae1 }
  topic_name      = local.aws_events_topic
  account_id      = data.aws_caller_identity.current.account_id
  webhook_url     = local.aws_events_webhook
  delivery_policy = local.aws_events_delivery_policy
}

provider "aws" {
  alias  = "euc1"
  region = "eu-central-1"
  default_tags {
    tags = local.aws_events_tags
  }
}

module "aws_events_euc1" {
  source          = "./modules/aws-events-sentinel"
  providers       = { aws = aws.euc1 }
  topic_name      = local.aws_events_topic
  account_id      = data.aws_caller_identity.current.account_id
  webhook_url     = local.aws_events_webhook
  delivery_policy = local.aws_events_delivery_policy
}

provider "aws" {
  alias  = "eun1"
  region = "eu-north-1"
  default_tags {
    tags = local.aws_events_tags
  }
}

module "aws_events_eun1" {
  source          = "./modules/aws-events-sentinel"
  providers       = { aws = aws.eun1 }
  topic_name      = local.aws_events_topic
  account_id      = data.aws_caller_identity.current.account_id
  webhook_url     = local.aws_events_webhook
  delivery_policy = local.aws_events_delivery_policy
}

provider "aws" {
  alias  = "euw1"
  region = "eu-west-1"
  default_tags {
    tags = local.aws_events_tags
  }
}

module "aws_events_euw1" {
  source          = "./modules/aws-events-sentinel"
  providers       = { aws = aws.euw1 }
  topic_name      = local.aws_events_topic
  account_id      = data.aws_caller_identity.current.account_id
  webhook_url     = local.aws_events_webhook
  delivery_policy = local.aws_events_delivery_policy
}

provider "aws" {
  alias  = "euw2"
  region = "eu-west-2"
  default_tags {
    tags = local.aws_events_tags
  }
}

module "aws_events_euw2" {
  source          = "./modules/aws-events-sentinel"
  providers       = { aws = aws.euw2 }
  topic_name      = local.aws_events_topic
  account_id      = data.aws_caller_identity.current.account_id
  webhook_url     = local.aws_events_webhook
  delivery_policy = local.aws_events_delivery_policy
}

provider "aws" {
  alias  = "euw3"
  region = "eu-west-3"
  default_tags {
    tags = local.aws_events_tags
  }
}

module "aws_events_euw3" {
  source          = "./modules/aws-events-sentinel"
  providers       = { aws = aws.euw3 }
  topic_name      = local.aws_events_topic
  account_id      = data.aws_caller_identity.current.account_id
  webhook_url     = local.aws_events_webhook
  delivery_policy = local.aws_events_delivery_policy
}

provider "aws" {
  alias  = "apne1"
  region = "ap-northeast-1"
  default_tags {
    tags = local.aws_events_tags
  }
}

module "aws_events_apne1" {
  source          = "./modules/aws-events-sentinel"
  providers       = { aws = aws.apne1 }
  topic_name      = local.aws_events_topic
  account_id      = data.aws_caller_identity.current.account_id
  webhook_url     = local.aws_events_webhook
  delivery_policy = local.aws_events_delivery_policy
}

provider "aws" {
  alias  = "apne2"
  region = "ap-northeast-2"
  default_tags {
    tags = local.aws_events_tags
  }
}

module "aws_events_apne2" {
  source          = "./modules/aws-events-sentinel"
  providers       = { aws = aws.apne2 }
  topic_name      = local.aws_events_topic
  account_id      = data.aws_caller_identity.current.account_id
  webhook_url     = local.aws_events_webhook
  delivery_policy = local.aws_events_delivery_policy
}

provider "aws" {
  alias  = "apne3"
  region = "ap-northeast-3"
  default_tags {
    tags = local.aws_events_tags
  }
}

module "aws_events_apne3" {
  source          = "./modules/aws-events-sentinel"
  providers       = { aws = aws.apne3 }
  topic_name      = local.aws_events_topic
  account_id      = data.aws_caller_identity.current.account_id
  webhook_url     = local.aws_events_webhook
  delivery_policy = local.aws_events_delivery_policy
}

provider "aws" {
  alias  = "aps1"
  region = "ap-south-1"
  default_tags {
    tags = local.aws_events_tags
  }
}

module "aws_events_aps1" {
  source          = "./modules/aws-events-sentinel"
  providers       = { aws = aws.aps1 }
  topic_name      = local.aws_events_topic
  account_id      = data.aws_caller_identity.current.account_id
  webhook_url     = local.aws_events_webhook
  delivery_policy = local.aws_events_delivery_policy
}

provider "aws" {
  alias  = "apse1"
  region = "ap-southeast-1"
  default_tags {
    tags = local.aws_events_tags
  }
}

module "aws_events_apse1" {
  source          = "./modules/aws-events-sentinel"
  providers       = { aws = aws.apse1 }
  topic_name      = local.aws_events_topic
  account_id      = data.aws_caller_identity.current.account_id
  webhook_url     = local.aws_events_webhook
  delivery_policy = local.aws_events_delivery_policy
}

provider "aws" {
  alias  = "apse2"
  region = "ap-southeast-2"
  default_tags {
    tags = local.aws_events_tags
  }
}

module "aws_events_apse2" {
  source          = "./modules/aws-events-sentinel"
  providers       = { aws = aws.apse2 }
  topic_name      = local.aws_events_topic
  account_id      = data.aws_caller_identity.current.account_id
  webhook_url     = local.aws_events_webhook
  delivery_policy = local.aws_events_delivery_policy
}

locals {
  aws_events_topic_arns = concat([aws_sns_topic.aws_events.arn], [
    module.aws_events_use2.topic_arn,
    module.aws_events_usw1.topic_arn,
    module.aws_events_usw2.topic_arn,
    module.aws_events_cac1.topic_arn,
    module.aws_events_sae1.topic_arn,
    module.aws_events_euc1.topic_arn,
    module.aws_events_eun1.topic_arn,
    module.aws_events_euw1.topic_arn,
    module.aws_events_euw2.topic_arn,
    module.aws_events_euw3.topic_arn,
    module.aws_events_apne1.topic_arn,
    module.aws_events_apne2.topic_arn,
    module.aws_events_apne3.topic_arn,
    module.aws_events_aps1.topic_arn,
    module.aws_events_apse1.topic_arn,
    module.aws_events_apse2.topic_arn,
  ])
}

output "aws_events_topic_arns" {
  value = local.aws_events_topic_arns
}

# Contenido de infra/aws-poweruser/host/aws-events.env (lista de temas que acepta el receptor).
output "aws_events_receiver_env" {
  value = "QAPAQ_AWS_SNS_TOPIC_ARNS=${join(",", local.aws_events_topic_arns)}"
}
