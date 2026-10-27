output "postgres_fqdn" {
  description = "FQDN privado de PostgreSQL Flexible Server."
  value       = azurerm_postgresql_flexible_server.this.fqdn
}

output "app_database_name" {
  description = "Base de datos de la aplicación SOC."
  value       = azurerm_postgresql_flexible_server_database.app.name
}

output "queue_database_name" {
  description = "Base reservada para estado de jobs; no implica una cola activa."
  value       = azurerm_postgresql_flexible_server_database.queue.name
}

output "storage_account_id" {
  description = "ID del Storage Account privado de evidencia."
  value       = azurerm_storage_account.evidence.id
}

output "storage_account_name" {
  description = "Nombre del Storage Account privado de evidencia."
  value       = azurerm_storage_account.evidence.name
}

output "raw_container_id" {
  description = "ID del contenedor security-event-raw; alcance RBAC de escritura del runtime."
  value       = azurerm_storage_container.raw.id
}

output "raw_container_name" {
  description = "Nombre del contenedor de eventos raw."
  value       = azurerm_storage_container.raw.name
}

output "siem_release_container_id" {
  description = "ID del contenedor siem-release en la cuenta dedicada de artefactos."
  value       = azurerm_storage_container.siem_release_public.id
}

output "siem_release_container_name" {
  description = "Nombre del contenedor de artefactos de release."
  value       = azurerm_storage_container.siem_release_public.name
}

output "siem_release_storage_account_id" {
  description = "ID del Storage Account dedicado a artefactos de release."
  value       = azurerm_storage_account.siem_release.id
}

output "siem_release_storage_account_name" {
  description = "Nombre del Storage Account dedicado a artefactos de release."
  value       = azurerm_storage_account.siem_release.name
}

output "legacy_siem_release_container_id" {
  description = "Contenedor siem-release heredado en la cuenta de evidencia; se conserva sin uso nuevo."
  value       = azurerm_storage_container.siem_release.id
}

output "key_vault_id" {
  description = "ID del Key Vault con RBAC y acceso público deshabilitado."
  value       = azurerm_key_vault.this.id
}

output "key_vault_name" {
  description = "Nombre del Key Vault."
  value       = azurerm_key_vault.this.name
}

output "key_vault_uri" {
  description = "URI del plano de datos del Key Vault."
  value       = azurerm_key_vault.this.vault_uri
}

output "key_vault_private_ip" {
  description = "IP privada del Private Endpoint del Key Vault."
  value       = azurerm_private_endpoint.key_vault.private_service_connection[0].private_ip_address
}
