output "primary_endpoint" {
  description = "Private Valkey primary endpoint; clients must use TLS (rediss://)."
  value       = aws_elasticache_replication_group.this.primary_endpoint_address
}

output "port" {
  description = "Valkey listener port."
  value       = aws_elasticache_replication_group.this.port
}

output "auth_secret_arn" {
  description = "Secrets Manager ARN holding the Valkey AUTH token; no secret value is returned."
  value       = aws_secretsmanager_secret.auth_token.arn
}
