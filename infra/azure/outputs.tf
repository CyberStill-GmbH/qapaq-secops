output "resource_group_name" {
  description = "Resource group Azure de este stack independiente."
  value       = data.azurerm_resource_group.this.name
}

output "container_registry_login_server" {
  description = "ACR para imágenes OCI verificadas."
  value       = module.identity_registry.container_registry_login_server
}

output "github_publisher_client_id" {
  description = "Client ID de la identidad federada que GitHub Actions usará para AcrPush."
  value       = module.identity_registry.github_publisher_client_id
}

output "runtime_identity_client_id" {
  description = "Client ID de la identidad administrada del runtime."
  value       = module.identity_registry.runtime_identity_client_id
}

output "postgres_fqdn" {
  description = "FQDN privado de PostgreSQL Flexible Server."
  value       = module.data.postgres_fqdn
}

output "raw_storage_account_name" {
  description = "Storage Account privado destinado a objetos raw/evidencia."
  value       = module.data.storage_account_name
}

output "container_app_environment_default_domain" {
  description = "Sufijo interno de service discovery de Container Apps."
  value       = try(module.observability.container_app_environment_default_domain, null)
}

output "edge_default_fqdn" {
  description = "FQDN temporal administrado por Azure para el edge, si enable_runtime=true. DNS custom queda fuera de este stack."
  value       = module.runtime.edge_default_fqdn
}

output "siem_private_ip" {
  description = "IP privada del SIEM QAPAQ cuando se habilita el host. null mientras falten las gates de release y red."
  value       = try(module.siem_host[0].private_ip_address, null)
}

output "siem_firewall_public_ip" {
  description = "IP pública estable del Firewall Standard: egress y DNAT de entrada al Load Balancer privado del SIEM cuando su perfil esté habilitado. El DNS sigue manual."
  value       = try(module.egress_firewall[0].public_ip_address, null)
}

output "ankay_private_ip" {
  description = "IP privada del host Ankay preparado cuando se habilita `ankay_host`; null por defecto."
  value       = try(module.ankay_host[0].private_ip_address, null)
}

output "ankay_runtime_status" {
  description = "Estado informativo del host Ankay; el módulo prepara VM/disco pero no instala ni inicia Shuffle."
  value       = try(module.ankay_host[0].runtime_status, null)
}
