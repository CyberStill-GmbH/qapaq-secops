output "public_ip" {
  description = "Elastic IP for the Wazuh Dashboard and QAPAQ API edge."
  value       = aws_eip.this.public_ip
}

output "dashboard_url" {
  description = "Wazuh Dashboard URL secured by an automatically renewed IP certificate."
  value       = "https://${aws_eip.this.public_ip}/"
}

output "api_url" {
  description = "QAPAQ API URL routed under a path distinct from Wazuh Dashboard APIs."
  value       = "https://${aws_eip.this.public_ip}/qapaq-api"
}

output "admin_secret_arn" {
  description = "Secrets Manager ARN populated with the generated dashboard admin credentials at first boot."
  value       = aws_secretsmanager_secret.admin.arn
}

output "instance_id" {
  value = aws_instance.this.id
}
