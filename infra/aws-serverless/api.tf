# Lambdas Node (api, worker, respond) + API Gateway HTTP API.
#
# Código: por defecto un handler placeholder inline (la API responde 503 JSON, el worker
# devuelve todos los mensajes como fallidos para no perderlos, respond falla para que
# Step Functions audite). El CI sube el código real con UpdateFunctionCode; Terraform ignora
# esos cambios (managed_by_ci = true en el módulo).
#
# Cabecera secreta de origen: CloudFront inyecta X-Qapaq-Origin-Verify con un valor aleatorio
# guardado en Secrets Manager. El execute-api queda habilitado (es el origen de CloudFront),
# así que LA APP DEBE verificar esa cabecera y rechazar con 403 las peticiones sin ella.

locals {
  origin_verify_header = "X-Qapaq-Origin-Verify"

  placeholder_api = <<-JS
    exports.handler = async () => ({
      statusCode: 503,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
      body: JSON.stringify({ error: "not_deployed", message: "QAPAQ API aun no desplegada" }),
    });
  JS

  placeholder_worker = <<-JS
    // Placeholder: marca todos los mensajes como fallidos para que SQS los reintente y,
    // tras maxReceiveCount, los mueva a la DLQ. No se pierde ningún evento.
    exports.handler = async (event) => ({
      batchItemFailures: (event.Records || []).map((r) => ({ itemIdentifier: r.messageId })),
    });
  JS

  placeholder_respond = <<-JS
    exports.handler = async () => {
      const err = new Error("Ankay aun no desplegado");
      err.name = "NotDeployed";
      throw err;
    };
  JS

  lambda_vpc = {
    subnet_ids         = aws_subnet.private[*].id
    security_group_ids = [aws_security_group.lambda.id]
  }

  config_param_arn = "arn:${local.partition}:ssm:${local.region}:${local.account_id}:parameter${local.ssm_prefix}/*"

  common_lambda_env = {
    QAPAQ_ENVIRONMENT     = var.environment
    QAPAQ_CONFIG_SSM_PATH = "${local.ssm_prefix}/"
  }

  common_lambda_statements = [
    {
      sid        = "ReadConfig"
      effect     = "Allow"
      actions    = ["ssm:GetParametersByPath", "ssm:GetParameter", "ssm:GetParameters"]
      resources  = [local.config_param_arn]
      conditions = []
    },
    {
      sid        = "DataKey"
      effect     = "Allow"
      actions    = ["kms:Decrypt", "kms:GenerateDataKey"]
      resources  = [aws_kms_key.data.arn]
      conditions = []
    },
    {
      sid        = "AuditWrite"
      effect     = "Allow"
      actions    = ["s3:PutObject", "s3:GetObject", "s3:PutObjectRetention"]
      resources  = ["${module.bucket_audit.arn}/*"]
      conditions = []
    },
    {
      sid        = "AuditKey"
      effect     = "Allow"
      actions    = ["kms:GenerateDataKey", "kms:Decrypt"]
      resources  = [aws_kms_key.audit.arn]
      conditions = []
    },
  ]

  db_connect_arn = "arn:${local.partition}:rds-db:${local.region}:${local.account_id}:dbuser:${aws_rds_cluster.main.cluster_resource_id}/qapaq_app"
}

# ---------------------------------------------------------------------------
# Lambda api
# ---------------------------------------------------------------------------
module "lambda_api" {
  source = "./modules/lambda_function"

  function_name        = "${local.name}-api"
  description          = "QAPAQ API (BFF + dominio)"
  memory_size          = local.lambda_memory.api
  timeout              = local.lambda_timeout.api
  kms_key_arn          = aws_kms_key.data.arn
  log_retention_days   = var.log_retention_days
  vpc_config           = local.lambda_vpc
  reserved_concurrency = var.api_reserved_concurrency
  inline_source        = { filename = "index.js", content = local.placeholder_api }
  s3_artifact          = var.api_artifact == null ? null : { bucket = var.api_artifact.bucket, key = "${trimsuffix(var.api_artifact.key, ".zip")}-api.zip" }

  environment = merge(local.common_lambda_env, local.qapaqzito_env)

  policy_statements = concat(local.common_lambda_statements, local.qapaqzito_statements, [
    {
      sid     = "Secrets"
      effect  = "Allow"
      actions = ["secretsmanager:GetSecretValue"]
      resources = [
        aws_rds_cluster.main.master_user_secret[0].secret_arn,
        aws_secretsmanager_secret.cognito_client.arn,
        aws_secretsmanager_secret.origin_verify.arn,
        aws_secretsmanager_secret.wazuh_admin.arn,
      ]
      conditions = []
    },
    {
      sid        = "DbIamAuth"
      effect     = "Allow"
      actions    = ["rds-db:connect"]
      resources  = [local.db_connect_arn]
      conditions = []
    },
    {
      sid        = "RespondStart"
      effect     = "Allow"
      actions    = ["states:StartExecution", "states:SendTaskSuccess", "states:SendTaskFailure", "states:SendTaskHeartbeat"]
      resources  = [aws_sfn_state_machine.respond.arn]
      conditions = []
    },
    {
      sid        = "RespondDescribe"
      effect     = "Allow"
      actions    = ["states:DescribeExecution", "states:StopExecution"]
      resources  = ["arn:${local.partition}:states:${local.region}:${local.account_id}:execution:${local.name}-respond:*"]
      conditions = []
    },
    {
      sid        = "Ingest"
      effect     = "Allow"
      actions    = ["sqs:SendMessage"]
      resources  = [aws_sqs_queue.ingest.arn]
      conditions = []
    },
    {
      sid        = "Events"
      effect     = "Allow"
      actions    = ["events:PutEvents"]
      resources  = [aws_cloudwatch_event_bus.security.arn]
      conditions = []
    },
    {
      sid        = "CognitoAdmin"
      effect     = "Allow"
      actions    = ["cognito-idp:AdminGetUser", "cognito-idp:AdminListGroupsForUser", "cognito-idp:AdminUserGlobalSignOut"]
      resources  = [aws_cognito_user_pool.main.arn]
      conditions = []
    },
  ])

  depends_on = [aws_vpc_endpoint.interface]
}

# ---------------------------------------------------------------------------
# Lambda worker (consumidor SQS + reconciliación programada)
# ---------------------------------------------------------------------------
module "lambda_worker" {
  source = "./modules/lambda_function"

  function_name      = "${local.name}-worker"
  description        = "QAPAQ worker: ingesta SQS y reconciliación"
  memory_size        = local.lambda_memory.worker
  timeout            = local.lambda_timeout.worker
  kms_key_arn        = aws_kms_key.data.arn
  log_retention_days = var.log_retention_days
  vpc_config         = local.lambda_vpc
  inline_source      = { filename = "index.js", content = local.placeholder_worker }
  s3_artifact        = var.api_artifact == null ? null : { bucket = var.api_artifact.bucket, key = "${trimsuffix(var.api_artifact.key, ".zip")}-worker.zip" }

  environment = local.common_lambda_env

  policy_statements = concat(local.common_lambda_statements, [
    {
      sid        = "Queue"
      effect     = "Allow"
      actions    = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:ChangeMessageVisibility"]
      resources  = [aws_sqs_queue.ingest.arn]
      conditions = []
    },
    {
      sid        = "Secrets"
      effect     = "Allow"
      actions    = ["secretsmanager:GetSecretValue"]
      resources  = [aws_rds_cluster.main.master_user_secret[0].secret_arn, aws_secretsmanager_secret.wazuh_admin.arn]
      conditions = []
    },
    {
      sid        = "DbIamAuth"
      effect     = "Allow"
      actions    = ["rds-db:connect"]
      resources  = [local.db_connect_arn]
      conditions = []
    },
    {
      sid        = "RespondStart"
      effect     = "Allow"
      actions    = ["states:StartExecution"]
      resources  = [aws_sfn_state_machine.respond.arn]
      conditions = []
    },
  ])

  depends_on = [aws_vpc_endpoint.interface]
}

# ---------------------------------------------------------------------------
# Lambda respond (pasos de la máquina de estados Ankay)
# ---------------------------------------------------------------------------
module "lambda_respond" {
  source = "./modules/lambda_function"

  function_name      = "${local.name}-respond"
  description        = "Ankay: validar, solicitar aprobación, ejecutar y auditar"
  memory_size        = local.lambda_memory.respond
  timeout            = local.lambda_timeout.respond
  kms_key_arn        = aws_kms_key.data.arn
  log_retention_days = var.log_retention_days
  vpc_config         = local.lambda_vpc
  inline_source      = { filename = "index.js", content = local.placeholder_respond }
  s3_artifact        = var.api_artifact == null ? null : { bucket = var.api_artifact.bucket, key = "${trimsuffix(var.api_artifact.key, ".zip")}-respond.zip" }

  environment = local.common_lambda_env

  policy_statements = concat(local.common_lambda_statements, [
    {
      sid        = "Secrets"
      effect     = "Allow"
      actions    = ["secretsmanager:GetSecretValue"]
      resources  = [aws_secretsmanager_secret.wazuh_admin.arn]
      conditions = []
    },
    {
      sid        = "Approvals"
      effect     = "Allow"
      actions    = ["sns:Publish"]
      resources  = [aws_sns_topic.approvals.arn]
      conditions = []
    },
  ])

  depends_on = [aws_vpc_endpoint.interface]
}

# ---------------------------------------------------------------------------
# Cabecera secreta de origen
# ---------------------------------------------------------------------------
resource "random_password" "origin_verify" {
  length  = 48
  special = false
}

resource "aws_secretsmanager_secret" "origin_verify" {
  name                    = "${local.ssm_prefix}/edge/origin-verify"
  description             = "Valor de la cabecera ${local.origin_verify_header} que CloudFront envía al origen"
  kms_key_id              = aws_kms_key.data.arn
  recovery_window_in_days = local.is_prod ? 30 : 0
}

resource "aws_secretsmanager_secret_version" "origin_verify" {
  secret_id     = aws_secretsmanager_secret.origin_verify.id
  secret_string = random_password.origin_verify.result
}

# ---------------------------------------------------------------------------
# API Gateway HTTP API
# ---------------------------------------------------------------------------
resource "aws_cloudwatch_log_group" "api_access" {
  name              = "/aws/apigateway/${local.name}-http"
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.data.arn
}

resource "aws_apigatewayv2_api" "http" {
  name                         = "${local.name}-http"
  protocol_type                = "HTTP"
  description                  = "QAPAQ API (origen de CloudFront)"
  disable_execute_api_endpoint = false
}

resource "aws_apigatewayv2_integration" "api" {
  api_id                 = aws_apigatewayv2_api.http.id
  integration_type       = "AWS_PROXY"
  integration_uri        = module.lambda_api.invoke_arn
  payload_format_version = "2.0"
  timeout_milliseconds   = 29000
}

resource "aws_apigatewayv2_route" "default" {
  api_id    = aws_apigatewayv2_api.http.id
  route_key = "$default"
  target    = "integrations/${aws_apigatewayv2_integration.api.id}"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.http.id
  name        = "$default"
  auto_deploy = true

  default_route_settings {
    throttling_burst_limit = var.api_throttle.burst_limit
    throttling_rate_limit  = var.api_throttle.rate_limit
  }

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.api_access.arn
    format = jsonencode({
      requestId      = "$context.requestId"
      ip             = "$context.identity.sourceIp"
      requestTime    = "$context.requestTime"
      httpMethod     = "$context.httpMethod"
      path           = "$context.path"
      status         = "$context.status"
      responseLength = "$context.responseLength"
      latency        = "$context.responseLatency"
      integrationErr = "$context.integrationErrorMessage"
      userAgent      = "$context.identity.userAgent"
    })
  }
}

resource "aws_lambda_permission" "api_gateway" {
  statement_id  = "AllowHttpApiInvoke"
  action        = "lambda:InvokeFunction"
  function_name = module.lambda_api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.http.execution_arn}/*/*"
}
