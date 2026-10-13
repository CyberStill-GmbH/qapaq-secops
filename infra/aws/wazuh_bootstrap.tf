# Sprint 5 — inicialización de Wazuh desde Terraform, sin pasos manuales.
#
# Un documento SSM lleva los scripts versionados del repositorio (comprimidos con `base64gzip`,
# para caber en el límite de 64 KB de SSM) y una asociación lo ejecuta en la instancia Wazuh.
# `terraform apply` espera a que termine bien (`wait_for_success_timeout_seconds`); si falla, el
# apply falla y KrakenD no se actualiza con una credencial que no existe.
#
# Qué deja hecho, de forma idempotente (reejecutar no rota contraseñas):
#   1. infra/wazuh/access/apply-access.sh: usuario `qapaq_reader` de solo lectura, proxy TLS
#      del Indexer en la IP privada, usuario admin del Dashboard y usuario analista de solo
#      lectura. Publica credenciales y certificado en Secrets Manager.
#   2. infra/wazuh/office365/apply-office365.sh: módulo office365 y reglas QAPAQ, con el client
#      secret de la misma app de Entra del API (decisión del dueño del producto: una sola app).
#
# Cualquier cambio en un script crea una versión nueva del documento y la asociación vuelve a
# ejecutarse en el siguiente apply. No toca `user_data`: la instancia no se reemplaza.

variable "wazuh_bootstrap_enabled" {
  description = "Ejecuta la inicialización de Wazuh (acceso + Office 365) por SSM en cada apply que cambie los scripts."
  type        = bool
  default     = false
}

variable "wazuh_admin_username" {
  description = "Usuario local del Dashboard de Wazuh con administración (dueño del grupo). Su contraseña queda en Secrets Manager."
  type        = string
  default     = "qapaq-admin"

  validation {
    condition     = can(regex("^[A-Za-z0-9._@-]{3,64}$", var.wazuh_admin_username))
    error_message = "wazuh_admin_username: 3–64 caracteres [A-Za-z0-9._@-]."
  }
}

variable "wazuh_analyst_username" {
  description = "Usuario local del Dashboard de Wazuh de solo lectura (persona analista)."
  type        = string
  default     = ""

  validation {
    condition     = var.wazuh_analyst_username == "" || can(regex("^[A-Za-z0-9._@-]{3,64}$", var.wazuh_analyst_username))
    error_message = "wazuh_analyst_username: 3–64 caracteres [A-Za-z0-9._@-]."
  }
}

variable "wazuh_office365_enabled" {
  description = "Configura la recolección de Office 365 en Wazuh con la app de Entra del API."
  type        = bool
  default     = true
}

locals {
  wazuh_scripts_root = "${path.module}/../wazuh"
  # Archivos que viajan a la instancia; las pruebas y la documentación no.
  wazuh_bootstrap_files = sort([
    for file in setunion(
      fileset(local.wazuh_scripts_root, "access/*.sh"),
      fileset(local.wazuh_scripts_root, "office365/*.sh"),
      fileset(local.wazuh_scripts_root, "office365/*.tmpl"),
      fileset(local.wazuh_scripts_root, "office365/rules/*.xml"),
    ) : file
  ])
  entra_tenant_id = var.runtime_api_environment["QAPAQ_ENTRA_TENANT_ID"]
  entra_client_id = var.runtime_api_environment["QAPAQ_ENTRA_CLIENT_ID"]
  secret_prefix   = "${var.project}/${var.environment}"

  wazuh_bootstrap_commands = concat(
    [
      "set -euo pipefail",
      "work=$(mktemp -d)",
      "trap 'rm -rf \"$work\"' EXIT",
    ],
    flatten([
      for file in local.wazuh_bootstrap_files : [
        "mkdir -p \"$work/${dirname(file)}\"",
        "printf '%s' '${base64gzip(file("${local.wazuh_scripts_root}/${file}"))}' | base64 -d | gunzip > \"$work/${file}\"",
      ]
    ]),
    [
      join(" ", [
        "QAPAQ_AWS_REGION=${var.aws_region}",
        "QAPAQ_ADMIN_USERNAME='${var.wazuh_admin_username}'",
        "QAPAQ_ANALYST_USERNAME='${var.wazuh_analyst_username}'",
        "QAPAQ_READER_SECRET_ID=${aws_secretsmanager_secret.wazuh_indexer_reader.name}",
        "QAPAQ_PROXY_CA_SECRET_ID=${aws_secretsmanager_secret.wazuh_indexer_proxy_ca.name}",
        "QAPAQ_ADMIN_USER_SECRET_ID=${aws_secretsmanager_secret.wazuh_dashboard_admin.name}",
        "QAPAQ_ANALYST_USER_SECRET_ID=${aws_secretsmanager_secret.wazuh_dashboard_analyst.name}",
        "bash \"$work/access/apply-access.sh\"",
      ]),
    ],
    var.wazuh_office365_enabled ? [
      join(" ", [
        "QAPAQ_APPLY_MODE=apply",
        "QAPAQ_O365_TENANT_ID=${local.entra_tenant_id}",
        "QAPAQ_O365_CLIENT_ID=${local.entra_client_id}",
        "QAPAQ_O365_API_TYPE=commercial",
        "QAPAQ_O365_ENABLE_DLP=false",
        "QAPAQ_AWS_REGION=${var.aws_region}",
        "QAPAQ_O365_SECRET_SOURCE=aws-secretsmanager:${local.secret_prefix}/entra/client-secret",
        "bash \"$work/office365/apply-office365.sh\"",
      ]),
    ] : [],
  )
}

check "wazuh_bootstrap_inputs" {
  assert {
    condition     = !var.wazuh_bootstrap_enabled || var.wazuh_analyst_username != ""
    error_message = "La inicialización de Wazuh exige wazuh_analyst_username."
  }
}

resource "aws_ssm_document" "wazuh_bootstrap" {
  count           = var.wazuh_bootstrap_enabled ? 1 : 0
  name            = "${var.project}-${var.environment}-wazuh-bootstrap"
  document_type   = "Command"
  document_format = "JSON"

  content = jsonencode({
    schemaVersion = "2.2"
    description   = "QAPAQ: acceso a Wazuh (lector, proxy, usuarios) y recolección de Office 365."
    mainSteps = [{
      action = "aws:runShellScript"
      name   = "initialize"
      inputs = {
        timeoutSeconds = "1200"
        runCommand     = local.wazuh_bootstrap_commands
      }
    }]
  })

  tags = { Project = var.project, Environment = var.environment, Purpose = "wazuh-bootstrap" }
}

resource "aws_ssm_association" "wazuh_bootstrap" {
  count            = var.wazuh_bootstrap_enabled ? 1 : 0
  name             = aws_ssm_document.wazuh_bootstrap[0].name
  document_version = aws_ssm_document.wazuh_bootstrap[0].latest_version
  association_name = "${var.project}-${var.environment}-wazuh-bootstrap"

  targets {
    key    = "InstanceIds"
    values = [module.wazuh_public.instance_id]
  }

  # El apply espera el resultado: sin inicialización correcta no se sigue.
  wait_for_success_timeout_seconds = 1500

  # Los permisos para leer el secreto de Entra y publicar los generados deben existir antes.
  depends_on = [
    aws_iam_role_policy.wazuh_publish_ingestion_secrets,
    aws_iam_role_policy.wazuh_read_entra_secret,
  ]
}

# La instancia lee el client secret de la app del API para el módulo office365 (misma app).
resource "aws_iam_role_policy" "wazuh_read_entra_secret" {
  count = var.wazuh_bootstrap_enabled && var.wazuh_office365_enabled ? 1 : 0
  name  = "read-entra-client-secret-for-office365"
  role  = module.wazuh_public.instance_role_name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = [module.application_foundations.metadata_secret_arns["entra_client_secret"]]
    }]
  })
}

output "wazuh_bootstrap" {
  description = "Asociación SSM de la inicialización de Wazuh (null si está deshabilitada)."
  value = var.wazuh_bootstrap_enabled ? {
    document    = aws_ssm_document.wazuh_bootstrap[0].name
    association = aws_ssm_association.wazuh_bootstrap[0].association_id
  } : null
}
