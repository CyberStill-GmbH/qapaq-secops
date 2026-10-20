output "container_apps_subnet_id" { value = azurerm_subnet.container_apps.id }
output "postgres_subnet_id" { value = azurerm_subnet.postgres.id }
output "private_endpoints_subnet_id" { value = azurerm_subnet.private_endpoints.id }
output "postgres_private_dns_zone_id" { value = azurerm_private_dns_zone.postgres.id }
output "key_vault_private_dns_zone_id" { value = azurerm_private_dns_zone.key_vault.id }
output "blob_private_dns_zone_id" { value = azurerm_private_dns_zone.blob.id }
output "virtual_network_id" { value = azurerm_virtual_network.this.id }
output "virtual_network_name" { value = azurerm_virtual_network.this.name }
