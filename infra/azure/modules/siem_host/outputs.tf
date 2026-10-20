output "vm_id" {
  description = "ID de la VM privada QAPAQ SIEM."
  value       = azurerm_linux_virtual_machine.siem.id
}

output "private_ip_address" {
  description = "IP privada dinámica de la VM; DNS queda fuera del módulo."
  value       = azurerm_network_interface.siem.private_ip_address
}

output "subnet_id" {
  description = "Subnet privada dedicada al host SIEM."
  value       = azurerm_subnet.siem.id
}

output "network_security_group_id" {
  description = "NSG del SIEM; 443 y agentes quedan cerrados cuando no hay CIDR aprobado."
  value       = azurerm_network_security_group.siem.id
}

output "route_table_id" {
  description = "UDR dedicada que fuerza 0/0 por el Azure Firewall existente."
  value       = azurerm_route_table.siem.id
}

output "managed_identity_client_id" {
  description = "Client ID de la identidad administrada asignada a la VM."
  value       = azurerm_user_assigned_identity.siem.client_id
}

output "managed_identity_principal_id" {
  description = "Principal ID de la identidad administrada."
  value       = azurerm_user_assigned_identity.siem.principal_id
}

output "data_disk_id" {
  description = "Disco persistente con prevent_destroy; debe conservarse incluso al retirar la VM."
  value       = azurerm_managed_disk.siem_data.id
}

output "bootstrap_extension_id" {
  description = "ID de la extensión bootstrap; su estado debe revisarse antes de declarar el SIEM operativo."
  value       = azurerm_virtual_machine_extension.siem_bootstrap.id
}
