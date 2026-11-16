# Cognito: MFA TOTP obligatorio, alta solo por administrador, federación opcional con Entra.
#
# Para evitar ciclos (CloudFront → API → Lambda → Cognito/CloudFront), la configuración no
# secreta que necesita la app se publica en SSM Parameter Store bajo /<project>/<env>/ y la
# Lambda solo recibe esa ruta base (QAPAQ_CONFIG_SSM_PATH). Los secretos van por ARN.

locals {
  entra_enabled  = var.entra_tenant_id != "" && var.entra_client_id != ""
  cognito_domain = var.cognito_domain_prefix != "" ? var.cognito_domain_prefix : "${local.name}-${local.suffix}"
  cognito_groups = {
    "qapaq.soc.analyst"    = { precedence = 30, description = "Analista SOC" }
    "qapaq.soc.lead"       = { precedence = 20, description = "Líder SOC (aprueba acciones de respuesta)" }
    "qapaq.auditor"        = { precedence = 40, description = "Auditor de solo lectura" }
    "qapaq.platform.admin" = { precedence = 10, description = "Administrador de plataforma" }
  }
  app_base_url  = var.domain_name != "" ? "https://${var.domain_name}" : "https://${aws_cloudfront_distribution.main.domain_name}"
  callback_urls = concat(["${local.app_base_url}/api/auth/callback"], var.cognito_callback_urls)
}

resource "aws_cognito_user_pool" "main" {
  name                = "${local.name}-users"
  deletion_protection = local.deletion_protection ? "ACTIVE" : "INACTIVE"
  mfa_configuration   = "ON"
  username_attributes = ["email"]

  auto_verified_attributes = ["email"]

  software_token_mfa_configuration {
    enabled = true
  }

  password_policy {
    minimum_length                   = 14
    require_lowercase                = true
    require_uppercase                = true
    require_numbers                  = true
    require_symbols                  = true
    temporary_password_validity_days = 3
    password_history_size            = 5
  }

  admin_create_user_config {
    allow_admin_create_user_only = true
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }

  username_configuration {
    case_sensitive = false
  }
}

resource "aws_cognito_user_group" "groups" {
  for_each = local.cognito_groups

  user_pool_id = aws_cognito_user_pool.main.id
  name         = each.key
  description  = each.value.description
  precedence   = each.value.precedence
}

resource "aws_cognito_user_pool_domain" "main" {
  domain       = local.cognito_domain
  user_pool_id = aws_cognito_user_pool.main.id
}

resource "aws_cognito_identity_provider" "entra" {
  count = local.entra_enabled ? 1 : 0

  user_pool_id  = aws_cognito_user_pool.main.id
  provider_name = "Entra"
  provider_type = "OIDC"

  provider_details = {
    client_id                 = var.entra_client_id
    client_secret             = var.entra_client_secret
    attributes_request_method = "GET"
    oidc_issuer               = "https://login.microsoftonline.com/${var.entra_tenant_id}/v2.0"
    authorize_scopes          = "openid email profile"
  }

  attribute_mapping = {
    email    = "email"
    username = "sub"
  }

  lifecycle {
    precondition {
      condition     = var.entra_client_secret != ""
      error_message = "entra_client_secret (TF_VAR_entra_client_secret) es obligatorio si se configura la federación con Entra."
    }
  }
}

# Cliente confidencial del BFF (la Lambda api). Tokens cortos; refresh de 12 h.
resource "aws_cognito_user_pool_client" "bff" {
  name            = "${local.name}-bff"
  user_pool_id    = aws_cognito_user_pool.main.id
  generate_secret = true

  explicit_auth_flows           = ["ALLOW_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"]
  prevent_user_existence_errors = "ENABLED"
  enable_token_revocation       = true

  access_token_validity  = 15
  id_token_validity      = 15
  refresh_token_validity = 12

  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "hours"
  }

  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "profile"]
  callback_urls                        = local.callback_urls
  logout_urls                          = ["${local.app_base_url}/"]
  supported_identity_providers         = concat(["COGNITO"], local.entra_enabled ? ["Entra"] : [])

  depends_on = [aws_cognito_identity_provider.entra]
}

# El secreto del cliente ya vive en el estado (atributo del recurso); se copia a Secrets
# Manager para que la app lo lea por ARN y no por variable de entorno.
resource "aws_secretsmanager_secret" "cognito_client" {
  name                    = "${local.ssm_prefix}/cognito/bff-client"
  description             = "Credenciales del cliente Cognito del BFF"
  kms_key_id              = aws_kms_key.data.arn
  recovery_window_in_days = local.is_prod ? 30 : 0
}

resource "aws_secretsmanager_secret_version" "cognito_client" {
  secret_id = aws_secretsmanager_secret.cognito_client.id
  secret_string = jsonencode({
    client_id     = aws_cognito_user_pool_client.bff.id
    client_secret = aws_cognito_user_pool_client.bff.client_secret
  })
}

# ---------------------------------------------------------------------------
# Configuración no secreta para la app (SSM Parameter Store)
# ---------------------------------------------------------------------------
locals {
  app_config = {
    "cognito/user-pool-id"         = aws_cognito_user_pool.main.id
    "cognito/client-id"            = aws_cognito_user_pool_client.bff.id
    "cognito/client-secret-arn"    = aws_secretsmanager_secret.cognito_client.arn
    "cognito/issuer"               = "https://cognito-idp.${local.region}.amazonaws.com/${aws_cognito_user_pool.main.id}"
    "cognito/domain"               = "${aws_cognito_user_pool_domain.main.domain}.auth.${local.region}.amazoncognito.com"
    "app/base-url"                 = local.app_base_url
    "app/origin-verify-header"     = local.origin_verify_header
    "app/origin-verify-secret-arn" = aws_secretsmanager_secret.origin_verify.arn
    "db/endpoint"                  = aws_rds_cluster.main.endpoint
    "db/reader-endpoint"           = aws_rds_cluster.main.reader_endpoint
    "db/name"                      = aws_rds_cluster.main.database_name
    "db/master-secret-arn"         = aws_rds_cluster.main.master_user_secret[0].secret_arn
    "db/iam-user"                  = "qapaq_app"
    "audit/bucket"                 = module.bucket_audit.id
    "audit/kms-key-arn"            = aws_kms_key.audit.arn
    "events/bus-name"              = aws_cloudwatch_event_bus.security.name
    "events/ingest-queue-url"      = aws_sqs_queue.ingest.url
    "respond/state-machine-arn"    = aws_sfn_state_machine.respond.arn
    "respond/approvals-topic-arn"  = aws_sns_topic.approvals.arn
    "wazuh/indexer-url"            = "https://${aws_instance.wazuh.private_ip}:9200"
    "wazuh/api-url"                = "https://${aws_instance.wazuh.private_ip}:55000"
    "wazuh/admin-secret-arn"       = aws_secretsmanager_secret.wazuh_admin.arn
    "alerts/topic-arn"             = aws_sns_topic.alerts.arn
  }
}

resource "aws_ssm_parameter" "app_config" {
  for_each = local.app_config

  name  = "${local.ssm_prefix}/${each.key}"
  type  = "String"
  value = each.value
  tier  = "Standard"
}
