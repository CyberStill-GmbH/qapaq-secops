output "client_id" {
  description = "Client ID for the protected azure-demo-eus2 GitHub Environment variable AZURE_EUS2_SECRET_SEEDER_CLIENT_ID."
  value       = azurerm_user_assigned_identity.this.client_id
}
