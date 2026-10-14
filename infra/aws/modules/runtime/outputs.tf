output "cluster_name" {
  value = aws_ecs_cluster.this.name
}

output "load_balancer_dns_name" {
  description = "ALB origin hostname; HTTP is restricted to the public proxy when ACM HTTPS is disabled."
  value       = aws_lb.this.dns_name
}

output "load_balancer_arn" {
  value = aws_lb.this.arn
}

output "load_balancer_zone_id" {
  description = "Canonical Route 53 hosted zone ID of the public ALB, used for alias records."
  value       = aws_lb.this.zone_id
}

output "private_api_hostname" {
  value = "api.${aws_service_discovery_private_dns_namespace.this.name}"
}

output "execution_role_arn" {
  value = aws_iam_role.execution.arn
}

output "task_role_arns" {
  value = { for service, role in aws_iam_role.task : service => role.arn }
}

output "nat_gateway_id" {
  value = aws_nat_gateway.api_egress.id
}

# Núcleo QAPAQ dentro del SIEM (docs/12, opción B): mismo entorno de dominio que la API de ECS, pero
# escuchando solo en 127.0.0.1 detrás del edge nginx del host, que pasa a ser un proxy confiable.
output "core_environment" {
  value = merge(local.api_environment, {
    QAPAQ_API_HOST = "127.0.0.1"
    QAPAQ_ACCESS_TRUSTED_PROXY_CIDRS = join(",", compact([
      lookup(local.api_environment, "QAPAQ_ACCESS_TRUSTED_PROXY_CIDRS", ""),
      "127.0.0.1/32",
    ]))
  })
}

output "core_secrets" {
  description = "Nombre de variable → ARN (con sufijo :clave:: como en ECS). Solo referencias, sin valores."
  value       = { for secret in local.api_secrets : secret.name => secret.valueFrom }
}

output "core_secret_arns" {
  value = local.api_secret_arns
}
