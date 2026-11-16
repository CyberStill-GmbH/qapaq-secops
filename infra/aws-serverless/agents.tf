# Agentes Wazuh dinámicos: toda instancia que se levanta con el tag <project>-agent=enabled
# (o cualquiera, con agent_target_mode = "all") se instala sola.
#
#  (1) Documento SSM QAPAQ-InstallWazuhAgent (Linux apt/dnf/yum y Windows MSI), idempotente.
#  (2) Asociación SSM por tag, rate(1 hour), apply_only_at_cron_interval = false → las
#      instancias nuevas se instalan en cuanto se registran en SSM; salida a S3.
#  (3) Política gestionada de enrolamiento + rol/perfil base para instancias sin perfil.
#  (4) Lambda agent-onboarding: al pasar a running (y en un barrido diario) asocia el perfil
#      base, adjunta la política de enrolamiento al rol existente y, en modo "all", etiqueta.
#  (5) Nodos fuera de AWS: activación híbrida de SSM (opcional).
#
# Requisito: el SSM Agent debe estar instalado (viene en Amazon Linux, Ubuntu y Windows de AWS)
# y la instancia debe llegar a los endpoints de SSM (Internet/NAT propio o endpoints de VPC).

locals {
  agent_manager = var.agent_manager_address != "" ? var.agent_manager_address : aws_instance.wazuh.private_ip
}

# ---------------------------------------------------------------------------
# (1) Documento SSM
# ---------------------------------------------------------------------------
resource "aws_ssm_document" "install_agent" {
  name            = "${upper(var.project)}-InstallWazuhAgent-${var.environment}"
  document_type   = "Command"
  document_format = "JSON"

  content = jsonencode({
    schemaVersion = "2.2"
    description   = "Instala y registra el agente Wazuh ${var.wazuh_version} (idempotente)"
    parameters = {
      ManagerAddress        = { type = "String", default = local.agent_manager, description = "Dirección del manager Wazuh" }
      RegistrationSecretArn = { type = "String", default = aws_secretsmanager_secret.agent_registration.arn, description = "Secreto con la contraseña de registro" }
      Region                = { type = "String", default = local.region, description = "Región del secreto" }
      WazuhVersion          = { type = "String", default = var.wazuh_version, allowedPattern = "^[0-9]+\\.[0-9]+\\.[0-9]+$" }
      DefaultGroup          = { type = "String", default = var.agent_default_group, allowedPattern = "^[A-Za-z0-9_.,-]{1,255}$" }
      GroupTagKey           = { type = "String", default = local.agent_group_tag_key, allowedPattern = "^[A-Za-z0-9_.:/=+@-]{1,128}$" }
    }
    mainSteps = [
      {
        action       = "aws:runShellScript"
        name         = "InstallLinux"
        precondition = { StringEquals = ["platformType", "Linux"] }
        inputs       = { timeoutSeconds = "900", runCommand = split("\n", file("${path.module}/templates/agent-install-linux.sh")) }
      },
      {
        action       = "aws:runPowerShellScript"
        name         = "InstallWindows"
        precondition = { StringEquals = ["platformType", "Windows"] }
        inputs       = { timeoutSeconds = "900", runCommand = split("\n", file("${path.module}/templates/agent-install-windows.ps1")) }
      },
    ]
  })
}

# ---------------------------------------------------------------------------
# (2) Asociación por tag
# ---------------------------------------------------------------------------
resource "aws_ssm_association" "install_agent" {
  name                        = aws_ssm_document.install_agent.name
  association_name            = "${local.name}-wazuh-agent"
  schedule_expression         = "rate(1 hour)"
  apply_only_at_cron_interval = false
  compliance_severity         = "HIGH"
  max_concurrency             = "20%"
  max_errors                  = "100%"

  targets {
    key    = "tag:${local.agent_tag_key}"
    values = ["enabled"]
  }

  output_location {
    s3_bucket_name = module.bucket_logs.id
    s3_key_prefix  = "ssm/wazuh-agent"
    s3_region      = local.region
  }
}

# ---------------------------------------------------------------------------
# (3) Política de enrolamiento y perfil base
# ---------------------------------------------------------------------------
data "aws_iam_policy_document" "agent_enroll" {
  statement {
    sid       = "ReadRegistrationSecret"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.agent_registration.arn]
  }

  statement {
    sid       = "DecryptRegistrationSecret"
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.data.arn]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["secretsmanager.${local.region}.amazonaws.com"]
    }
  }

  # Salida de la asociación SSM al bucket de logs (SSE-KMS con la CMK de datos).
  statement {
    sid       = "WriteSsmOutput"
    actions   = ["s3:PutObject"]
    resources = ["${module.bucket_logs.arn}/ssm/wazuh-agent/*"]
  }

  statement {
    sid       = "EncryptSsmOutput"
    actions   = ["kms:GenerateDataKey"]
    resources = [aws_kms_key.data.arn]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["s3.${local.region}.amazonaws.com"]
    }
  }

  # Fallback para leer el tag de grupo cuando los tags no están expuestos en IMDS.
  statement {
    sid       = "DescribeTags"
    actions   = ["ec2:DescribeTags"]
    resources = ["*"]
  }
}

resource "aws_iam_policy" "agent_enroll" {
  name        = "${var.project}-agent-enroll-${var.environment}"
  description = "Permite a un endpoint leer solo la contraseña de registro de agentes Wazuh"
  policy      = data.aws_iam_policy_document.agent_enroll.json
}

resource "aws_iam_role" "agent_baseline" {
  name               = "${var.project}-agent-baseline-${var.environment}"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume.json
}

resource "aws_iam_role_policy_attachment" "agent_baseline_ssm" {
  role       = aws_iam_role.agent_baseline.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy_attachment" "agent_baseline_enroll" {
  role       = aws_iam_role.agent_baseline.name
  policy_arn = aws_iam_policy.agent_enroll.arn
}

resource "aws_iam_instance_profile" "agent_baseline" {
  name = "${var.project}-agent-baseline-${var.environment}"
  role = aws_iam_role.agent_baseline.name
}

# ---------------------------------------------------------------------------
# (4) Lambda agent-onboarding
# ---------------------------------------------------------------------------
module "lambda_agent_onboarding" {
  source = "./modules/lambda_function"

  function_name      = "${local.name}-agent-onboarding"
  description        = "Prepara perfiles/permisos/tags para el enrolamiento automático de agentes Wazuh"
  runtime            = "python3.13"
  handler            = "index.handler"
  memory_size        = local.lambda_memory.onboarding
  timeout            = local.lambda_timeout.onboarding
  kms_key_arn        = aws_kms_key.data.arn
  log_retention_days = var.log_retention_days
  managed_by_ci      = false
  inline_source      = { filename = "index.py", content = file("${path.module}/templates/agent_onboarding.py") }

  environment = {
    AGENT_TAG_KEY         = local.agent_tag_key
    TARGET_MODE           = var.agent_target_mode
    BASELINE_PROFILE_ARN  = aws_iam_instance_profile.agent_baseline.arn
    BASELINE_PROFILE_NAME = aws_iam_instance_profile.agent_baseline.name
    ENROLL_POLICY_ARN     = aws_iam_policy.agent_enroll.arn
    ALERT_TOPIC_ARN       = aws_sns_topic.alerts.arn
  }

  policy_statements = [
    {
      sid       = "DescribeInstances"
      actions   = ["ec2:DescribeInstances", "ec2:DescribeIamInstanceProfileAssociations"]
      resources = ["*"]
    },
    {
      sid       = "AssociateProfile"
      actions   = ["ec2:AssociateIamInstanceProfile"]
      resources = ["arn:${local.partition}:ec2:${local.region}:${local.account_id}:instance/*"]
    },
    {
      sid       = "PassBaselineRole"
      actions   = ["iam:PassRole"]
      resources = [aws_iam_role.agent_baseline.arn]
      conditions = [{
        test     = "StringEquals"
        variable = "iam:PassedToService"
        values   = ["ec2.amazonaws.com"]
      }]
    },
    {
      sid       = "TagAgent"
      actions   = ["ec2:CreateTags"]
      resources = ["arn:${local.partition}:ec2:${local.region}:${local.account_id}:instance/*"]
      conditions = [{
        test     = "ForAllValues:StringEquals"
        variable = "aws:TagKeys"
        values   = [local.agent_tag_key]
      }]
    },
    {
      sid       = "ReadRoles"
      actions   = ["iam:GetInstanceProfile", "iam:ListAttachedRolePolicies"]
      resources = ["*"]
    },
    {
      sid       = "AttachEnrollPolicyOnly"
      actions   = ["iam:AttachRolePolicy"]
      resources = ["arn:${local.partition}:iam::${local.account_id}:role/*"]
      conditions = [{
        test     = "ArnEquals"
        variable = "iam:PolicyARN"
        values   = [aws_iam_policy.agent_enroll.arn]
      }]
    },
    {
      sid       = "Notify"
      actions   = ["sns:Publish"]
      resources = [aws_sns_topic.alerts.arn]
    },
    {
      sid       = "NotifyKms"
      actions   = ["kms:GenerateDataKey"]
      resources = [aws_kms_key.data.arn]
    },
  ]
}

resource "aws_cloudwatch_event_rule" "instance_running" {
  name        = "${local.name}-agent-onboarding"
  description = "Instancias EC2 que pasan a running → onboarding de agente Wazuh"
  event_pattern = jsonencode({
    source        = ["aws.ec2"]
    "detail-type" = ["EC2 Instance State-change Notification"]
    detail        = { state = ["running"] }
  })
}

resource "aws_cloudwatch_event_target" "instance_running" {
  rule = aws_cloudwatch_event_rule.instance_running.name
  arn  = module.lambda_agent_onboarding.arn

  retry_policy {
    maximum_event_age_in_seconds = 3600
    maximum_retry_attempts       = 8
  }
}

resource "aws_lambda_permission" "onboarding_events" {
  statement_id  = "AllowEventBridgeInvoke"
  action        = "lambda:InvokeFunction"
  function_name = module.lambda_agent_onboarding.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.instance_running.arn
}

resource "aws_scheduler_schedule" "agent_sweep" {
  name                         = "${local.name}-agent-sweep"
  group_name                   = aws_scheduler_schedule_group.main.name
  schedule_expression          = "rate(1 day)"
  schedule_expression_timezone = "UTC"

  flexible_time_window {
    mode                      = "FLEXIBLE"
    maximum_window_in_minutes = 60
  }

  target {
    arn      = module.lambda_agent_onboarding.arn
    role_arn = aws_iam_role.scheduler.arn
    input    = jsonencode({ source = "qapaq.scheduler", task = "agent-sweep" })
  }
}

# ---------------------------------------------------------------------------
# (5) Endpoints fuera de AWS: activación híbrida de SSM
# ---------------------------------------------------------------------------
data "aws_iam_policy_document" "ssm_hybrid_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ssm.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }

    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:${local.partition}:ssm:${local.region}:${local.account_id}:*"]
    }
  }
}

resource "aws_iam_role" "agent_hybrid" {
  count = var.hybrid_activation_limit > 0 ? 1 : 0

  name               = "${var.project}-agent-hybrid-${var.environment}"
  assume_role_policy = data.aws_iam_policy_document.ssm_hybrid_assume.json
}

resource "aws_iam_role_policy_attachment" "agent_hybrid_ssm" {
  count = var.hybrid_activation_limit > 0 ? 1 : 0

  role       = aws_iam_role.agent_hybrid[0].name
  policy_arn = "arn:${local.partition}:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy_attachment" "agent_hybrid_enroll" {
  count = var.hybrid_activation_limit > 0 ? 1 : 0

  role       = aws_iam_role.agent_hybrid[0].name
  policy_arn = aws_iam_policy.agent_enroll.arn
}

# Expiración estable: time_offset se calcula una vez y queda en el estado (no cambia en cada
# plan). Las activaciones duran como máximo 30 días; para renovar:
#   terraform apply -replace=time_offset.hybrid_activation_expiry
resource "time_offset" "hybrid_activation_expiry" {
  count = var.hybrid_activation_limit > 0 ? 1 : 0

  offset_days = 29
}

resource "aws_ssm_activation" "agents" {
  count = var.hybrid_activation_limit > 0 ? 1 : 0

  name               = "${local.name}-wazuh-agents"
  description        = "Registro de endpoints fuera de AWS para el agente Wazuh"
  iam_role           = aws_iam_role.agent_hybrid[0].name
  registration_limit = var.hybrid_activation_limit
  expiration_date    = time_offset.hybrid_activation_expiry[0].rfc3339

  # Las etiquetas de la activación se aplican también a los nodos que se registran con ella
  # (comportamiento documentado por SSM; no verificado en este repositorio). Se usa el valor
  # "hybrid" para que los incluya la asociación híbrida, que apunta a la IP pública del manager.
  tags = {
    "${local.agent_tag_key}" = "hybrid"
  }

  lifecycle {
    replace_triggered_by = [time_offset.hybrid_activation_expiry[0]]
  }

  depends_on = [aws_iam_role_policy_attachment.agent_hybrid_ssm, aws_iam_role_policy_attachment.agent_hybrid_enroll]
}

# Asociación para nodos híbridos: mismo documento, pero el manager es la IP pública (EIP),
# porque esos nodos no alcanzan la IP privada. Su IP de salida debe estar en agent_cidrs.
resource "aws_ssm_association" "install_agent_hybrid" {
  count = var.hybrid_activation_limit > 0 ? 1 : 0

  name                        = aws_ssm_document.install_agent.name
  association_name            = "${local.name}-wazuh-agent-hybrid"
  schedule_expression         = "rate(1 hour)"
  apply_only_at_cron_interval = false
  compliance_severity         = "HIGH"
  max_concurrency             = "20%"
  max_errors                  = "100%"

  parameters = {
    ManagerAddress = var.agent_manager_address != "" ? var.agent_manager_address : aws_eip.wazuh.public_ip
  }

  targets {
    key    = "tag:${local.agent_tag_key}"
    values = ["hybrid"]
  }

  output_location {
    s3_bucket_name = module.bucket_logs.id
    s3_key_prefix  = "ssm/wazuh-agent"
    s3_region      = local.region
  }
}
