output "endpoint" {
  description = "Private RDS PostgreSQL endpoint hostname."
  value       = aws_db_instance.this.address
}

output "port" {
  description = "PostgreSQL listener port."
  value       = aws_db_instance.this.port
}

output "database_name" {
  description = "Application database name."
  value       = aws_db_instance.this.db_name
}

output "master_secret_arn" {
  description = "Secrets Manager ARN for the RDS-managed master credential; no secret value is returned."
  value       = aws_db_instance.this.master_user_secret[0].secret_arn
}
