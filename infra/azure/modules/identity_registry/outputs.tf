output "runtime_identity_id" {
  description = "ID de la identidad administrada del runtime de Container Apps."
  value       = azurerm_user_assigned_identity.runtime.id
}

output "runtime_identity_client_id" {
  description = "Client ID de la identidad administrada del runtime."
  value       = azurerm_user_assigned_identity.runtime.client_id
}

output "github_publisher_client_id" {
  description = "Client ID que GitHub Actions usa por OIDC para AcrPush y publicación de releases."
  value       = azurerm_user_assigned_identity.github_publisher.client_id
}

output "container_registry_login_server" {
  description = "Login server del ACR."
  value       = azurerm_container_registry.this.login_server
}

output "container_registry_id" {
  description = "ID del ACR; alcance de las asignaciones AcrPull."
  value       = azurerm_container_registry.this.id
}
