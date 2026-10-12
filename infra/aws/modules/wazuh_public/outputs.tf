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

output "office365_client_secret_arn" {
  description = "Secrets Manager ARN for the Office 365 collection client secret; populated out of band."
  value       = aws_secretsmanager_secret.office365_client_secret.arn
}

output "break_glass_identities_secret_arn" {
  description = "Secrets Manager ARN for the break-glass UPN list consumed by Wazuh rule 100530."
  value       = aws_secretsmanager_secret.break_glass_identities.arn
}
