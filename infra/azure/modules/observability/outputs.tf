output "container_app_environment_id" {
  description = "ID del Container Apps Environment; null con enable_runtime = false."
  value       = try(azurerm_container_app_environment.this[0].id, null)
}

output "container_app_environment_default_domain" {
  description = "Dominio interno de service discovery de Container Apps; null con enable_runtime = false."
  value       = try(azurerm_container_app_environment.this[0].default_domain, null)
}

output "log_analytics_workspace_id" {
  description = "Workspace central de logs de plataforma y auditoría."
  value       = azurerm_log_analytics_workspace.this.id
}
