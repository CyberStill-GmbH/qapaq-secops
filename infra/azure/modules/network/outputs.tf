output "container_apps_subnet_id" {
  description = "Subnet /27 delegada a Microsoft.App/environments para el runtime genérico."
  value       = azurerm_subnet.container_apps.id
}

output "postgres_subnet_id" {
  description = "Subnet delegada a PostgreSQL Flexible Server."
  value       = azurerm_subnet.postgres.id
}

output "private_endpoints_subnet_id" {
  description = "Subnet de Private Endpoints (Key Vault y Blob)."
  value       = azurerm_subnet.private_endpoints.id
}

output "ankay_subnet_id" {
  description = "Subnet de Ankay; null si el host está deshabilitado."
  value       = try(azurerm_subnet.ankay[0].id, null)
}

output "krakend_subnet_id" {
  description = "Subnet del ACA privado de KrakenD; null si está deshabilitado."
  value       = try(azurerm_subnet.krakend[0].id, null)
}

output "postgres_private_dns_zone_id" {
  description = "Zona DNS privada de PostgreSQL."
  value       = azurerm_private_dns_zone.postgres.id
}

output "key_vault_private_dns_zone_id" {
  description = "Zona privatelink.vaultcore.azure.net."
  value       = azurerm_private_dns_zone.key_vault.id
}

output "blob_private_dns_zone_id" {
  description = "Zona privatelink.blob.core.windows.net."
  value       = azurerm_private_dns_zone.blob.id
}

output "virtual_network_id" {
  description = "ID de la VNet del entorno."
  value       = azurerm_virtual_network.this.id
}

output "virtual_network_name" {
  description = "Nombre de la VNet del entorno."
  value       = azurerm_virtual_network.this.name
}

output "firewall_subnet_id" {
  description = "AzureFirewallSubnet; null si el host SIEM está deshabilitado."
  value       = try(azurerm_subnet.firewall[0].id, null)
}
