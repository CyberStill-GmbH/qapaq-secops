output "postgres_fqdn" { value = azurerm_postgresql_flexible_server.this.fqdn }
output "app_database_name" { value = azurerm_postgresql_flexible_server_database.app.name }
output "queue_database_name" { value = azurerm_postgresql_flexible_server_database.queue.name }
output "storage_account_id" { value = azurerm_storage_account.evidence.id }
output "storage_account_name" { value = azurerm_storage_account.evidence.name }
output "key_vault_id" { value = azurerm_key_vault.this.id }
output "key_vault_name" { value = azurerm_key_vault.this.name }
