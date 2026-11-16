output "app_url" {
  description = "URL pública de la app (CloudFront)."
  value       = local.app_base_url
}

output "cloudfront_domain_name" {
  value = aws_cloudfront_distribution.main.domain_name
}

output "http_api_endpoint" {
  description = "Endpoint execute-api (origen de CloudFront; la app debe exigir la cabecera de origen)."
  value       = aws_apigatewayv2_api.http.api_endpoint
}

output "config_ssm_path" {
  description = "Ruta base de la configuración de la app en SSM Parameter Store."
  value       = "${local.ssm_prefix}/"
}

output "cognito" {
  value = {
    user_pool_id = aws_cognito_user_pool.main.id
    client_id    = aws_cognito_user_pool_client.bff.id
    domain       = "${aws_cognito_user_pool_domain.main.domain}.auth.${local.region}.amazoncognito.com"
  }
}

output "aurora" {
  value = {
    endpoint          = aws_rds_cluster.main.endpoint
    reader_endpoint   = aws_rds_cluster.main.reader_endpoint
    master_secret_arn = aws_rds_cluster.main.master_user_secret[0].secret_arn
  }
}

output "lambda_functions" {
  value = {
    api        = module.lambda_api.function_name
    worker     = module.lambda_worker.function_name
    respond    = module.lambda_respond.function_name
    onboarding = module.lambda_agent_onboarding.function_name
  }
}

output "respond_state_machine_arn" {
  value = aws_sfn_state_machine.respond.arn
}

output "buckets" {
  value = {
    audit           = module.bucket_audit.id
    wazuh_snapshots = module.bucket_wazuh_snapshots.id
    logs            = module.bucket_logs.id
    artifacts       = module.bucket_artifacts.id
  }
}

output "wazuh" {
  description = "Nodo Wazuh. Dashboard en https://<public_ip>/ solo desde allowed_admin_cidrs."
  value = {
    instance_id         = aws_instance.wazuh.id
    public_ip           = aws_eip.wazuh.public_ip
    private_ip          = aws_instance.wazuh.private_ip
    dashboard_url       = "https://${aws_eip.wazuh.public_ip}/"
    admin_secret_arn    = aws_secretsmanager_secret.wazuh_admin.arn
    registration_secret = aws_secretsmanager_secret.agent_registration.arn
    session_command     = "aws ssm start-session --target ${aws_instance.wazuh.id} --region ${local.region}"
  }
}

output "agents" {
  value = {
    ssm_document          = aws_ssm_document.install_agent.name
    association_id        = aws_ssm_association.install_agent.association_id
    enable_tag            = "${local.agent_tag_key}=enabled"
    group_tag_key         = local.agent_group_tag_key
    baseline_profile_name = aws_iam_instance_profile.agent_baseline.name
    enroll_policy_arn     = aws_iam_policy.agent_enroll.arn
    manager_address       = local.agent_manager
  }
}

output "hybrid_activation" {
  description = "Activación SSM para endpoints fuera de AWS (null si hybrid_activation_limit = 0)."
  sensitive   = true
  value = var.hybrid_activation_limit > 0 ? {
    id      = aws_ssm_activation.agents[0].id
    code    = aws_ssm_activation.agents[0].activation_code
    expires = time_offset.hybrid_activation_expiry[0].rfc3339
    region  = local.region
  } : null
}

output "hybrid_install_script_linux" {
  description = "Script de ejemplo para registrar un servidor Linux on-premises en SSM (luego la asociación instala el agente)."
  sensitive   = true
  value = var.hybrid_activation_limit > 0 ? join("\n", [
    "#!/bin/bash",
    "# Ejecutar como root en el servidor. Requiere salida HTTPS a los endpoints de SSM de ${local.region}",
    "# y TCP 1514/1515 hacia ${aws_eip.wazuh.public_ip} (su IP pública debe estar en agent_cidrs).",
    "set -euo pipefail",
    "curl -fsSLo /tmp/ssm-setup-cli https://amazon-ssm-${local.region}.s3.${local.region}.amazonaws.com/latest/linux_amd64/ssm-setup-cli",
    "chmod +x /tmp/ssm-setup-cli",
    "/tmp/ssm-setup-cli -register -activation-code '${aws_ssm_activation.agents[0].activation_code}' -activation-id '${aws_ssm_activation.agents[0].id}' -region '${local.region}'",
    "# El nodo queda con el tag ${local.agent_tag_key}=hybrid y la asociación híbrida instala el agente",
    "# apuntando a ${aws_eip.wazuh.public_ip}. Si el tag no se hereda, añadirlo con:",
    "# aws ssm add-tags-to-resource --resource-type ManagedInstance --resource-id <mi-id> --tags Key=${local.agent_tag_key},Value=hybrid",
  ]) : null
}

output "agent_registration_password" {
  description = "Contraseña de registro de agentes (para instalación manual). Preferir leerla de Secrets Manager."
  sensitive   = true
  value       = random_password.agent_registration.result
}

output "github_deploy_role_arn" {
  value = local.github_enabled ? aws_iam_role.github_deploy[0].arn : null
}

output "alerts_topic_arn" {
  value = aws_sns_topic.alerts.arn
}
