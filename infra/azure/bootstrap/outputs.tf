output "state_resource_group_name" {
  description = "Dedicated group that owns only Terraform state infrastructure."
  value       = azurerm_resource_group.state.name
}

output "state_storage_account_name" {
  description = "Storage account name for GitHub Terraform backend variables."
  value       = azurerm_storage_account.state.name
}

output "state_container_name" {
  description = "Private state container."
  value       = azurerm_storage_container.state.name
}

output "state_key" {
  description = "State blob key for infra/azure."
  value       = var.state_key
}

output "demo_resource_group_name" {
  description = "Pre-created resource group consumed by the Azure demo root."
  value       = azurerm_resource_group.demo.name
}

output "github_terraform_client_id" {
  description = "Client ID for AZURE_TERRAFORM_CLIENT_ID; not a client secret."
  value       = azurerm_user_assigned_identity.github_terraform.client_id
}

output "github_terraform_principal_id" {
  description = "Principal ID of the federated Terraform identity."
  value       = azurerm_user_assigned_identity.github_terraform.principal_id
}
