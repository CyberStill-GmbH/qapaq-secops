output "runtime_identity_id" { value = azurerm_user_assigned_identity.runtime.id }
output "runtime_identity_client_id" { value = azurerm_user_assigned_identity.runtime.client_id }
output "github_publisher_client_id" { value = azurerm_user_assigned_identity.github_publisher.client_id }
output "container_registry_login_server" { value = azurerm_container_registry.this.login_server }
