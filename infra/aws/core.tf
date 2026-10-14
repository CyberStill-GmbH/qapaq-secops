# Núcleo QAPAQ como componente del SIEM QAPAQ (docs/12, opción B). Corre en el host Wazuh junto al
# dashboard (wazuh/core): API en 127.0.0.1:3000 y worker de colas. Persistencia sin cambios: RDS, S3 y
# Valkey. wazuh/core/apply-core.sh lee este parámetro y los secretos con el rol de la instancia.

resource "aws_ssm_parameter" "core_environment" {
  name        = "/${var.project}/${var.environment}/core/environment"
  description = "Entorno del núcleo QAPAQ en el SIEM: variables no secretas y referencias ARN a secretos (sin valores)."
  type        = "String"
  tier        = "Advanced"
  value = jsonencode({
    environment = module.runtime.core_environment
    secrets     = module.runtime.core_secrets
  })
}

resource "aws_iam_role_policy" "wazuh_core_runtime" {
  name = "${var.project}-${var.environment}-core-runtime"
  role = module.wazuh_public.instance_role_name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ReadCoreEnvironment"
        Effect   = "Allow"
        Action   = ["ssm:GetParameter"]
        Resource = [aws_ssm_parameter.core_environment.arn]
      },
      {
        # Solo lectura: el núcleo no crea ni rota secretos (A20).
        Sid      = "ReadCoreSecrets"
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = distinct(module.runtime.core_secret_arns)
      },
    ]
  })
}

# Red: el host del SIEM llega a Postgres, Valkey y KrakenD (lectura del Indexer) por la VPC.
locals {
  core_targets = {
    postgres = { sg = module.security.security_group_ids.postgres, port = var.postgres_port }
    redis    = { sg = module.security.security_group_ids.redis, port = var.redis_port }
    krakend  = { sg = module.security.security_group_ids.krakend, port = var.krakend_port }
  }
}

resource "aws_vpc_security_group_egress_rule" "wazuh_core_out" {
  for_each                     = local.core_targets
  security_group_id            = module.security.security_group_ids.wazuh
  referenced_security_group_id = each.value.sg
  description                  = "Núcleo QAPAQ en el SIEM hacia ${each.key}."
  from_port                    = each.value.port
  ip_protocol                  = "tcp"
  to_port                      = each.value.port
}

resource "aws_vpc_security_group_ingress_rule" "core_in_from_wazuh" {
  for_each                     = local.core_targets
  security_group_id            = each.value.sg
  referenced_security_group_id = module.security.security_group_ids.wazuh
  description                  = "${each.key} desde el núcleo QAPAQ en el SIEM."
  from_port                    = each.value.port
  ip_protocol                  = "tcp"
  to_port                      = each.value.port
}

output "core_environment_parameter" {
  description = "Parámetro SSM que consume wazuh/core/apply-core.sh (QAPAQ_CORE_ENV_PARAM)."
  value       = aws_ssm_parameter.core_environment.name
}
