# Qapaqzito: asistente IA del SOC (la lógica vive en la app; aquí solo permisos, red y config).
#
# Red: este stack NO tiene NAT, así que la Lambda api (en VPC) no sale a Internet.
# - qapaqzito_provider = "bedrock" (recomendado): la app usa el cliente Mantle de Bedrock con IDs
#   "anthropic.<modelo>" y llega a Bedrock por los endpoints de interfaz listados en
#   qapaqzito_bedrock_endpoint_services (por defecto bedrock-runtime). Si el cliente Mantle usa un
#   endpoint distinto, añadir su servicio de endpoint de VPC a esa lista (no verificado aquí).
#   El acceso al modelo debe habilitarse en la consola de Bedrock de la cuenta/región.
# - qapaqzito_provider = "anthropic": API directa de Anthropic; SOLO funciona si el operador añade
#   salida a Internet (NAT o proxy) y declara qapaqzito_internet_egress_available = true. La API key
#   se carga a mano en el secreto contenedor .../qapaqzito/anthropic-api-key.

resource "aws_secretsmanager_secret" "qapaqzito_anthropic" {
  count = local.qapaqzito_anthropic ? 1 : 0

  name                    = "${local.ssm_prefix}/qapaqzito/anthropic-api-key"
  description             = "API key de Anthropic para Qapaqzito. Contenedor sin valor: la carga el dueño."
  kms_key_id              = aws_kms_key.data.arn
  recovery_window_in_days = local.is_prod ? 30 : 0
}

locals {
  qapaqzito_resource_arns = flatten([for id in local.qapaqzito_model_ids : [
    "arn:${local.partition}:bedrock:*::foundation-model/${id}*",
    "arn:${local.partition}:bedrock:*:${local.account_id}:inference-profile/*${id}*",
  ]])

  qapaqzito_statements = concat(
    local.qapaqzito_bedrock ? [{
      sid        = "QapaqzitoBedrockInvoke"
      effect     = "Allow"
      actions    = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"]
      resources  = local.qapaqzito_resource_arns
      conditions = []
    }] : [],
    local.qapaqzito_anthropic ? [{
      sid        = "QapaqzitoAnthropicKey"
      effect     = "Allow"
      actions    = ["secretsmanager:GetSecretValue"]
      resources  = [aws_secretsmanager_secret.qapaqzito_anthropic[0].arn]
      conditions = []
    }] : [],
  )

  qapaqzito_env = {
    QAPAQ_QAPAQZITO_ENABLED            = tostring(var.enable_qapaqzito)
    QAPAQ_QAPAQZITO_PROVIDER           = var.qapaqzito_provider
    QAPAQ_QAPAQZITO_MODEL              = var.enable_qapaqzito ? local.qapaqzito_model_id : ""
    QAPAQ_QAPAQZITO_API_KEY_SECRET_ARN = local.qapaqzito_anthropic ? aws_secretsmanager_secret.qapaqzito_anthropic[0].arn : ""
    QAPAQ_QAPAQZITO_REDACT_PII         = tostring(var.qapaqzito_redact_pii)
    QAPAQ_QAPAQZITO_EFFORT             = var.qapaqzito_effort
  }
}

# Aviso (no bloqueante) si la configuración no puede funcionar por red.
check "qapaqzito_network_path" {
  assert {
    condition     = !local.qapaqzito_anthropic || var.qapaqzito_internet_egress_available
    error_message = "qapaqzito_provider = \"anthropic\" requiere salida a Internet desde las subredes privadas y este stack no tiene NAT. Usa qapaqzito_provider = \"bedrock\" o añade NAT/proxy y declara qapaqzito_internet_egress_available = true."
  }

  assert {
    condition     = !local.qapaqzito_bedrock || var.enable_interface_endpoints
    error_message = "Qapaqzito con Bedrock necesita enable_interface_endpoints = true (endpoint de bedrock-runtime) porque las Lambdas no tienen salida a Internet."
  }
}

check "lambda_vpc_reachability" {
  assert {
    condition     = var.enable_interface_endpoints
    error_message = "Con enable_interface_endpoints = false las Lambdas en VPC no alcanzan Secrets Manager, SSM, Step Functions ni SQS (no hay NAT). Úsalo solo para entornos efímeros o añade salida propia."
  }
}
