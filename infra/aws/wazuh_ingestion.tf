# Sprint 5 · fase 0 — ingesta Wazuh → SOC (S5-D1..D3).
#
# El API lee el Indexer de Wazuh a través de KrakenD (C-28) con un token de workload de Entra.
# El Indexer del all-in-one escucha solo en 127.0.0.1, así que un proxy nginx en la instancia lo
# publica en la IP privada con TLS propio (workflow `configure-wazuh-indexer-reader`).
#
# Orden (docs/deployment/wazuh-ingestion-rollout.md):
#   1. apply con `wazuh_ingestion_enabled = false`: crea los secretos vacíos y el permiso de la
#      instancia para poblarlos.
#   2. workflow `configure-wazuh-indexer-reader`: crea `qapaq_reader` (solo lectura), el proxy y
#      publica la credencial y el certificado del proxy en estos secretos.
#   3. `wazuh_indexer_private_ip` y `wazuh_ingestion_gateway_scope` en las variables del
#      ambiente, `wazuh_ingestion_enabled = true` y apply.
#
# La IP privada sale de la instancia (`module.wazuh_public.private_ip`); la variable solo la
# reemplaza si hiciera falta apuntar a otro Indexer. El scope del token es la propia app del API
# (`<client-id>/.default`) salvo que se declare otro.

variable "wazuh_ingestion_enabled" {
  description = "Activa la ingesta Wazuh → SOC en el API. Solo después del workflow configure-wazuh-indexer-reader."
  type        = bool
  default     = false
}

variable "wazuh_indexer_private_ip" {
  description = "Override opcional de la IP privada del Indexer; vacío = la de la instancia Wazuh del módulo."
  type        = string
  default     = ""

  validation {
    condition     = var.wazuh_indexer_private_ip == "" || can(cidrhost("${var.wazuh_indexer_private_ip}/32", 0))
    error_message = "wazuh_indexer_private_ip debe ser una IPv4 válida."
  }
}

variable "wazuh_ingestion_gateway_scope" {
  description = "Override opcional del scope de client credentials; vacío = <client-id del API>/.default."
  type        = string
  default     = ""

  validation {
    condition     = var.wazuh_ingestion_gateway_scope == "" || can(regex("^[A-Za-z0-9:/._-]{3,256}/\\.default$", var.wazuh_ingestion_gateway_scope))
    error_message = "wazuh_ingestion_gateway_scope debe terminar en /.default."
  }
}

# Credencial Basic del usuario `qapaq_reader` del Indexer: JSON con `basic_auth_b64`. Solo la
# lee KrakenD; el API nunca ve credenciales del Indexer (S5-D3).
resource "aws_secretsmanager_secret" "wazuh_indexer_reader" {
  name                    = "${var.project}/${var.environment}/wazuh/indexer-reader"
  description             = "Read-only Wazuh Indexer credential (qapaq_reader) for the KrakenD gateway."
  recovery_window_in_days = 7

  tags = {
    Project     = var.project
    Environment = var.environment
    Purpose     = "wazuh-ingestion"
  }
}

# Certificado (PEM) del proxy TLS del Indexer en la IP privada; KrakenD lo usa como CA.
resource "aws_secretsmanager_secret" "wazuh_indexer_proxy_ca" {
  name                    = "${var.project}/${var.environment}/wazuh/indexer-proxy-ca"
  description             = "Self-signed certificate of the Wazuh Indexer private TLS proxy, trusted by KrakenD."
  recovery_window_in_days = 7

  tags = {
    Project     = var.project
    Environment = var.environment
    Purpose     = "wazuh-ingestion"
  }
}

# Credenciales de los usuarios locales del Dashboard de Wazuh (JSON {username, password}):
# dueño del grupo de admisión (administrador) y analista (solo lectura). Las genera la instancia;
# solo las leen las personas autorizadas desde la consola de AWS.
resource "aws_secretsmanager_secret" "wazuh_dashboard_admin" {
  name                    = "${var.project}/${var.environment}/wazuh/dashboard-admin-user"
  description             = "Wazuh Dashboard local user of the admission group owner (all_access)."
  recovery_window_in_days = 7

  tags = {
    Project     = var.project
    Environment = var.environment
    Purpose     = "wazuh-access"
  }
}

resource "aws_secretsmanager_secret" "wazuh_dashboard_analyst" {
  name                    = "${var.project}/${var.environment}/wazuh/dashboard-analyst-user"
  description             = "Wazuh Dashboard local read-only user of the SOC analyst."
  recovery_window_in_days = 7

  tags = {
    Project     = var.project
    Environment = var.environment
    Purpose     = "wazuh-access"
  }
}

# La instancia Wazuh publica las credenciales y el certificado que genera el workflow, y los lee
# para no rotarlos en cada ejecución. Solo estos cuatro secretos; no los de la aplicación.
resource "aws_iam_role_policy" "wazuh_publish_ingestion_secrets" {
  name = "publish-wazuh-ingestion-secrets"
  role = module.wazuh_public.instance_role_name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = ["secretsmanager:PutSecretValue", "secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
      Resource = [
        aws_secretsmanager_secret.wazuh_indexer_reader.arn,
        aws_secretsmanager_secret.wazuh_indexer_proxy_ca.arn,
        aws_secretsmanager_secret.wazuh_dashboard_admin.arn,
        aws_secretsmanager_secret.wazuh_dashboard_analyst.arn,
      ]
    }]
  })
}

locals {
  wazuh_ingestion = var.wazuh_ingestion_enabled ? {
    indexer_url         = "https://${coalesce(var.wazuh_indexer_private_ip, module.wazuh_public.private_ip)}:9200"
    index_pattern       = "wazuh-alerts-4.x-*"
    reader_secret_arn   = aws_secretsmanager_secret.wazuh_indexer_reader.arn
    proxy_ca_secret_arn = aws_secretsmanager_secret.wazuh_indexer_proxy_ca.arn
    gateway_scope       = coalesce(var.wazuh_ingestion_gateway_scope, "${local.entra_client_id}/.default")
    # Referencia a la inicialización de Wazuh: KrakenD se actualiza después de que la credencial
    # del lector y la CA existen, y se redespliega si la inicialización cambia.
    access_revision = var.wazuh_bootstrap_enabled ? aws_ssm_association.wazuh_bootstrap[0].association_id : "manual"
  } : null
}

check "wazuh_ingestion_inputs" {
  assert {
    condition     = !var.wazuh_ingestion_enabled || var.wazuh_bootstrap_enabled
    error_message = "La ingesta necesita la inicialización de Wazuh (wazuh_bootstrap_enabled) o haber ejecutado Initialize Wazuh antes."
  }
}

output "wazuh_indexer_private_ip" {
  description = "IP privada de la instancia Wazuh, para wazuh_indexer_private_ip."
  value       = module.wazuh_public.private_ip
}

output "wazuh_ingestion_secrets" {
  description = "Secretos que el workflow configure-wazuh-indexer-reader puebla (ARN, sin valores)."
  value = {
    reader_secret_id          = aws_secretsmanager_secret.wazuh_indexer_reader.name
    proxy_ca_secret_id        = aws_secretsmanager_secret.wazuh_indexer_proxy_ca.name
    dashboard_admin_secret_id = aws_secretsmanager_secret.wazuh_dashboard_admin.name
    dashboard_analyst_user_id = aws_secretsmanager_secret.wazuh_dashboard_analyst.name
  }
}
