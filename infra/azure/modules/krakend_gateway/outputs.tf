output "gateway_fqdn" {
  description = "FQDN HTTPS privado de KrakenD dentro de la VNet."
  value       = azurerm_container_app.this.ingress[0].fqdn
}

output "gateway_base_url" {
  description = "URL HTTPS que consume qapaq-core desde la VM SIEM; no apunta a loopback."
  value       = "https://${azurerm_container_app.this.ingress[0].fqdn}"
}

output "environment_static_ip" {
  description = "IP privada del Internal Load Balancer administrado por ACA."
  value       = azurerm_container_app_environment.this.static_ip_address
}

output "managed_identity_principal_id" {
  description = "Identidad del runtime con AcrPull y acceso read-only a los dos secretos Key Vault referenciados."
  value       = azurerm_user_assigned_identity.this.principal_id
}
