output "container_app_environment_id" { value = try(azurerm_container_app_environment.this[0].id, null) }
output "container_app_environment_default_domain" { value = try(azurerm_container_app_environment.this[0].default_domain, null) }
output "log_analytics_workspace_id" { value = azurerm_log_analytics_workspace.this.id }
