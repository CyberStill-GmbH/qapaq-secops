output "private_ip_address" {
  description = "IP privada del host para que el edge protegido publique /ankay/ después de la prueba de sesión."
  value       = azurerm_network_interface.ankay.private_ip_address
}

output "network_security_group_id" {
  value = azurerm_network_security_group.ankay.id
}

output "route_table_id" {
  description = "UDR propia de la subnet dedicada, con 0/0 forzado al firewall."
  value       = azurerm_route_table.ankay.id
}

output "managed_disk_id" {
  description = "Disco independiente con prevent_destroy para las definiciones/datos de Ankay."
  value       = azurerm_managed_disk.ankay_data.id
}

output "runtime_status" {
  description = "El módulo solo prepara host y disco; no afirma que Ankay haya arrancado o esté operativo."
  value       = "host_prepared_runtime_not_started"
}
